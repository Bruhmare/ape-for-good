// Memory as JSON files under DATA_DIR: state.json (counters, secrets generated once), coins.json
// (every prepared/live coin), claims.json (fundraiser verifications by slug), fees.json (fee claims).
// Kept in memory and flushed with write-to-temp then rename, so a crash mid-write never leaves a
// torn file. Lamport amounts are decimal strings.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG } from './config.js';

const FILES = { state: 'state.json', coins: 'coins.json', claims: 'claims.json', fees: 'fees.json', fundraisers: 'fundraisers.json', comments: 'comments.json', ledger: 'ledger.json' };
const EMPTY = {
  state: { claimSecret: null, escrowSeed: null, solUsd: null, solUsdAt: 0, lastGfmSweepAt: 0 },
  coins: [],
  claims: [],
  fees: [],
  fundraisers: [], // only read once, to migrate the first version's entries into catalog.db
  comments: [],
  ledger: [], // every escrow payout to a verified organizer
};

export const db = structuredClone(EMPTY);
const dirty = new Set();

export function load() {
  fs.mkdirSync(CONFIG.dataDir, { recursive: true });
  fs.mkdirSync(path.join(CONFIG.dataDir, 'u', 'm'), { recursive: true });
  for (const [k, f] of Object.entries(FILES)) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(CONFIG.dataDir, f), 'utf8'));
      db[k] = Array.isArray(EMPTY[k]) ? v : { ...structuredClone(EMPTY[k]), ...v };
    } catch { /* first run */ }
  }
  if (!CONFIG.claimSecret && !db.state.claimSecret) {
    db.state.claimSecret = crypto.randomBytes(32).toString('hex');
    commit('state');
  }
  if (!CONFIG.escrowSeed && !db.state.escrowSeed) {
    db.state.escrowSeed = crypto.randomBytes(32).toString('hex');
    commit('state');
    if (CONFIG.isProduction) console.warn('[store] ESCROW_SEED is not set: escrow wallets derive from a seed generated into state.json. Set ESCROW_SEED and back it up.');
  }
  setInterval(flush, 1500).unref();
}

export const claimSecret = () => CONFIG.claimSecret || db.state.claimSecret;
export const escrowSeed = () => CONFIG.escrowSeed || db.state.escrowSeed;

export const touch = (...keys) => keys.forEach((k) => dirty.add(k));
export function flush() {
  for (const k of [...dirty]) {
    dirty.delete(k);
    const file = path.join(CONFIG.dataDir, FILES[k]);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db[k], null, 1));
    fs.renameSync(tmp, file);
  }
}
/** Write now. Money moves only after the record of it is on disk. */
export function commit(...keys) {
  touch(...(keys.length ? keys : Object.keys(FILES)));
  flush();
}

export const coinByMint = (mint) => db.coins.find((c) => c.mint === mint) || null;
export const liveCoinForSlug = (slug) => db.coins.find((c) => c.slug === slug && c.status === 'live') || null;
export const claimForSlug = (slug) => db.claims.find((c) => c.slug === slug) || null;
export const add = (a, b) => (BigInt(a) + BigInt(b)).toString();
