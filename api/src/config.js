// Everything tunable comes from the environment (or api/.env); defaults are Solana mainnet.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

// a tiny .env reader, so `node src/server.js` works without a loader flag
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env */ }

const env = process.env;
const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const flag = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));
const list = (v) => String(v || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
const port = num(env.PORT, 4270);

export const CONFIG = {
  root: ROOT,
  port,
  host: env.HOST || '0.0.0.0',
  publicOrigin: (env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`).replace(/\/+$/, ''),
  extraOrigins: list(env.EXTRA_ORIGINS),
  dataDir: path.resolve(ROOT, env.DATA_DIR || './data'),
  siteDir: env.SITE_DIR ? path.resolve(ROOT, env.SITE_DIR) : path.resolve(ROOT, '../site'),
  serveSite: env.SERVE_SITE === undefined ? env.NODE_ENV !== 'production' : flag(env.SERVE_SITE),

  brand: { name: env.BRAND_NAME || 'Ape for Good' },

  rpcUrl: env.RPC_URL || env.SOL_RPC || 'https://api.mainnet-beta.solana.com',
  priorityMicrolamports: num(env.PRIORITY_MICROLAMPORTS, 50_000),
  creatorFeeBps: num(env.CREATOR_FEE_BPS, 300), // clamped to what pump.fun allows at launch time
  claimSecret: env.CLAIM_SECRET || '', // signs verification claims; generated once into state.json when unset
  escrowSeed: env.ESCROW_SEED || '', // derives each fundraiser's escrow wallet; generated once into state.json when unset (set it in production)
  adminKey: env.ADMIN_KEY || '', // the password for /admin; admin is off when unset
  openLaunchesPerHour: num(env.OPEN_LAUNCHES_PER_HOUR, 3), // open launches one person may prepare per hour

  // GoFundMe reads: public pages only, one fetch at a time, never faster than this
  gfmMinGapMs: num(env.GFM_MIN_GAP_MS, 3_000),
  gfmCacheMs: num(env.GFM_CACHE_MS, 60_000),
  gfmRefreshMinutes: num(env.GFM_REFRESH_MINUTES, 20),
  enrichOn: env.ENRICH === undefined ? true : flag(env.ENRICH), // background crawler: fill in never-read fundraisers, newest first
  enrichGapMs: num(env.ENRICH_GAP_MS, 4_000),
  importSitemaps: flag(env.IMPORT_SITEMAPS), // at boot, when the catalog is (nearly) empty, pull every fundraiser from GoFundMe's sitemaps
  curveRefreshSeconds: num(env.CURVE_REFRESH_SECONDS, 60),
  verifyTtlMinutes: num(env.VERIFY_TTL_MINUTES, 24 * 60), // how long a started verification stays open
  claimTtlMinutes: num(env.CLAIM_TTL_MINUTES, 60), // how long a verified claim may wait before the launch

  maxImageBytes: num(env.MAX_IMAGE_BYTES, 3 * 1024 * 1024),
  isProduction: env.NODE_ENV === 'production',
};
