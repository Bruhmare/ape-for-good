#!/usr/bin/env node
// Check Ape for Good's money path on-chain, independently of the site. Nothing is signed or sent.
//
//   node tools/verify.mjs --all                   every live coin and every published payout
//   node tools/verify.mjs <mint | fundraiser-slug> one coin: its creator on the pump.fun curve, its escrow, its payouts
//   node tools/verify.mjs --mint <any pump mint>   just read who a pump.fun coin pays (no site record needed)
//
// Options: --api <url> (default: the production API) · --rpc <url> (default: Solana's public mainnet RPC)
// Exit code 0 when every check passes, 1 when any fails.
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { PUMP_SDK, OnlinePumpSdk, bondingCurvePda } from '@pump-fun/pump-sdk';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const API = opt('--api', 'https://charity-api-production-d1b7.up.railway.app').replace(/\/+$/, '');
const RPC = opt('--rpc', 'https://api.mainnet-beta.solana.com');
const conn = new Connection(RPC, 'confirmed');
const online = new OnlinePumpSdk(conn);
const FEE_SLACK = 100_000; // lamports: the organizer pays the network fee out of what arrives

let failed = 0, passed = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };
const bad = (m) => { failed++; console.log(`  ✗ ${m}`); };
const note = (m) => console.log(`  · ${m}`);
const sol = (l) => `${(Number(l) / LAMPORTS_PER_SOL).toFixed(4)} SOL`;
const isMint = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
async function get(p) {
  const r = await fetch(`${API}${p}`, { signal: AbortSignal.timeout(30_000) });
  if (r.status === 404) throw new Error(`${p.split('/').pop()} is not on the site`);
  if (!r.ok) throw new Error(`${API}${p} answered ${r.status}`);
  return r.json();
}

/** Who a pump.fun coin pays: the creator stored on its bonding curve (set at launch, never changed). */
async function curveCreator(mint) {
  const info = await conn.getAccountInfo(bondingCurvePda(new PublicKey(mint)), 'confirmed');
  if (!info) return null;
  const c = PUMP_SDK.decodeBondingCurve(info);
  return { creator: new PublicKey(c.creator).toBase58(), complete: Boolean(c.complete) };
}

/** Every transaction in which `address` lost lamports: [{ signature, lost, slot }]. */
async function outgoing(address) {
  const key = new PublicKey(address);
  const sigs = await conn.getSignaturesForAddress(key, { limit: 1000 }, 'confirmed');
  const out = [];
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    if (!tx) continue;
    const i = tx.transaction.message.staticAccountKeys.findIndex((k) => k.equals(key));
    const lost = i >= 0 ? tx.meta.preBalances[i] - tx.meta.postBalances[i] : 0;
    if (lost > 0) out.push({ signature: s.signature, lost, slot: s.slot });
  }
  return out;
}

async function checkPayout(l, escrowAddress) {
  const tx = await conn.getTransaction(l.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  if (!tx) return bad(`payout ${l.signature} is not on-chain`);
  if (tx.meta.err) return bad(`payout ${l.signature} failed on-chain`);
  const keys = tx.transaction.message.staticAccountKeys.map((k) => k.toBase58());
  const i = keys.indexOf(l.wallet);
  if (i < 0) return bad(`payout ${l.signature}: the organizer's wallet ${l.wallet} is not in the transaction`);
  const gained = tx.meta.postBalances[i] - tx.meta.preBalances[i];
  const j = escrowAddress ? keys.indexOf(escrowAddress) : -1;
  const lost = j >= 0 ? tx.meta.preBalances[j] - tx.meta.postBalances[j] : null;
  if (Math.abs(gained - Number(l.lamports)) > FEE_SLACK) return bad(`payout ${l.signature}: the ledger says ${sol(l.lamports)} but ${l.wallet} gained ${sol(gained)}`);
  ok(`payout ${sol(l.lamports)} → ${l.wallet} landed${lost != null ? ` (escrow paid out ${sol(lost)})` : ''} · https://solscan.io/tx/${l.signature}`);
}

async function checkCoin(coin, ledger) {
  console.log(`\n${coin.name} ($${coin.symbol}) · ${coin.mint}`);
  note(`fundraiser https://www.gofundme.com/f/${coin.slug} · ${coin.pumpUrl}`);
  const expect = coin.mode === 'open' ? coin.escrow && coin.escrow.address : coin.owner;
  const curve = await curveCreator(coin.mint);
  if (!curve) bad('no bonding curve on-chain for this mint');
  else if (curve.creator === expect) ok(`the creator on-chain is ${coin.mode === 'open' ? "the fundraiser's escrow wallet" : "the organizer's own wallet"}: ${expect}${curve.complete ? ' (graduated; fees now come from the pool)' : ''}`);
  else bad(`the creator on-chain is ${curve.creator}, the site says ${expect}`);
  const mine = ledger.filter((l) => l.slug === coin.slug);
  if (coin.mode === 'open' && expect) {
    const key = new PublicKey(expect);
    const [balance, owed] = await Promise.all([conn.getBalance(key, 'confirmed'), online.getCreatorVaultBalanceBothPrograms(key)]);
    note(`escrow holds ${sol(balance)} + ${sol(owed.toString())} unpaid creator fees · https://solscan.io/account/${expect}`);
    const out = await outgoing(expect);
    const unexplained = out.filter((o) => !mine.some((l) => l.signature === o.signature));
    if (!out.length) ok('nothing has ever left the escrow wallet');
    else if (!unexplained.length) ok(`every transfer out of the escrow wallet (${out.length}) is a published payout`);
    else for (const o of unexplained) bad(`${sol(o.lost)} left the escrow wallet in ${o.signature} and is not on the ledger`);
  }
  if (!mine.length) note('no payouts yet');
  for (const l of mine) await checkPayout(l, expect);
}

async function main() {
  if (args.includes('--mint')) {
    const mint = opt('--mint');
    const c = await curveCreator(mint);
    if (!c) { console.log(`no bonding curve for ${mint}`); process.exitCode = 1; return; }
    console.log(`${mint}\n  creator (who pump.fun pays the creator fee to): ${c.creator}${c.complete ? '\n  graduated' : ''}`);
    return;
  }
  const target = args.find((a) => !a.startsWith('--') && a !== API && a !== RPC);
  if (args.includes('--all')) {
    const [{ coins }, { ledger }] = await Promise.all([get('/api/coins'), get('/api/ledger')]);
    console.log(`${API}: ${coins.length} live coin(s), ${ledger.length} payout(s) on the ledger`);
    for (const c of coins) await checkCoin(c, ledger);
    const orphan = ledger.filter((l) => !coins.some((c) => c.slug === l.slug));
    if (orphan.length) { console.log('\npayouts for fundraisers without a live coin'); for (const l of orphan) await checkPayout(l, null); }
  } else if (target && isMint(target)) {
    const { coin, ledger } = await get(`/api/coins/${target}`);
    await checkCoin(coin, ledger);
  } else if (target) {
    const { coin, ledger, fundraiser } = await get(`/api/fundraisers/${encodeURIComponent(target.toLowerCase())}`);
    if (!coin) { console.log(`${fundraiser.campaign?.title || target}: no coin yet. When one is launched its creator will be this fundraiser's escrow wallet.`); return; }
    await checkCoin(coin, ledger);
  } else {
    console.log('usage: node tools/verify.mjs --all | <mint | fundraiser-slug> | --mint <mint>   [--api url] [--rpc url]');
    process.exitCode = 2;
    return;
  }
  console.log(`\n${passed} check(s) passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
main().catch((e) => { console.error(`error: ${e.message}`); process.exitCode = 1; });
