// Escrow: every fundraiser gets its own wallet, derived from ESCROW_SEED and the fundraiser slug the
// moment it is needed and never stored. A coin anyone launches for a fundraiser names that wallet as
// its pump.fun creator, so the creator fee from every trade accrues in a vault only that wallet can
// collect. Nothing here can move the money except the one transaction built for the organizer who
// proved the fundraiser is theirs. The first time, that transaction also hands the coin's fees to the
// organizer on pump.fun itself (a fee-sharing account with the organizer as the only shareholder,
// which pump.fun locks on that first update), so from then on every fee goes straight to them and
// the escrow key has no say over the coin at all. Every claim is written to the public ledger.
import crypto from 'node:crypto';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { db, commit, escrowSeed, liveCoinForSlug } from './store.js';
import * as pump from './pump.js';
import * as sol from './sol.js';

const bad = (status, message, code) => Object.assign(new Error(message), { status, code });
const MIN_CLAIM = 1_000_000n; // 0.001 SOL: below this a claim costs more than it moves
const LOCK_FLOAT = 10_000_000n; // 0.01 SOL the organizer lends the escrow for the fee-sharing account's rent; the sweep returns what is left

export function escrowKeypair(slug) {
  return Keypair.fromSeed(crypto.createHmac('sha256', escrowSeed()).update(`charity-escrow:${slug}`).digest());
}
export const escrowAddress = (slug) => escrowKeypair(slug).publicKey.toBase58();

export const claimedFor = (slug) => db.ledger.filter((l) => l.slug === slug && l.status === 'done').reduce((a, l) => a + BigInt(l.lamports), 0n);

/** Where a fundraiser's coin pays its fees: { mint, feesLockedTo } once handed to the organizer, else feesLockedTo null. */
async function feeRoute(slug) {
  const coin = liveCoinForSlug(slug);
  if (!coin || coin.mode !== 'open') return { coin: null, config: null };
  const config = await pump.sharingConfig(coin.mint);
  return { coin, config };
}
const lockedTo = (config) => (config && config.adminRevoked && config.shareholders.length === 1 ? config.shareholders[0].address.toBase58() : null);

/** What sits in a fundraiser's escrow right now: the unpaid vault + the wallet, what was paid out, and where the coin's fees go. */
export async function escrowStatus(slug) {
  const key = escrowKeypair(slug).publicKey;
  const [owed, balance, route] = await Promise.all([pump.creatorOwed(key), sol.balanceOf(key), feeRoute(slug)]);
  const to = lockedTo(route.config);
  const owedToOwner = to ? await pump.creatorOwed(pump.sharingConfigAddress(route.coin.mint)) : 0n;
  return { address: key.toBase58(), owedLamports: owed.toString(), balanceLamports: balance.toString(), inEscrowLamports: (owed + balance).toString(), claimedLamports: claimedFor(slug).toString(), feesLockedTo: to, owedToOrganizerLamports: owedToOwner.toString(), at: Date.now() };
}

/** The claim's instructions for `escrow` (the coin's creator) and `owner`, ending with the sweep of everything the escrow holds. */
export async function claimInstructions({ escrow, owner, coin, config }) {
  const to = lockedTo(config);
  if (config && to !== owner.toBase58()) throw bad(409, "this coin's fees are already handed to another wallet on pump.fun", 'locked_elsewhere');
  const lock = Boolean(coin && !config);
  const [owed, balance] = await Promise.all([pump.creatorOwed(escrow), sol.balanceOf(escrow)]);
  const ixs = [];
  if (lock) ixs.push(sol.transferIx(owner, escrow, LOCK_FLOAT));
  if (owed > 0n) ixs.push(...(await pump.collectInstructions(escrow, owner)));
  if (lock) {
    const [curve] = await pump.curves([coin.mint]);
    ixs.push(...(await pump.lockFeesTo({ creator: escrow, mint: coin.mint, owner, graduated: Boolean(curve?.complete) })));
  }
  if (to && (await pump.creatorOwed(pump.sharingConfigAddress(coin.mint))) > 0n) ixs.push(await pump.distributeInstruction(coin.mint, config));
  if (!lock && !ixs.length && balance < MIN_CLAIM) throw bad(400, 'nothing in escrow yet: fees show up as people trade the coin', 'nothing_owed');
  // what the escrow holds once the steps above have run is exactly what goes to the organizer
  const pre = await sol.simulate(owner, ixs.length ? ixs : [sol.transferIx(escrow, owner, 0n)], null, { accounts: [escrow] });
  if (pre.err) throw bad(422, `the chain would refuse that: ${sol.explain(pre)}`, 'simulation');
  const total = BigInt(pre.accounts[0]?.lamports ?? 0);
  if (total > 0n) ixs.push(sol.transferIx(escrow, owner, total));
  const moved = lock ? total - LOCK_FLOAT : total; // net of the rent float the organizer lent
  return { ixs, total, moved: moved > 0n ? moved : 0n, lock };
}

/**
 * The claim for a verified organizer. First time: lend the escrow the rent, collect its vault, hand the coin's fees to
 * the organizer for good (fee-sharing account, organizer 100%, locked by pump.fun), then sweep the whole escrow to them.
 * After that: pay out what the locked coin has earned (pump.fun sends it to the organizer) and sweep anything left.
 */
export async function prepareClaim(slug, owner) {
  const kp = escrowKeypair(slug);
  const { coin, config } = await feeRoute(slug);
  const { ixs, total, moved, lock } = await claimInstructions({ escrow: kp.publicKey, owner, coin, config });
  const sim = await sol.simulate(owner, ixs);
  if (sim.err) throw bad(422, `the chain would refuse that: ${sol.explain(sim)}`, 'simulation');
  const built = await sol.compile(owner, ixs, sol.unitsFor(sim));
  built.tx.sign([kp]);
  const id = crypto.randomBytes(8).toString('hex');
  db.ledger.push({ id, slug, wallet: owner.toBase58(), lamports: moved.toString(), lock, status: 'pending', message: sol.messageB64(built.tx), lastValidBlockHeight: built.lastValidBlockHeight, at: Date.now(), signature: null });
  commit('ledger');
  return { id, transaction: sol.serializeB64(built.tx), lamports: moved.toString(), locksFees: lock, escrow: kp.publicKey.toBase58() };
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
