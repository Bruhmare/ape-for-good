// The one Solana connection for the whole server, and the one way a transaction leaves it.
// Lifted from holdmax-api (src/sol.js), itself from promipay-api and told: every transaction
// is simulated first so one that would fail says why in words and costs nothing, the compute
// limit comes from that simulation, a small priority fee rides on every send, v0 transactions,
// and a send is rebroadcast until the cluster confirms it or its blockhash expires.
import { Connection, PublicKey, ComputeBudgetProgram, TransactionMessage, VersionedTransaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { CONFIG } from './config.js';

export const COMMITMENT = 'confirmed';
export const connection = new Connection(CONFIG.rpcUrl, { commitment: COMMITMENT, disableRetryOnRateLimit: false });
export const PRIORITY_MICROLAMPORTS = CONFIG.priorityMicrolamports;
export const BASE_FEE = 5000n; // lamports per signature
export const RENT_FLOOR = 890_880n; // the least lamports an account may hold and still exist
export const MAX_TX = 1232;
export { LAMPORTS_PER_SOL, SystemProgram, PublicKey };

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIG = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bad = (status, message, code) => Object.assign(new Error(message), { status, code });

/** A base58 address as a PublicKey, or null. Case matters on Solana: never lowercase one. */
export function pubkey(v) {
  const s = String(v || '').trim();
  if (!B58.test(s)) return null;
  try {
    return new PublicKey(s);
  } catch {
    return null;
  }
}
export const isPubkey = (v) => pubkey(v) !== null;
export const isSignature = (v) => SIG.test(String(v || '').trim());

/** "0.05" -> 50000000n without floats; null when it does not parse. */
export function parseSol(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^\d+(\.\d{1,9})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole) * 1_000_000_000n + BigInt((frac + '000000000').slice(0, 9));
}

export function lamportsOf(v, what = 'the amount') {
  const n = parseSol(v);
  if (n === null) throw bad(400, `${what} must be in SOL, like 0.05`, 'bad_amount');
  return n;
}

/** Lamports -> a decimal SOL string: 1500000000n -> "1.5", 0n -> "0". */
export function formatSol(lamports) {
  const n = BigInt(lamports);
  const neg = n < 0n;
  const a = neg ? -n : n;
  const whole = a / 1_000_000_000n;
  const frac = (a % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}
export const solOf = (lamports) => Number(BigInt(lamports)) / LAMPORTS_PER_SOL;

/* Program errors worth saying in words. Anything else is passed through as the log line. */
const KNOWN = [
  [/TooMuchSolRequired|slippage|0x1772/i, 'the price moved past the slippage before it landed; try again'],
  [/TooLittleSolReceived|0x1773/i, 'the price moved past the slippage before it landed; try again'],
  [/BondingCurveComplete|0x1775/i, 'this coin has graduated: it trades on its pool now, not on the curve'],
  [/insufficient lamports|insufficient funds|0x1\b/i, 'the wallet does not hold enough SOL for that'],
];

export function explain(sim) {
  const logs = (sim && sim.logs) || [];
  const text = `${logs.join('\n')} ${JSON.stringify(sim && sim.err)}`;
  for (const [re, words] of KNOWN) if (re.test(text)) return words;
  const line = logs.filter((l) => /Error|failed|insufficient/i.test(l)).pop();
  return (line || JSON.stringify(sim && sim.err)).replace(/^Program log: /, '').slice(0, 220);
}

/** A v0 transaction (unsigned) for `payer`: compute budget + priority fee + the instructions. */
export async function compile(payer, instructions, units, recent = null, alts = []) {
  const { blockhash, lastValidBlockHeight } = recent || (await connection.getLatestBlockhash(COMMITMENT));
  const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units })];
  if (PRIORITY_MICROLAMPORTS) budget.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICROLAMPORTS }));
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: budget.concat(instructions) }).compileToV0Message(alts);
  return { tx: new VersionedTransaction(message), blockhash, lastValidBlockHeight };
}

/**
 * What sending would do, without sending: { units, err, logs, accounts, bytes }. `opts.alts` are
 * address lookup tables; `opts.accounts` are addresses whose post-state to return (base64).
 */
export async function simulate(payer, instructions, units, opts = {}) {
  const { tx } = await compile(payer, instructions, units || 1_400_000, null, opts.alts || []);
  return simulateTx(tx, opts.accounts);
}

/** Simulate an already-built transaction (signatures not checked). */
export async function simulateTx(tx, accounts) {
  const config = { sigVerify: false, replaceRecentBlockhash: true, commitment: COMMITMENT };
  if (accounts && accounts.length) config.accounts = { encoding: 'base64', addresses: accounts.map((a) => a.toBase58 ? a.toBase58() : String(a)) };
  const res = await connection.simulateTransaction(tx, config);
  return { units: res.value.unitsConsumed || 0, err: res.value.err, logs: res.value.logs || [], accounts: res.value.accounts || [], bytes: tx.serialize().length };
}

/** Address lookup tables by address (for Jupiter routes). */
export async function lookupTables(addresses) {
  const out = [];
  for (const a of addresses || []) {
    const res = await connection.getAddressLookupTable(new PublicKey(a));
    if (res.value) out.push(res.value);
  }
  return out;
}

/** Compute units to pin after a simulation. */
export const unitsFor = (sim, floor = 0) => Math.min(1_400_000, Math.max(floor, Math.ceil((sim.units || 100_000) * 1.25) + 20_000));

/** The network cost of a transaction with this many signatures and compute units, in lamports. */
export function feeFor(signatures, units) {
  return BASE_FEE * BigInt(signatures) + (BigInt(units) * BigInt(PRIORITY_MICROLAMPORTS)) / 1_000_000n;
}

export const signatureOf = (tx) => bs58.encode(tx.signatures[0]);
export const serializeB64 = (tx) => Buffer.from(tx.serialize()).toString('base64');
export const messageB64 = (tx) => Buffer.from(tx.message.serialize()).toString('base64');

export const broadcast = (raw) => connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });

/**
 * Wait for `signature` to confirm, rebroadcasting `raw` every 1.2 s until it lands, the blockhash
 * expires or `timeoutMs` passes. Resolves { slot }; throws with .status 502 (failed on chain) or
 * 504 (expired, nothing spent).
 */
export async function confirm(signature, raw, lastValidBlockHeight, { timeoutMs = 120_000 } = {}) {
  const started = Date.now();
  for (;;) {
    await sleep(1200);
    const st = (await connection.getSignatureStatuses([signature])).value[0];
    if (st) {
      if (st.err) throw bad(502, `the transaction failed on chain (${signature})`, 'failed');
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return { slot: st.slot };
    }
    const height = await connection.getBlockHeight(COMMITMENT).catch(() => 0);
    if ((lastValidBlockHeight && height > lastValidBlockHeight) || Date.now() - started > timeoutMs) {
      throw bad(504, `the transaction did not land in time and has expired; nothing was spent (${signature})`, 'expired');
    }
    if (raw) broadcast(raw).catch(() => {});
  }
}

/**
 * Simulate, sign, send and confirm. `signers[0]` pays. `opts.units` pins the compute limit;
 * `opts.onSigned(signature, units)` runs before broadcast (persist first, then send).
 * Resolves { signature, slot, units } or throws a readable error.
 */
export async function send(signers, instructions, opts = {}) {
  const payer = signers[0].publicKey;
  const sim = await simulate(payer, instructions, opts.units, { alts: opts.alts });
  if (sim.err) throw bad(422, `the chain would refuse that: ${explain(sim)}`, 'simulation');
  const units = opts.units || unitsFor(sim);
  const { tx, lastValidBlockHeight } = await compile(payer, instructions, units, null, opts.alts || []);
  if (tx.serialize().length > MAX_TX) throw bad(422, 'that transaction is larger than solana allows', 'too_big');
  tx.sign(signers);
  const raw = tx.serialize();
  const signature = signatureOf(tx);
  if (opts.onSigned) await opts.onSigned(signature, units);
  await broadcast(raw);
  const { slot } = await confirm(signature, raw, lastValidBlockHeight, { timeoutMs: opts.timeoutMs });
  return { signature, slot, units, sim };
}

/** 'pending' | 'confirmed' | 'finalized' | 'failed'. An RPC failure throws; it is never read as an answer. */
export async function status(signature) {
  const st = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
  if (!st) return 'pending';
  if (st.err) return 'failed';
  return st.confirmationStatus === 'finalized' ? 'finalized' : st.confirmationStatus === 'confirmed' ? 'confirmed' : 'pending';
}

export async function balanceOf(key) {
  const k = key instanceof PublicKey ? key : pubkey(key);
  if (!k) return 0n;
  return BigInt(await connection.getBalance(k, COMMITMENT));
}

export const transferIx = (from, to, lamports) => SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: BigInt(lamports) });

/** The current slot (for /api/health). */
export const slot = () => connection.getSlot(COMMITMENT);

/** Sign, send and confirm a transaction someone else built (Jupiter's swap), simulating it first. */
export async function sendBuilt(tx, signers, lastValidBlockHeight, opts = {}) {
  const sim = await simulateTx(tx);
  if (sim.err) throw bad(422, `the chain would refuse that: ${explain(sim)}`, 'simulation');
  tx.sign(signers);
  const raw = tx.serialize();
  const signature = signatureOf(tx);
  if (opts.onSigned) await opts.onSigned(signature);
  await broadcast(raw);
  const { slot } = await confirm(signature, raw, lastValidBlockHeight, { timeoutMs: opts.timeoutMs });
  return { signature, slot, units: sim.units };
}

/** A confirmed transaction with its balances (retried a few times while the RPC catches up). */
export async function parsedTx(signature) {
  for (let i = 0; i < 8; i++) {
    const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: COMMITMENT }).catch(() => null);
    if (tx) return tx;
    await sleep(1500);
  }
  return null;
}
