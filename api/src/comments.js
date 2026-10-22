// Comments on a fundraiser's page on this site (not on GoFundMe). Anyone can post; a connected
// wallet gets its short address shown as a badge, otherwise the name they typed. Kept per slug,
// newest first, 300 per fundraiser; posting is rate-limited per IP and per slug.
import crypto from 'node:crypto';
import { db, commit } from './store.js';
import * as sol from './sol.js';

const bad = (status, message, code) => Object.assign(new Error(message), { status, code });
const KEEP = 300;
const perIp = new Map(); // ip -> [timestamps]
const WINDOW = 60_000;
const PER_MIN = 5;

const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

export function listComments(slug) {
  return db.comments.filter((c) => c.slug === slug).slice(0, 100).map(pub);
}

export function countComments(slug) {
  return db.comments.reduce((n, c) => (c.slug === slug ? n + 1 : n), 0);
}

export function addComment({ slug, name, text, wallet }, ip = 'local') {
  slug = clean(slug, 120).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw bad(400, 'no such fundraiser', 'bad_slug');
  text = clean(text, 500);
  if (text.length < 2) throw bad(400, 'write a comment first', 'empty');
  if (/https?:\/\/|www\./i.test(text)) throw bad(400, 'links are not allowed in comments', 'no_links');
  const owner = wallet ? sol.pubkey(wallet) : null;
  name = clean(name, 40) || (owner ? '' : 'Anonymous');
  const now = Date.now();
  const hits = (perIp.get(ip) || []).filter((t) => now - t < WINDOW);
  if (hits.length >= PER_MIN) throw bad(429, 'slow down: five comments a minute', 'rate_limited');
  hits.push(now);
  perIp.set(ip, hits);
  const c = { id: crypto.randomBytes(6).toString('hex'), slug, name, wallet: owner ? owner.toBase58() : null, text, at: now };
  db.comments.unshift(c);
  const mine = db.comments.filter((x) => x.slug === slug);
  if (mine.length > KEEP) { const drop = new Set(mine.slice(KEEP).map((x) => x.id)); db.comments = db.comments.filter((x) => !drop.has(x.id)); }
  commit('comments');
  return pub(c);
}

const pub = (c) => ({ id: c.id, name: c.name, wallet: c.wallet, text: c.text, at: c.at });
