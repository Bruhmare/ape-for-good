// Mainnet simulation, no SOL spent: an owner launch (verified claim, owner = creator), an open launch
// (creator = the fundraiser's escrow wallet) and the escrow claim builder. Run: DATA_DIR=./data-sim node test/sim.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { VersionedTransaction } from '@solana/web3.js';
import { CONFIG } from '../src/config.js';
import * as store from '../src/store.js';
import { prepareLaunch, prepareOpenLaunch, feesOf, prepareClaim } from '../src/launch.js';
import * as directory from '../src/directory.js';
import * as escrow from '../src/escrow.js';
import * as sol from '../src/sol.js';

if (!/data-sim/.test(CONFIG.dataDir)) { console.error('run with DATA_DIR=./data-sim'); process.exit(2); }
fs.rmSync(CONFIG.dataDir, { recursive: true, force: true });
store.load();
directory.open();

const PAYER = process.env.SIM_PAYER || 'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM'; // a funded address; it only simulates
const png = fs.readFileSync(path.resolve(CONFIG.root, '../brand/gen/logo-1.png'));
const imageDataUrl = `data:image/png;base64,${png.toString('base64')}`;
const page = (slug) => ({ slug, title: `Ape for Good simulation ${slug}`, summary: 'A dry run.', story: '', raised: { amount: 10, currency: 'USD' }, goal: { amount: 100, currency: 'USD' }, donationCount: 1, image: '', location: '', organizer: '', createdAt: null, active: true });

async function check(label, prep, expectSigned) {
  const tx = VersionedTransaction.deserialize(Buffer.from(prep.transaction, 'base64'));
  const bytes = tx.serialize().length;
  const signed = tx.signatures.map((s) => !s.every((b) => b === 0));
  console.log(label, { mint: prep.mint, mode: prep.mode, creator: prep.creator, feeBps: prep.feeBps, bytes, signed });
  if (bytes > sol.MAX_TX) throw new Error('too large');
  if (JSON.stringify(signed) !== JSON.stringify(expectSigned)) throw new Error(`expected signatures ${JSON.stringify(expectSigned)}`);
  const sim = await sol.simulateTx(tx);
  console.log('  simulation', sim.err ? `ERR ${sol.explain(sim)}` : `ok, ${sim.units} units`);
  if (sim.err) process.exit(1);
}

// owner launch
{
  const slug = 'charity-sim-owner';
  const verifiedAt = Date.now();
  store.db.claims.push({ slug, wallet: PAYER, code: 'APE-SIMU-LATE', startedAt: verifiedAt, verifiedAt, checks: 1, lastCheckAt: verifiedAt, campaign: page(slug) });
  store.commit('claims');
  const claim = `${slug}.${verifiedAt}.${crypto.createHmac('sha256', store.claimSecret()).update(`${slug}|${PAYER}|${verifiedAt}`).digest('hex')}`;
  await check('owner launch', await prepareLaunch({ wallet: PAYER, claim, name: 'Ape for Good sim owner', symbol: 'SIMO', description: 'dry run', imageDataUrl }), [false, true]);
}

// open launch into escrow
{
  const slug = 'charity-sim-open';
  directory.upsertFromPage(page(slug));
  const prep = await prepareOpenLaunch({ wallet: PAYER, slug, name: 'Ape for Good sim open', symbol: 'SIMX', description: '', imageDataUrl }, '127.0.0.1');
  if (prep.creator !== escrow.escrowAddress(slug)) throw new Error('open launch creator must be the escrow wallet');
  await check('open launch', prep, [false, true]);
  try { await prepareOpenLaunch({ wallet: PAYER, slug, name: 'x', symbol: 'SIMX', imageDataUrl: '' }, '127.0.0.1'); throw new Error('open launch without a picture must fail'); } catch (e) { if (e.code !== 'no_image') throw e; console.log('  no fundraiser photo for open coins: ok'); }
  const st = await escrow.escrowStatus(slug);
  console.log('  escrow status', st);
  try { await escrow.prepareClaim(slug, sol.pubkey(PAYER)); throw new Error('claim on an empty escrow must fail'); } catch (e) { if (e.code !== 'nothing_owed') throw e; console.log('  empty escrow claim refused: ok'); }
}

console.log('fees…', await feesOf(PAYER));
try { await prepareClaim({ wallet: PAYER }); console.log('claim builder ok'); } catch (e) { console.log('claim builder:', e.message); }
directory.close();
fs.rmSync(CONFIG.dataDir, { recursive: true, force: true });
console.log('SIM OK');
process.exit(0);
