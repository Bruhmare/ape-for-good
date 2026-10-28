// Ape for Good API: the fundraiser directory, comments, open launches into escrow, organizer verification
// and claims, owner launches, the public ledger and the password-protected admin overview.
//   GET  /api/health  /api/state  /api/coins  /api/coins/:mint  /api/fees/:wallet  /api/ledger
//   GET  /api/fundraisers?q=&sort=new|raised|funded|requested|coin|donations   /api/fundraisers/:slug
//   POST /api/fundraisers {url}                -> adds a fundraiser to the directory from its public page
//   POST /api/fundraisers/request {slug}       -> "I want a coin for this" (one per person)
//   POST /api/fundraisers/delist {wallet, claim}  (verified organizer) hide it, block launches
//   GET  /api/comments/:slug   POST /api/comments {slug, name, text, wallet?}
//   POST /api/launch/open/prepare {wallet, slug|url, name, symbol, description, imageDataUrl}  anyone; creator = escrow
//   POST /api/launch/prepare {wallet, claim, name, symbol, description, imageDataUrl?}            organizer; creator = owner
//   POST /api/launch/submit {mint, signedTransaction} -> {signature, coin}
//   POST /api/verify/start {url, wallet}  POST /api/verify/check {slug, wallet}
//   POST /api/escrow/prepare {wallet, claim} -> {id, transaction, lamports}   POST /api/escrow/submit {id, signedTransaction}
//   POST /api/fees/prepare {wallet}  POST /api/fees/submit {id, signedTransaction}   (owner coins)
//   GET  /api/admin/overview  (header x-admin-key)
//   GET  /u/...  self-hosted coin pictures + metadata
// Run: node src/server.js (PORT 4270). Locally, ../site is served at / as well.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';
import * as store from './store.js';
import { db } from './store.js';
import * as launch from './launch.js';
import * as directory from './directory.js';
import * as comments from './comments.js';
import * as escrow from './escrow.js';
import * as admin from './admin.js';
import * as sol from './sol.js';

store.load();
directory.open();

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm', '.xml': 'application/xml' };
const ALLOWED = new Set([CONFIG.publicOrigin, ...CONFIG.extraOrigins, 'http://127.0.0.1:3270', 'http://localhost:3270']);

const coinsOut = () => db.coins.filter((c) => c.status === 'live' && !c.delisted).sort((a, b) => a.launchedAt - b.launchedAt).map(launch.publicCoin);
const stateOut = () => ({ brand: CONFIG.brand, solUsd: db.state.solUsd, coins: coinsOut().length, fundraisers: directory.counts(), creatorFeeBps: CONFIG.creatorFeeBps, adminEnabled: Boolean(CONFIG.adminKey) });
const ipOf = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'local';

/* ------------------------------------------------------------------ http */

function cors(req, res) {
  const origin = req.headers.origin;
  if (req.method === 'GET' || req.method === 'HEAD') res.setHeader('Access-Control-Allow-Origin', '*');
  else if (origin && ALLOWED.has(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-admin-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = CONFIG.maxImageBytes * 1.4 + 64_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('request too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('bad JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}

function sendFile(res, file, cache = 'no-cache') {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': st.size, 'cache-control': cache });
    fs.createReadStream(file).pipe(res);
  });
}

/** A path under `base`, or null when it would leave it. */
function under(base, rel) {
  const p = path.resolve(base, `.${path.posix.normalize(`/${decodeURIComponent(rel)}`)}`);
  return p === base || p.startsWith(base + path.sep) ? p : null;
}

function serveSite(req, res, pathname) {
  const base = CONFIG.siteDir;
  if (/^\/c\/[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pathname)) pathname = '/coin';
  else if (/^\/f\/[a-z0-9][a-z0-9-]*$/i.test(pathname)) pathname = '/fundraiser';
  const p = under(base, pathname);
  if (!p) return json(res, 400, { error: 'bad path' });
  const tries = [p, `${p}.html`, path.join(p, 'index.html')];
  const hit = tries.find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
  if (hit) return sendFile(res, hit);
  const notFound = path.join(base, '404.html');
  if (fs.existsSync(notFound)) { res.writeHead(404, { 'content-type': MIME['.html'] }); return fs.createReadStream(notFound).pipe(res); }
  json(res, 404, { error: 'not found' });
}

const POST = {
  '/api/fundraisers': (b) => directory.addFundraiser(b),
  '/api/fundraisers/request': (b, ip) => directory.requestCoin(b, ip),
  '/api/fundraisers/delist': (b) => launch.delist(b),
  '/api/comments': (b, ip) => comments.addComment(b, ip),
  '/api/verify/start': (b) => launch.startVerification(b),
  '/api/verify/check': (b) => launch.checkVerification(b),
  '/api/launch/open/prepare': (b, ip) => launch.prepareOpenLaunch(b, ip),
  '/api/launch/prepare': (b) => launch.prepareLaunch(b),
  '/api/launch/submit': (b) => launch.submitLaunch(b),
  '/api/escrow/prepare': (b) => launch.prepareEscrowClaim(b),
  '/api/escrow/submit': (b) => escrow.submitClaim(b),
  '/api/fees/prepare': (b) => launch.prepareClaim(b),
  '/api/fees/submit': (b) => launch.submitClaim(b),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (p === '/api/health') return json(res, 200, { ok: true, slot: await sol.slot().catch(() => null), coins: coinsOut().length, fundraisers: directory.counts().total, at: Date.now() });
      if (p === '/api/state') return json(res, 200, stateOut());
      if (p === '/api/coins') return json(res, 200, { coins: coinsOut(), solUsd: db.state.solUsd });
      if (p === '/api/ledger') return json(res, 200, { ledger: escrow.publicLedger(), solUsd: db.state.solUsd });
      if (p === '/api/fundraisers') return json(res, 200, { ...directory.listFundraisers({ q: url.searchParams.get('q'), sort: url.searchParams.get('sort'), limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset') }, comments.countComments), counts: directory.counts(), coins: coinsOut(), solUsd: db.state.solUsd });
      if (p === '/api/admin/overview') return admin.adminOk(req) ? json(res, 200, admin.overview()) : json(res, CONFIG.adminKey ? 401 : 403, { error: CONFIG.adminKey ? 'wrong password' : 'admin is off: set ADMIN_KEY', code: 'admin' });
      let m = p.match(/^\/api\/fundraisers\/([a-z0-9][a-z0-9-]*)$/i);
      if (m) {
        const slug = m[1].toLowerCase();
        let f = directory.getFundraiser(slug, comments.countComments);
        if (!f || !f.enriched) { await directory.ensureFresh(slug); f = directory.getFundraiser(slug, comments.countComments); }
        if (!f) return json(res, 404, { error: 'not on GoFundMe', code: 'not_found' });
        directory.markViewed(slug);
        const coin = f.coin ? launch.publicCoin(store.coinByMint(f.coin.mint)) : null;
        return json(res, 200, { fundraiser: f, coin, comments: comments.listComments(f.slug), ledger: escrow.publicLedger().filter((l) => l.slug === f.slug), solUsd: db.state.solUsd });
      }
      m = p.match(/^\/api\/comments\/([a-z0-9][a-z0-9-]*)$/i);
      if (m) return json(res, 200, { comments: comments.listComments(m[1].toLowerCase()) });
      m = p.match(/^\/api\/coins\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (m) { const c = store.coinByMint(m[1]); return c && c.status === 'live' ? json(res, 200, { coin: launch.publicCoin(c), ledger: escrow.publicLedger().filter((l) => l.slug === c.slug), solUsd: db.state.solUsd }) : json(res, 404, { error: 'no such coin' }); }
      m = p.match(/^\/api\/fees\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (m) return json(res, 200, await launch.feesOf(m[1]));
      if (p.startsWith('/u/')) { const f = under(path.join(CONFIG.dataDir, 'u'), p.slice(3)); return f ? sendFile(res, f, 'public, max-age=31536000, immutable') : json(res, 400, { error: 'bad path' }); }
      if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });
      if (CONFIG.serveSite) return serveSite(req, res, p);
      return json(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST') {
      const fn = POST[p];
      if (!fn) return json(res, 404, { error: 'not found' });
      const origin = req.headers.origin;
      if (origin && !ALLOWED.has(origin)) return json(res, 403, { error: 'origin not allowed' });
      const body = await readBody(req);
      return json(res, 200, await fn(body, ipOf(req)));
    }
    json(res, 405, { error: 'method not allowed' });
  } catch (e) {
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
    if (status >= 500) console.error(`[http] ${req.method} ${p}:`, e);
    json(res, status, { error: e.message || 'error', code: e.code || null });
  }
});

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`[ape-for-good] api on http://${CONFIG.host}:${CONFIG.port} · site ${CONFIG.serveSite ? 'served' : 'elsewhere'} · public ${CONFIG.publicOrigin} · rpc ${new URL(CONFIG.rpcUrl).host} · fundraisers ${directory.counts().total} (${directory.counts().enriched} read) · live coins ${coinsOut().length} · admin ${CONFIG.adminKey ? 'on' : 'off'} · escrow seed ${CONFIG.escrowSeed ? 'env' : 'state.json'}`);
});

/* ------------------------------------------------------------------ loops */

const tick = (fn, ms, label) => { const run = () => fn().catch((e) => console.warn(`[${label}] ${e.message}`)); setTimeout(run, 3000); setInterval(run, ms).unref(); };
tick(() => launch.refreshCurves(), CONFIG.curveRefreshSeconds * 1000, 'curves');
tick(() => escrow.refreshEscrows(), CONFIG.curveRefreshSeconds * 1000, 'escrow');
tick(() => launch.refreshCampaigns(), 5 * 60_000, 'gfm');
tick(() => directory.refreshDirectory(), 5 * 60_000, 'dir');
tick(() => launch.refreshSolPrice(), 5 * 60_000, 'sol-usd');

// the crawler: one never-read fundraiser every ENRICH_GAP_MS, newest first, forever
if (CONFIG.enrichOn) {
  const enrich = async () => { try { if (!(await directory.enrichNext())) await new Promise((r) => setTimeout(r, 60_000)); } catch (e) { console.warn(`[enrich] ${e.message}`); } setTimeout(enrich, CONFIG.enrichGapMs); };
  setTimeout(enrich, 15_000);
}
// every fundraiser from the sitemaps, once, when asked for and the catalog is still small
if (CONFIG.importSitemaps && directory.counts().total < 100_000) {
  directory.importSitemaps({ log: (l) => console.log(`[sitemaps] ${l}`) }).then((r) => console.log(`[sitemaps] done: ${r.seen} urls in ${r.files} files, ${r.added} new`)).catch((e) => console.warn(`[sitemaps] ${e.message}`));
}
