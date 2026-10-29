// DATA_DIR=./data-test node --test test/money.test.js — the money path, no network: escrow wallets, claim tokens,
// the public ledger, and the invariant that nothing but the organizer's sweep ever signs with an escrow key.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG } from '../src/config.js';
import * as store from '../src/store.js';
import * as escrow from '../src/escrow.js';
import * as sol from '../src/sol.js';
import { verifiedClaim, claimToken } from '../src/launch.js';

if (!/data-test/.test(CONFIG.dataDir)) throw new Error('run with DATA_DIR=./data-test');
fs.rmSync(CONFIG.dataDir, { recursive: true, force: true });
store.load();

const ORGANIZER = 'GyCBRgYYRZ2sb9HAoRER4msNewL7pnkERxJvrof5uuQs';
const SOMEONE_ELSE = 'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM';
const src = (f) => fs.readFileSync(path.resolve(CONFIG.root, 'src', f), 'utf8');

test('escrow wallets: one per fundraiser, derived from the seed and the slug, never stored', () => {
  const a = escrow.escrowAddress('wildfire-relief');
  assert.equal(escrow.escrowAddress('wildfire-relief'), a, 'the same fundraiser gets the same wallet every time');
  assert.notEqual(escrow.escrowAddress('wildfire-relief-2'), a, 'another fundraiser gets another wallet');
  assert.ok(sol.isPubkey(a), 'it is a Solana address');
  if (!CONFIG.escrowSeed) {
    const seed = store.db.state.escrowSeed;
    store.db.state.escrowSeed = crypto.randomBytes(32).toString('hex');
    assert.notEqual(escrow.escrowAddress('wildfire-relief'), a, 'the seed is the only secret: another seed, another wallet');
    store.db.state.escrowSeed = seed;
    assert.equal(escrow.escrowAddress('wildfire-relief'), a);
  }
  for (const f of ['state.json', 'coins.json', 'claims.json', 'ledger.json']) {
    const file = path.join(CONFIG.dataDir, f);
    if (fs.existsSync(file)) assert.ok(!fs.readFileSync(file, 'utf8').includes(a), `${f} never holds an escrow address or key`);
  }
});

test('the escrow key is private to escrow.js: nothing else can sign with it', () => {
  const outside = [];
  for (const f of fs.readdirSync(path.resolve(CONFIG.root, 'src')).filter((n) => n.endsWith('.js') && n !== 'escrow.js')) {
    for (const use of src(f).match(/escrowKeypair\([^)]*\)(\.publicKey)?/g) || []) if (!use.endsWith('.publicKey')) outside.push(`${f}: ${use}`);
  }
  assert.deepEqual(outside, [], 'outside escrow.js the escrow key is only ever asked for its public address');
  const text = src('escrow.js');
  assert.equal((text.match(/\.sign\(\[kp\]\)/g) || []).length, 1, 'exactly one transaction is signed with an escrow key: the organizer sweep in prepareClaim');
  assert.match(text, /sol\.transferIx\(escrow, owner, total\)/, 'and that transaction moves the whole balance to the organizer');
  assert.match(text, /pump\.lockFeesTo\(\{ creator: escrow, mint: coin\.mint, owner,/, "and, on the first claim, hands the coin's fees to the organizer");
  assert.ok(!/escrowSeed\(\)/.test(src('server.js')), 'no route reads the seed');
  assert.ok(!/escrowKeypair|escrowSeed\(\)/.test(src('admin.js')), 'admin cannot derive a key');
});

test('claim tokens: only the wallet that proved ownership, only for CLAIM_TTL_MINUTES', () => {
  const verifiedAt = Date.now() - 1000;
  const claim = { slug: 'wildfire-relief', wallet: ORGANIZER, code: 'APE-TEST-TEST', startedAt: verifiedAt - 5000, verifiedAt, checks: 1, lastCheckAt: verifiedAt, campaign: { slug: 'wildfire-relief', title: 'Wildfire relief' } };
  store.db.claims.push(claim);
  const token = claimToken(claim);
  assert.match(token, /^wildfire-relief\.\d+\.[a-f0-9]{64}$/);
  assert.equal(verifiedClaim(token, sol.pubkey(ORGANIZER)).slug, 'wildfire-relief', 'the organizer can use it');
  assert.throws(() => verifiedClaim(token, sol.pubkey(SOMEONE_ELSE)), /verify your fundraiser first/, 'another wallet cannot');
  const [slug, at, mac] = token.split('.');
  assert.throws(() => verifiedClaim(`${slug}.${Number(at) + 1}.${mac}`, sol.pubkey(ORGANIZER)), /verify your fundraiser first/, 'a changed timestamp fails');
  assert.throws(() => verifiedClaim(`${slug}.${at}.${(mac[0] === 'a' ? 'b' : 'a') + mac.slice(1)}`, sol.pubkey(ORGANIZER)), /verify your fundraiser first/, 'a changed signature fails');
  assert.throws(() => verifiedClaim(`other-fundraiser.${at}.${mac}`, sol.pubkey(ORGANIZER)), /verify your fundraiser first/, 'it is bound to one fundraiser');
  assert.throws(() => verifiedClaim('', sol.pubkey(ORGANIZER)), /verify your fundraiser first/);
  claim.verifiedAt -= (CONFIG.claimTtlMinutes + 1) * 60_000;
  assert.throws(() => verifiedClaim(claimToken(claim), sol.pubkey(ORGANIZER)), /expired/, 'after CLAIM_TTL_MINUTES it is gone');
});

test('the ledger: pending sweeps stay private, finished ones are public with their signature', () => {
  store.db.ledger.length = 0;
  store.db.ledger.push({ id: 'p', slug: 'wildfire-relief', wallet: ORGANIZER, lamports: '5000000', status: 'pending', message: 'AAAA', lastValidBlockHeight: 1, at: 1, signature: null });
  store.db.ledger.push({ id: 'd', slug: 'wildfire-relief', wallet: ORGANIZER, lamports: '3142000000', status: 'done', signature: '5'.repeat(87), at: 1, doneAt: 2 });
  assert.equal(escrow.claimedFor('wildfire-relief'), 3142000000n, 'only what landed on-chain counts as paid');
  const pub = escrow.publicLedger();
  assert.equal(pub.length, 1, 'a sweep that has not landed is not a payout');
  assert.deepEqual(Object.keys(pub[0]).sort(), ['at', 'lamports', 'signature', 'slug', 'wallet'], 'the public entry: who, how much, which transaction, when');
  assert.equal(pub[0].wallet, ORGANIZER);
  fs.rmSync(CONFIG.dataDir, { recursive: true, force: true });
});

test("the first claim hands the coin's fees to the organizer on pump.fun, 100%, through pump.fun's fee program", async () => {
  const pump = await import('../src/pump.js');
  const { PublicKey } = await import('@solana/web3.js');
  const escrowKey = new PublicKey(escrow.escrowAddress('wildfire-relief'));
  const owner = new PublicKey(ORGANIZER);
  const mint = new PublicKey('5xHP2xcXCuU3fWqUW3JptzAqxsDUFuBNkgBKwRxupump');
  const [create, update] = await pump.lockFeesTo({ creator: escrowKey, mint, owner, graduated: false });
  const FEES = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
  assert.equal(create.programId.toBase58(), FEES, "the fee-sharing account is created by pump.fun's fee program");
  assert.equal(update.programId.toBase58(), FEES);
  assert.ok(create.keys.some((k) => k.isSigner && k.pubkey.equals(escrowKey)), "the coin's creator (the escrow) signs and pays its rent");
  assert.ok(update.keys.some((k) => k.isSigner && k.pubkey.equals(escrowKey)), 'and signs the one update that sets the split');
  assert.ok(create.keys.some((k) => k.pubkey.equals(pump.sharingConfigAddress(mint))), "for this coin's own fee-sharing account");
  const text = src('pump.js');
  assert.match(text, /newShareholders: \[\{ address: owner, shareBps: 10_000 \}\]/, 'the organizer is the only shareholder, with all 10,000 bps');
});
