// Reads a GoFundMe fundraiser the way a browser does: one GET of its public page, whose
// __NEXT_DATA__ carries the fundraiser (title, story, goal, raised, photo). Nothing is posted,
// nothing is logged in. Ownership is proven by the organizer putting a code we issued into the
// story: only the organizer can edit it, so the code appearing there (or in the title) means the
// wallet that asked for the code is theirs. Donor comments and updates are deliberately NOT checked.
import crypto from 'node:crypto';
import { CONFIG } from './config.js';

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const bad = (status, message, code) => Object.assign(new Error(message), { status, code });

/** "https://www.gofundme.com/f/help-x?utm=..." | "gofund.me/abc" -> { slug } | { short }. */
export function parseFundraiserUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw bad(400, 'paste your fundraiser link', 'bad_url');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { throw bad(400, 'that is not a link', 'bad_url'); }
  const host = u.hostname.toLowerCase();
  if (/(^|\.)gofundme\.com$/.test(host)) {
    const m = u.pathname.match(/^\/f\/([a-z0-9][a-z0-9-]*)\/?$/i);
    if (!m) throw bad(400, 'that is a GoFundMe link, but not a fundraiser page (it should look like gofundme.com/f/your-fundraiser)', 'bad_url');
    return { slug: m[1].toLowerCase() };
  }
  if (host === 'gofund.me') {
    const m = u.pathname.match(/^\/([a-z0-9]+)\/?$/i);
    if (!m) throw bad(400, 'that short link does not look right', 'bad_url');
    return { short: m[1] };
  }
  throw bad(400, 'only GoFundMe fundraiser links work here (gofundme.com/f/… or gofund.me/…)', 'bad_url');
}

/** Follow a gofund.me short link to its slug without downloading the page. */
export async function resolveShort(short) {
  const res = await fetch(`https://gofund.me/${short}`, { method: 'HEAD', redirect: 'manual', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) });
  const loc = res.headers.get('location') || '';
  const m = loc.match(/gofundme\.com\/f\/([a-z0-9][a-z0-9-]*)/i);
  if (!m) throw bad(404, 'that short link does not lead to a fundraiser', 'not_found');
  return m[1].toLowerCase();
}

const stripHtml = (html) => String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const money = (m) => (m && typeof m.amount === 'number' ? { amount: m.amount, currency: m.currencyCode || 'USD' } : null);

/** The fundraiser inside a campaign page's HTML, or null when the page is not a fundraiser. */
export function parseFundraiserPage(html) {
  const m = String(html).match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  let data;
  try { data = JSON.parse(m[1]); } catch { return null; }
  const state = data?.props?.pageProps?.__APOLLO_STATE__;
  if (!state) return null;
  const key = Object.keys(state).find((k) => k.startsWith('Fundraiser:'));
  if (!key) return null;
  const f = state[key];
  const descKey = Object.keys(f).find((k) => k.startsWith('description(') && k.includes('"excerpt":false')) || Object.keys(f).find((k) => k.startsWith('description'));
  const story = stripHtml(f[descKey] || '');
  const organizerRef = f.organizer?.__ref;
  const organizer = organizerRef ? state[organizerRef] : null;
  const organizerName = organizer ? [organizer.firstName, organizer.lastName].filter(Boolean).join(' ') || organizer.fullName || organizer.name || organizer.displayName || '' : '';
  const scaled = f.fundraiserPhoto?.scaled || {};
  return {
    id: String(f.id || f.fundId || ''),
    slug: String(f.slug || f.defaultSlug || '').toLowerCase(),
    title: String(f.title || '').trim(),
    story,
    summary: String(f.storySlideSummary || '').trim(),
    raised: money(f.currentAmount),
    goal: money(f.goalAmount || f.userDefinedGoalAmount),
    donationCount: Number(f.donationCount) || 0,
    heartCount: Number(f.heartCount) || 0,
    image: scaled.fourByThree1200 || f.fundraiserImageUrl || f.fundraiserPhoto?.url || '',
    location: f.location ? [f.location.city, f.location.statePrefix, f.location.countryCode].filter(Boolean).join(', ') : '',
    countryCode: f.location?.countryCode || '',
    createdAt: f.createdAt || null,
    organizer: organizerName,
    active: f.status === 'ACTIVE' && f.isPublished !== false && !f.deactivated,
    charityOrganized: Boolean(f.charityOrganized),
    categoryId: f.categoryId == null ? null : String(f.categoryId),
  };
}

/** The part of a fundraiser the site shows. */
export function publicCampaign(p) {
  return { slug: p.slug, title: p.title, summary: p.summary, raised: p.raised, goal: p.goal, donationCount: p.donationCount, image: p.image, location: p.location, organizer: p.organizer, createdAt: p.createdAt, url: `https://www.gofundme.com/f/${p.slug}` };
}

/* ------------------------------------------------------- polite fetching */

const cache = new Map(); // slug -> { at, page | null, status }
let chain = Promise.resolve(); // fetches run one at a time
let lastFetchAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The parsed fundraiser page for `slug`; `fresh` skips the cache (for the ownership check). */
export function fetchFundraiser(slug, { fresh = false } = {}) {
  const hit = cache.get(slug);
  if (!fresh && hit && Date.now() - hit.at < CONFIG.gfmCacheMs) return Promise.resolve(hit.page);
  const run = async () => {
    const wait = lastFetchAt + CONFIG.gfmMinGapMs - Date.now();
    if (wait > 0 && lastFetchAt) await sleep(Math.min(wait, CONFIG.gfmMinGapMs));
    lastFetchAt = Date.now();
    const res = await fetch(`https://www.gofundme.com/f/${encodeURIComponent(slug)}`, { headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(30_000) });
    const html = await res.text();
    if (res.status === 404) throw bad(404, 'that fundraiser does not exist (or it is not public)', 'not_found');
    if (!res.ok) throw bad(502, `GoFundMe answered ${res.status}; try again in a minute`, 'upstream');
    const page = parseFundraiserPage(html);
    if (!page) throw bad(502, 'could not read that fundraiser page; try again in a minute', 'unreadable');
    cache.set(slug, { at: Date.now(), page });
    return page;
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

/* ------------------------------------------------------- ownership codes */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newCode() {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return `APE-${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Whether the organizer put `code` where only they can: the story or the title. */
export function codeIsInPage(page, code) {
  const needle = String(code).toUpperCase().replace(/\s+/g, '');
  const hay = `${page.title}\n${page.story}`.toUpperCase().replace(/\s+/g, '');
  return needle.length >= 12 && hay.includes(needle);
}
