// The directory: every public fundraiser GoFundMe lists in its sitemaps (~860k), in SQLite under
// DATA_DIR/catalog.db with full-text search. A row starts as a slug + a title made from it; it is
// "enriched" (title, photo, goal, raised, organizer…) the first time someone opens it and by the
// background crawler, newest first, one public page at a time. Coins, requests and delisting live
// on the same row.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { CONFIG } from './config.js';
import { db as jsondb, claimSecret, coinByMint } from './store.js';
import * as gfm from './gfm.js';

const bad = (status, message, code) => Object.assign(new Error(message), { status, code });
const MIN = 60_000;
const ipHash = (ip) => crypto.createHmac('sha256', claimSecret()).update(String(ip || 'local')).digest('hex').slice(0, 16);

let db;
const S = {}; // prepared statements

export function open(file = path.join(CONFIG.dataDir, 'catalog.db')) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=8000;
    CREATE TABLE IF NOT EXISTS f (
      slug TEXT PRIMARY KEY, title TEXT NOT NULL, lastmod TEXT,
      added_at INTEGER NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0, viewed_at INTEGER NOT NULL DEFAULT 0,
      enriched INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, delisted INTEGER NOT NULL DEFAULT 0,
      mint TEXT, requests INTEGER NOT NULL DEFAULT 0, requesters TEXT NOT NULL DEFAULT '[]',
      raised REAL NOT NULL DEFAULT 0, goal REAL NOT NULL DEFAULT 0, donations INTEGER NOT NULL DEFAULT 0, campaign TEXT
    );
    CREATE INDEX IF NOT EXISTS f_new ON f(enriched DESC, lastmod DESC);
    CREATE INDEX IF NOT EXISTS f_raised ON f(raised DESC);
    CREATE INDEX IF NOT EXISTS f_donations ON f(donations DESC);
    CREATE INDEX IF NOT EXISTS f_requests ON f(requests DESC);
    CREATE INDEX IF NOT EXISTS f_mint ON f(mint);
    CREATE INDEX IF NOT EXISTS f_todo ON f(enriched, updated_at, lastmod DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(title, slug UNINDEXED, tokenize='unicode61');
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  `);
  S.get = db.prepare('SELECT rowid, * FROM f WHERE slug = ?');
  S.insert = db.prepare('INSERT OR IGNORE INTO f (slug, title, lastmod, added_at) VALUES (?, ?, ?, ?)');
  S.fts = db.prepare('INSERT INTO fts (rowid, title, slug) VALUES (?, ?, ?)');
  S.ftsDel = db.prepare('DELETE FROM fts WHERE rowid = ?');
  S.enrich = db.prepare('UPDATE f SET title = ?, enriched = 1, active = ?, updated_at = ?, raised = ?, goal = ?, donations = ?, campaign = ? WHERE slug = ?');
  S.touch = db.prepare('UPDATE f SET updated_at = ? WHERE slug = ?');
  S.fail = db.prepare('UPDATE f SET enriched = -1, active = 0, updated_at = ? WHERE slug = ?');
  S.view = db.prepare('UPDATE f SET viewed_at = ? WHERE slug = ?');
  S.mint = db.prepare('UPDATE f SET mint = ? WHERE slug = ?');
  S.delist = db.prepare('UPDATE f SET delisted = ? WHERE slug = ?');
  S.request = db.prepare('UPDATE f SET requests = ?, requesters = ? WHERE slug = ?');
  S.next = db.prepare('SELECT slug FROM f WHERE enriched = 0 AND active = 1 ORDER BY updated_at ASC, (lastmod IS NULL), lastmod DESC LIMIT 1');
  S.stale = db.prepare('SELECT slug FROM f WHERE enriched = 1 AND updated_at < ? AND (viewed_at > ? OR mint IS NOT NULL) ORDER BY updated_at ASC LIMIT 8');
  S.counts = db.prepare('SELECT count(*) AS total, sum(enriched = 1) AS enriched, sum(mint IS NOT NULL) AS withCoin, sum(active = 1 AND delisted = 0) AS listed FROM f');
  S.metaGet = db.prepare('SELECT v FROM meta WHERE k = ?');
  S.metaSet = db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
  migrateJson();
  return db;
}

/** Entries from the old fundraisers.json (first version of the site) become rows once. */
function migrateJson() {
  if (!Array.isArray(jsondb.fundraisers) || !jsondb.fundraisers.length) return;
  if (S.metaGet.get('migrated')) return;
  for (const f of jsondb.fundraisers) {
    insertSlug(f.slug, f.campaign?.title || titleOf(f.slug), null, f.addedAt || Date.now());
    if (f.campaign) S.enrich.run(f.campaign.title, f.active === false ? 0 : 1, f.updatedAt || Date.now(), f.campaign.raised?.amount || 0, f.campaign.goal?.amount || 0, f.campaign.donationCount || 0, JSON.stringify(f.campaign), f.slug);
    if (f.mint) S.mint.run(f.mint, f.slug);
    if (f.delisted) S.delist.run(1, f.slug);
    if (f.requests) S.request.run(f.requests, JSON.stringify(f.requesters || []), f.slug);
    retitle(f.slug);
  }
  S.metaSet.run('migrated', String(Date.now()));
}

export const titleOf = (slug) => { const t = slug.replace(/-+/g, ' ').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };

function insertSlug(slug, title, lastmod, addedAt) {
  const r = S.insert.run(slug, title, lastmod, addedAt);
  if (r.changes) { S.fts.run(r.lastInsertRowid, title, slug); countCache.at = 0; }
  return r.changes > 0;
}
export function close() { try { db?.close(); } catch { /* already closed */ } db = null; }
function retitle(slug) {
  const row = S.get.get(slug);
  if (!row) return;
  S.ftsDel.run(row.rowid);
  S.fts.run(row.rowid, row.title, slug);
}

/** Add (or refresh) a fundraiser from its parsed page. Returns the row. */
export function upsertFromPage(page) {
  insertSlug(page.slug, page.title || titleOf(page.slug), null, Date.now());
  S.enrich.run(page.title || titleOf(page.slug), page.active ? 1 : 0, Date.now(), page.raised?.amount || 0, page.goal?.amount || 0, page.donationCount || 0, JSON.stringify(gfm.publicCampaign(page)), page.slug);
  retitle(page.slug);
  countCache.at = 0;
  return getRow(page.slug);
}

/** A row as an object the rest of the server uses: campaign parsed, booleans real. */
export function getRow(slug) {
  const r = S.get.get(String(slug || '').toLowerCase());
  if (!r) return null;
  return {
    slug: r.slug, title: r.title, lastmod: r.lastmod, addedAt: r.added_at, updatedAt: r.updated_at, viewedAt: r.viewed_at,
    enriched: r.enriched === 1, active: r.active === 1, delisted: r.delisted === 1, mint: r.mint, requests: r.requests, requesters: JSON.parse(r.requesters || '[]'),
    campaign: r.campaign ? JSON.parse(r.campaign) : { slug: r.slug, title: r.title, summary: '', raised: null, goal: null, donationCount: 0, image: '', location: '', organizer: '', createdAt: null, url: `https://www.gofundme.com/f/${r.slug}` },
  };
}

/** The row, read from GoFundMe first when it has never been read or is stale. */
export async function ensureFresh(slug, { maxAgeMs = CONFIG.gfmRefreshMinutes * MIN } = {}) {
  let row = getRow(slug);
  if (row && row.enriched && Date.now() - row.updatedAt < maxAgeMs) return row;
  if (row && !row.active && row.enriched) return row;
  try {
    const page = await gfm.fetchFundraiser(slug, { fresh: Boolean(row && row.enriched) });
    row = upsertFromPage(page);
  } catch (e) {
    if (e.status === 404) { if (row) S.fail.run(Date.now(), slug); throw e; }
    if (!row || !row.enriched) throw e;
    S.touch.run(Date.now(), slug); // keep what we had
  }
  return getRow(slug);
}

/** POST /api/fundraisers {url}: read the public page and put the fundraiser in the directory. */
export async function addFundraiser({ url }) {
  let { slug, short } = gfm.parseFundraiserUrl(url);
  if (short) slug = await gfm.resolveShort(short);
  const existing = getRow(slug);
  const row = await ensureFresh(slug, { maxAgeMs: CONFIG.gfmCacheMs });
  if (!row.active) throw bad(400, 'that fundraiser is not active on GoFundMe', 'inactive');
  return { fundraiser: pub(row), existed: Boolean(existing && existing.enriched) };
}

export const markViewed = (slug) => S.view.run(Date.now(), slug);
export function setMint(slug, mint) { S.mint.run(mint, slug); }
export function setDelisted(slug, delisted) { S.delist.run(delisted ? 1 : 0, slug); }

/** One request per person (IP) per fundraiser. Returns the new count. */
export function requestCoin({ slug }, ip) {
  const f = getRow(slug);
  if (!f) throw bad(404, 'no such fundraiser here; add it first', 'not_found');
  if (f.mint) throw bad(409, 'this fundraiser already has a coin', 'already_launched');
  const h = ipHash(ip);
  if (!f.requesters.includes(h)) { f.requesters.push(h); S.request.run(f.requesters.length, JSON.stringify(f.requesters), f.slug); }
  return { slug: f.slug, requests: f.requesters.length, requested: true };
}

const SORTS = {
  new: 'enriched DESC, (lastmod IS NULL), lastmod DESC, rowid DESC',
  raised: 'raised DESC, rowid DESC',
  funded: 'CASE WHEN goal > 0 THEN raised / goal ELSE 0 END DESC, rowid DESC',
  donations: 'donations DESC, rowid DESC',
  requested: 'requests DESC, rowid DESC',
  coin: '(mint IS NULL), rowid DESC',
};
const matchOf = (q) => q.split(/\s+/).map((t) => t.replace(/["*]/g, '')).filter(Boolean).slice(0, 8).map((t) => `"${t}"*`).join(' ');

/** The directory page: {fundraisers, total}. `q` is full-text over titles (prefix words). */
export function listFundraisers({ q = '', sort = 'new', limit = 24, offset = 0 } = {}, commentCount = () => 0) {
  const order = SORTS[sort] || SORTS.new;
  const lim = Math.min(60, Math.max(1, Number(limit) || 24));
  const off = Math.max(0, Number(offset) || 0);
  const needle = String(q || '').trim();
  let rows, total;
  if (needle.length >= 2) {
    const m = matchOf(needle);
    rows = db.prepare(`SELECT f.rowid, f.* FROM fts JOIN f ON f.rowid = fts.rowid WHERE fts MATCH ? AND f.active = 1 AND f.delisted = 0 ORDER BY ${order === SORTS.new ? 'f.enriched DESC, rank' : order.replace(/\b(raised|goal|donations|requests|mint|rowid|enriched|lastmod)\b/g, 'f.$1')} LIMIT ? OFFSET ?`).all(m, lim, off);
    total = db.prepare('SELECT count(*) AS n FROM fts JOIN f ON f.rowid = fts.rowid WHERE fts MATCH ? AND f.active = 1 AND f.delisted = 0').get(m).n;
  } else {
    rows = db.prepare(`SELECT rowid, * FROM f WHERE active = 1 AND delisted = 0 ORDER BY ${order} LIMIT ? OFFSET ?`).all(lim, off);
    total = counts().listed;
  }
  return { fundraisers: rows.map((r) => pub(rowObj(r), commentCount)), total, offset: off, limit: lim };
}

function rowObj(r) {
  return {
    slug: r.slug, title: r.title, lastmod: r.lastmod, addedAt: r.added_at, updatedAt: r.updated_at, viewedAt: r.viewed_at,
    enriched: r.enriched === 1, active: r.active === 1, delisted: r.delisted === 1, mint: r.mint, requests: r.requests, requesters: [],
    campaign: r.campaign ? JSON.parse(r.campaign) : { slug: r.slug, title: r.title, summary: '', raised: null, goal: null, donationCount: 0, image: '', location: '', organizer: '', createdAt: null, url: `https://www.gofundme.com/f/${r.slug}` },
  };
}

export function getFundraiser(slug, commentCount = () => 0) {
  const f = getRow(slug);
  return f ? pub(f, commentCount) : null;
}

let countCache = { at: 0, v: null };
export function counts() {
  if (countCache.v && Date.now() - countCache.at < 30_000) return countCache.v;
  const c = S.counts.get();
  countCache = { at: Date.now(), v: { total: c.total || 0, enriched: c.enriched || 0, withCoin: c.withCoin || 0, listed: c.listed || 0, importedAt: Number(S.metaGet.get('importedAt')?.v || 0) } };
  return countCache.v;
}

/** Rows the operator cares about: with a coin, requests, a verification or comments. */
export function adminRows(extraSlugs = []) {
  const slugs = [...new Set(extraSlugs)].slice(0, 500);
  const marks = slugs.map(() => '?').join(',');
  const rows = db.prepare(`SELECT rowid, * FROM f WHERE mint IS NOT NULL OR requests > 0${slugs.length ? ` OR slug IN (${marks})` : ''} ORDER BY (mint IS NULL), added_at DESC LIMIT 1000`).all(...slugs);
  return rows.map(rowObj);
}

/* ------------------------------------------------------------- crawling */

/** Re-read stale entries that someone looked at lately or that have a coin (a few per run). */
export async function refreshDirectory() {
  const now = Date.now();
  for (const { slug } of S.stale.all(now - CONFIG.gfmRefreshMinutes * MIN, now - 24 * 60 * MIN)) {
    await ensureFresh(slug).catch((e) => console.warn(`[dir] ${slug}: ${e.message}`));
  }
}

/** Enrich the next never-read fundraiser (newest first). Returns its slug, or null when all are done. */
export async function enrichNext() {
  const row = S.next.get();
  if (!row) return null;
  S.touch.run(Date.now(), row.slug); // goes to the back of the queue whatever happens
  try {
    const page = await gfm.fetchFundraiser(row.slug);
    upsertFromPage(page);
  } catch (e) {
    if (e.status === 404) S.fail.run(Date.now(), row.slug);
    else console.warn(`[enrich] ${row.slug}: ${e.message}`);
  }
  return row.slug;
}

/** Every fundraiser in GoFundMe's sitemaps becomes a row (slug + title from the slug + lastmod). */
export async function importSitemaps({ log = () => {}, only = null } = {}) {
  const headers = { 'user-agent': gfm.UA };
  const index = await (await fetch('https://www.gofundme.com/sitemap.xml', { headers, signal: AbortSignal.timeout(30_000) })).text();
  const files = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).filter((u) => /\/sitemaps\/www\/sitemap\d+\.xml(\.gz)?$/.test(u));
  let added = 0, seen = 0;
  const insertMany = (entries) => {
    db.exec('BEGIN');
    try { for (const [slug, lastmod] of entries) if (insertSlug(slug, titleOf(slug), lastmod, Date.now())) added++; db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  for (const [i, u] of files.entries()) {
    if (only && !only.includes(i)) continue;
    const res = await fetch(u, { headers, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) { log(`${u}: ${res.status}`); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    let xml;
    try { xml = zlib.gunzipSync(buf).toString('utf8'); } catch { xml = buf.toString('utf8'); }
    const entries = [];
    for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
      const slug = (m[1].match(/gofundme\.com\/f\/([a-z0-9][a-z0-9-]*)/i) || [])[1];
      if (!slug) continue;
      const lastmod = (m[1].match(/<lastmod>([^<]+)<\/lastmod>/) || [])[1] || null;
      entries.push([slug.toLowerCase(), lastmod]);
    }
    seen += entries.length;
    insertMany(entries);
    log(`${i + 1}/${files.length} ${path.basename(u)}: ${entries.length} urls, ${added} new so far`);
  }
  S.metaSet.run('importedAt', String(Date.now()));
  countCache.at = 0;
  return { files: files.length, seen, added };
}

export function pub(f, commentCount = () => 0) {
  const coin = f.mint ? coinByMint(f.mint) : null;
  return {
    slug: f.slug,
    campaign: f.campaign,
    enriched: Boolean(f.enriched),
    addedAt: f.addedAt,
    updatedAt: f.updatedAt,
    requests: f.requests,
    delisted: Boolean(f.delisted),
    comments: commentCount(f.slug),
    coin: coin && coin.status === 'live' ? { mint: coin.mint, mode: coin.mode || 'owner', symbol: coin.symbol, name: coin.name, image: coin.image, curve: coin.curve, escrow: coin.escrow || null, launchedAt: coin.launchedAt, pumpUrl: `https://pump.fun/coin/${coin.mint}` } : null,
  };
}
