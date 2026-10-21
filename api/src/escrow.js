// Escrow: every fundraiser gets its own wallet, derived from ESCROW_SEED and the fundraiser slug the
// moment it is needed and never stored. A coin anyone launches for a fundraiser names that wallet as
// its pump.fun creator, so the creator fee from every trade accrues in a vault only that wallet can
// collect. Nothing here can move the money except the one transaction built for the organizer who
// proved the fundraiser is theirs: collect the vault, sweep the whole escrow balance to their wallet.
// Every sweep is written to the public ledger with its signature.
import crypto from 'node:crypto';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { db, commit, escrowSeed, liveCoinForSlug } from './store.js';
import * as pump from './pump.js';
import * as sol from './sol.js';

const bad = (status, message, code) => Object.assign(new Error(message), { status, code });
const MIN_CLAIM = 1_000_000n; // 0.001 SOL: below this a claim costs more than it moves

export function escrowKeypair(slug) {
  return Keypair.fromSeed(crypto.createHmac('sha256', escrowSeed()).update(`charity-escrow:${slug}`).digest());
}
export const escrowAddress = (slug) => escrowKeypair(slug).publicKey.toBase58();

export const claimedFor = (slug) => db.ledger.filter((l) => l.slug === slug && l.status === 'done').reduce((a, l) => a + BigInt(l.lamports), 0n);

/** What sits in a fundraiser's escrow right now: the unpaid vault + the wallet, and what was already paid out. */
export async function escrowStatus(slug) {
  const key = escrowKeypair(slug).publicKey;
  const [owed, balance] = await Promise.all([pump.creatorOwed(key), sol.balanceOf(key)]);
  return { address: key.toBase58(), owedLamports: owed.toString(), balanceLamports: balance.toString(), inEscrowLamports: (owed + balance).toString(), claimedLamports: claimedFor(slug).toString(), at: Date.now() };
}

/** The sweep for a verified organizer: collect the vault (they pay the fee) and move everything to their wallet. */
export async function prepareClaim(slug, owner) {
  const kp = escrowKeypair(slug);
  const [owed, balance] = await Promise.all([pump.creatorOwed(kp.publicKey), sol.balanceOf(kp.publicKey)]);
  const total = owed + balance;
  if (total < MIN_CLAIM) throw bad(400, 'nothing in escrow yet: fees show up as people trade the coin', 'nothing_owed');
  const ixs = owed > 0n ? [...(await pump.collectInstructions(kp.publicKey, owner))] : [];
  ixs.push(sol.transferIx(kp.publicKey, owner, total));
  const sim = await sol.simulate(owner, ixs);
  if (sim.err) throw bad(422, `the chain would refuse that: ${sol.explain(sim)}`, 'simulation');
  const built = await sol.compile(owner, ixs, sol.unitsFor(sim));
  built.tx.sign([kp]);
  const id = crypto.randomBytes(8).toString('hex');
  db.ledger.push({ id, slug, wallet: owner.toBase58(), lamports: total.toString(), status: 'pending', message: sol.messageB64(built.tx), lastValidBlockHeight: built.lastValidBlockHeight, at: Date.now(), signature: null });
  commit('ledger');
  return { id, transaction: sol.serializeB64(built.tx), lamports: total.toString(), escrow: kp.publicKey.toBase58() };
}

export async function submitClaim(body) {
  const rec = db.ledger.find((l) => l.id === String(body.id || '').slice(0, 32) && l.status === 'pending');
  if (!rec) throw bad(404, 'no escrow claim to submit', 'no_claim');
  let tx;
  try { tx = VersionedTransaction.deserialize(Buffer.from(String(body.signedTransaction || ''), 'base64')); } catch { throw bad(400, 'that is not a signed transaction', 'bad_tx'); }
  if (sol.messageB64(tx) !== rec.message) throw bad(400, 'the signed transaction is not the one that was prepared', 'bad_tx');
  if (tx.signatures.some((s) => s.every((b) => b === 0))) throw bad(400, 'the transaction is not fully signed', 'bad_tx');
  const raw = tx.serialize();
  const signature = sol.signatureOf(tx);
  rec.signature = signature;
  commit('ledger');
  await sol.broadcast(raw);
  await sol.confirm(signature, raw, rec.lastValidBlockHeight, { timeoutMs: 90_000 });
  rec.status = 'done';
  rec.doneAt = Date.now();
  delete rec.message;
  commit('ledger');
  const coin = liveCoinForSlug(rec.slug);
  if (coin) refreshEscrows([coin]).catch(() => {});
  return { signature, lamports: rec.lamports };
}

/** Keep each open coin's escrow figures fresh for the pages (one RPC pair per coin). */
export async function refreshEscrows(coins = db.coins.filter((c) => c.status === 'live' && c.mode === 'open')) {
  for (const c of coins) {
    try { c.escrow = await escrowStatus(c.slug); } catch (e) { console.warn(`[escrow] ${c.slug}: ${e.message}`); }
  }
  if (coins.length) commit('coins');
}

export const publicLedger = () => db.ledger.filter((l) => l.status === 'done').sort((a, b) => b.doneAt - a.doneAt).map((l) => ({ slug: l.slug, wallet: l.wallet, lamports: l.lamports, signature: l.signature, at: l.doneAt }));
