// DATA_DIR=./data-test node --test test/unit.test.js — the GoFundMe reader, the ownership check,
// the directory and comments; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseFundraiserUrl, parseFundraiserPage, codeIsInPage, newCode } from '../src/gfm.js';
import { CONFIG } from '../src/config.js';
import * as store from '../src/store.js';
import * as directory from '../src/directory.js';
import * as comments from '../src/comments.js';
import * as escrow from '../src/escrow.js';

const html = fs.readFileSync(new URL('./fixtures/campaign.html', import.meta.url), 'utf8');
if (!/data-test/.test(CONFIG.dataDir)) throw new Error('run with DATA_DIR=./data-test');
fs.rmSync(CONFIG.dataDir, { recursive: true, force: true });
store.load();
directory.open();

test('fundraiser links', () => {
  assert.deepEqual(parseFundraiserUrl('https://www.gofundme.com/f/relief-fund-test?utm_source=x'), { slug: 'relief-fund-test' });
  assert.deepEqual(parseFundraiserUrl('gofundme.com/f/Help-Me/'), { slug: 'help-me' });
  assert.deepEqual(parseFundraiserUrl('https://gofund.me/abc123'), { short: 'abc123' });
  assert.throws(() => parseFundraiserUrl('https://www.gofundme.com/discover'), /not a fundraiser page/);
  assert.throws(() => parseFundraiserUrl('https://example.com/f/x'), /only GoFundMe/);
  assert.throws(() => parseFundraiserUrl(''), /paste/);
});

test('reads a campaign page', () => {
  const p = parseFundraiserPage(html);
  assert.equal(p.slug, 'relief-fund-test');
  assert.match(p.title, /Relief fund test/);
  assert.equal(p.organizer, 'Test Organizer');
  assert.equal(p.goal.amount, 200000);
  assert.equal(p.raised.amount, 151220);
  assert.equal(p.raised.currency, 'USD');
  assert.equal(p.donationCount, 2382);
  assert.match(p.image, /^https:\/\//);
  assert.match(p.story, /Chocó Needs Us Today/);
  assert.ok(!/<div>/.test(p.story), 'story is plain text');
  assert.equal(p.active, true);
  assert.equal(parseFundraiserPage('<html>nothing</html>'), null);
});

test('the code counts only in the story or title', () => {
  const code = newCode();
  assert.match(code, /^APE-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const page = parseFundraiserPage(html);
  assert.equal(codeIsInPage(page, code), false);
  assert.equal(codeIsInPage({ ...page, story: `${page.story}\n\nverify: ${code}` }, code), true);
  assert.equal(codeIsInPage({ ...page, title: `${page.title} ${code.toLowerCase()}` }, code), true);
  assert.equal(codeIsInPage({ ...page, comments: [code] }, code), false);
  assert.equal(codeIsInPage(page, 'CHARITY'), false);
});

test('directory: add, list, sort, request once per person', () => {
  const page = parseFundraiserPage(html);
  const f = directory.upsertFromPage(page);
  assert.equal(f.slug, 'relief-fund-test');
  directory.upsertFromPage({ ...page, slug: 'second-one', title: 'Second', raised: { amount: 5, currency: 'USD' }, goal: { amount: 10, currency: 'USD' }, donationCount: 1 });
  assert.equal(directory.listFundraisers({}).fundraisers.length, 2);
  assert.equal(directory.listFundraisers({}).total, 2);
  assert.equal(directory.listFundraisers({ sort: 'raised' }).fundraisers[0].slug, 'relief-fund-test');
  assert.equal(directory.listFundraisers({ sort: 'funded' }).fundraisers[0].slug, 'relief-fund-test'); // 75% vs 50%
  assert.equal(directory.listFundraisers({ q: 'second' }).fundraisers[0].slug, 'second-one');
  assert.equal(directory.listFundraisers({ q: 'choc' }).fundraisers[0].slug, 'relief-fund-test', 'prefix search over titles');
  assert.equal(directory.listFundraisers({ q: 'zzzz' }).total, 0);
  assert.equal(directory.requestCoin({ slug: 'second-one' }, '1.1.1.1').requests, 1);
  assert.equal(directory.requestCoin({ slug: 'second-one' }, '1.1.1.1').requests, 1);
  assert.equal(directory.requestCoin({ slug: 'second-one' }, '2.2.2.2').requests, 2);
  assert.equal(directory.listFundraisers({ sort: 'requested' }).fundraisers[0].slug, 'second-one');
  assert.throws(() => directory.requestCoin({ slug: 'nope' }, 'x'), /add it first/);
  directory.setMint('second-one', 'So11111111111111111111111111111111111111112');
  assert.throws(() => directory.requestCoin({ slug: 'second-one' }, '3.3.3.3'), /already has a coin/);
  assert.equal(directory.getFundraiser('second-one').coin, null, 'a mint without a live coin record shows no coin');
});

test('escrow wallets: one per fundraiser, same every time, never the same twice', () => {
  const a = escrow.escrowAddress('second-one');
  assert.equal(escrow.escrowAddress('second-one'), a);
  assert.notEqual(escrow.escrowAddress('relief-fund-test'), a);
  assert.match(a, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  assert.equal(escrow.claimedFor('second-one'), 0n);
  store.db.ledger.push({ id: 'x', slug: 'second-one', wallet: 'GyCBRgYYRZ2sb9HAoRER4msNewL7pnkERxJvrof5uuQs', lamports: '1500000', status: 'done', signature: 's', at: 1, doneAt: 2 });
  store.db.ledger.push({ id: 'y', slug: 'second-one', wallet: 'GyCBRgYYRZ2sb9HAoRER4msNewL7pnkERxJvrof5uuQs', lamports: '999', status: 'pending', at: 1 });
  assert.equal(escrow.claimedFor('second-one'), 1500000n);
  assert.equal(escrow.publicLedger().length, 1);
});

test('delisting hides a fundraiser', () => {
  directory.setDelisted('second-one', true);
  assert.ok(!directory.listFundraisers({}).fundraisers.some((f) => f.slug === 'second-one'));
  assert.equal(directory.getFundraiser('second-one').delisted, true);
  directory.setDelisted('second-one', false);
  assert.ok(directory.listFundraisers({}).fundraisers.some((f) => f.slug === 'second-one'));
});

test('sitemap rows: title from the slug, searchable, enriched later', () => {
  assert.equal(directory.titleOf('help-terry-return-to-lifesaving-care-in-socal'), 'Help terry return to lifesaving care in socal');
  const page = parseFundraiserPage(html);
  directory.upsertFromPage({ ...page, slug: 'third-from-sitemap', title: 'Third from sitemap' });
  const c = directory.counts();
  assert.ok(c.total >= 3);
  assert.equal(directory.listFundraisers({ q: 'sitemap' }).fundraisers[0].slug, 'third-from-sitemap');
  assert.equal(directory.getRow('third-from-sitemap').enriched, true);
  assert.equal(directory.getRow('nope-nope'), null);
});

test('comments: post, list newest first, limits', () => {
  const c = comments.addComment({ slug: 'second-one', name: 'Ana', text: 'Sending love from Lisbon' }, '9.9.9.9');
  assert.equal(c.name, 'Ana');
  comments.addComment({ slug: 'second-one', name: '', text: 'second comment', wallet: 'GyCBRgYYRZ2sb9HAoRER4msNewL7pnkERxJvrof5uuQs' }, '9.9.9.9');
  const list = comments.listComments('second-one');
  assert.equal(list.length, 2);
  assert.equal(list[0].text, 'second comment');
  assert.equal(list[0].wallet, 'GyCBRgYYRZ2sb9HAoRER4msNewL7pnkERxJvrof5uuQs');
  assert.equal(list[1].name, 'Ana');
  assert.equal(comments.countComments('second-one'), 2);
  assert.throws(() => comments.addComment({ slug: 'second-one', text: 'see https://x.y' }, '9.9.9.9'), /links/);
  assert.throws(() => comments.addComment({ slug: 'second-one', text: ' ' }, '9.9.9.9'), /write a comment/);
  for (let i = 0; i < 3; i++) comments.addComment({ slug: 'second-one', text: `c${i}` }, '9.9.9.9');
  assert.throws(() => comments.addComment({ slug: 'second-one', text: 'one too many' }, '9.9.9.9'), /slow down/);
  assert.equal(directory.getFundraiser('second-one', comments.countComments).comments, 5);
  directory.close();
  fs.rmSync(CONFIG.dataDir, { recursive: true, force: true });
});
