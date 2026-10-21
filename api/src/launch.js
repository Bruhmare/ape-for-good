// Launches and claims. Two ways a fundraiser's coin comes to exist:
//   open  — anyone launches it; the coin's creator is the fundraiser's escrow wallet (escrow.js),
//           so the fees wait there until the organizer proves the fundraiser is theirs and claims.
//   owner — the organizer proves ownership first and launches from their own wallet, which is the
//           creator, so pump.fun pays them directly.
// The server never holds a key that can move money on its own: it builds transactions, wallets sign.
import crypto from 'node:crypto';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import sharp from 'sharp';
import { CONFIG } from './config.js';
import { db, commit, claimSecret, coinByMint, liveCoinForSlug, claimForSlug } from './store.js';
import * as gfm from './gfm.js';
import * as pump from './pump.js';
import * as sol from './sol.js';
import * as directory from './directory.js';
import * as escrow from './escrow.js';

export const publicCampaign = gfm.publicCampaign;
const bad = (status, message, code) => Object.assign(new Error(message), { status, code });
const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
const MIN = 60_000;

/* ------------------------------------------------------------- verification */

/** Step 1: read the fundraiser, issue (or re-issue) the code this wallet must put in its story. */
export async function startVerification({ url, wallet }) {
  const owner = sol.pubkey(wallet);
  if (!owner) throw bad(400, 'connect a Solana wallet first', 'bad_wallet');
  let { slug, short } = gfm.parseFundraiserUrl(url);
  if (short) slug = await gfm.resolveShort(short);
  const page = await gfm.fetchFundraiser(slug);
  if (!page.active) throw bad(400, 'this fundraiser is not active on GoFundMe', 'inactive');
  directory.upsertFromPage(page);
  let claim = claimForSlug(slug);
  const now = Date.now();
  if (!claim || claim.wallet !== owner.toBase58() || now - claim.startedAt > CONFIG.verifyTtlMinutes * MIN || claim.verifiedAt) {
    if (claim && claim.verifiedAt && claim.wallet !== owner.toBase58() && now - claim.verifiedAt < CONFIG.claimTtlMinutes * MIN) {
      throw bad(409, 'another wallet verified this fundraiser moments ago; if that was you, connect that wallet', 'claimed');
    }
    claim = { slug, wallet: owner.toBase58(), code: gfm.newCode(), startedAt: now, verifiedAt: null, checks: 0, lastCheckAt: 0 };
    db.claims = db.claims.filter((c) => c.slug !== slug).concat(claim);
    commit('claims');
  }
  const coin = liveCoinForSlug(slug);
  return { slug, code: claim.code, campaign: publicCampaign(page), startedAt: claim.startedAt, coin: coin ? publicCoin(coin) : null };
}

/** Step 2: re-read the fundraiser; the code in its story proves the wallet owns it. */
export async function checkVerification({ slug, wallet }) {
  slug = str(slug, 120).toLowerCase();
  const owner = sol.pubkey(wallet);
  const claim = claimForSlug(slug);
  if (!owner || !claim || claim.wallet !== owner.toBase58()) throw bad(400, 'start the verification again', 'no_claim');
  if (Date.now() - claim.lastCheckAt < 10_000) throw bad(429, 'give GoFundMe a few seconds, then check again', 'slow_down');
  claim.lastCheckAt = Date.now();
  claim.checks += 1;
  const page = await gfm.fetchFundraiser(slug, { fresh: true });
  const found = gfm.codeIsInPage(page, claim.code);
  if (!found) { commit('claims'); return { ok: false, reason: 'The code is not in your story yet. Edit the fundraiser, paste the code anywhere in the story, save, then check again.', campaign: publicCampaign(page) }; }
  claim.verifiedAt = Date.now();
  claim.campaign = page;
  commit('claims');
  directory.upsertFromPage(page);
  const coin = liveCoinForSlug(slug);
  return { ok: true, claim: claimToken(claim), campaign: publicCampaign(page), expiresAt: claim.verifiedAt + CONFIG.claimTtlMinutes * MIN, coin: coin ? publicCoin(coin) : null, escrow: coin && coin.mode === 'open' ? await escrow.escrowStatus(slug).catch(() => null) : null };
}

const claimToken = (claim) => `${claim.slug}.${claim.verifiedAt}.${crypto.createHmac('sha256', claimSecret()).update(`${claim.slug}|${claim.wallet}|${claim.verifiedAt}`).digest('hex')}`;

/** The claim behind a token, or a 400. Exported for escrow claims and delisting. */
export function verifiedClaim(token, owner) {
  const m = String(token || '').match(/^([a-z0-9-]+)\.(\d+)\.([a-f0-9]{64})$/);
  if (!m) throw bad(400, 'verify your fundraiser first', 'no_claim');
  const claim = claimForSlug(m[1]);
  if (!claim || !claim.verifiedAt || String(claim.verifiedAt) !== m[2] || claim.wallet !== owner.toBase58()) throw bad(400, 'verify your fundraiser first', 'no_claim');
  const expect = Buffer.from(claimToken(claim));
  const given = Buffer.from(token);
  if (expect.length !== given.length || !crypto.timingSafeEqual(expect, given)) throw bad(400, 'verify your fundraiser first', 'no_claim');
  if (Date.now() - claim.verifiedAt > CONFIG.claimTtlMinutes * MIN) throw bad(410, 'that verification has expired; check the code again', 'claim_expired');
  return claim;
}

/* ------------------------------------------------------------- pictures */

async function coinImage(body, campaign, { allowCampaignPhoto }) {
  const dataUrl = String(body.imageDataUrl || '');
  let bytes;
  if (dataUrl) {
    const m = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw bad(400, 'the picture must be a PNG, JPEG, WebP or GIF', 'bad_image');
    bytes = Buffer.from(m[2], 'base64');
  } else {
    if (!allowCampaignPhoto) throw bad(400, 'upload a picture for the coin (the fundraiser\'s own photo is not used for coins launched by others)', 'no_image');
    if (!campaign.image) throw bad(400, 'this fundraiser has no photo; upload a picture for the coin', 'no_image');
    const res = await fetch(campaign.image, { headers: { 'user-agent': gfm.UA }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw bad(502, 'could not fetch the fundraiser photo; upload a picture instead', 'no_image');
    bytes = Buffer.from(await res.arrayBuffer());
  }
  if (bytes.length > CONFIG.maxImageBytes) throw bad(413, 'the picture is too large (3 MB max)', 'bad_image');
  if (!pump.imageType(bytes)) throw bad(400, 'that file is not an image', 'bad_image');
  try {
    return await sharp(bytes).rotate().resize(800, 800, { fit: 'cover', position: 'attention' }).png().toBuffer();
  } catch {
    return bytes;
  }
}

/* ------------------------------------------------------------- building a launch */

async function buildLaunch({ slug, campaign, payer, creator, mode, launcher, owner, name, symbol, description, bytes }) {
  const website = `https://www.gofundme.com/f/${slug}`;
  const mint = Keypair.generate();
  const mintAddr = mint.publicKey.toBase58();
  const meta = await pump.publishMetadata({ name, symbol, description, website }, bytes);
  const image = meta.image || pump.hostImage(bytes).url;
  const { ix, feeBps } = await pump.createInstruction({ mint: mint.publicKey, user: payer, creator, name, symbol, uri: meta.uri });
  const sim = await sol.simulate(payer, [ix]);
  if (sim.err) {
    const why = sol.explain(sim);
    throw bad(422, /enough SOL/.test(why) ? 'that wallet needs about 0.03 SOL to pay for the launch' : `the chain would refuse that launch: ${why}`, 'simulation');
  }
  const built = await sol.compile(payer, [ix], sol.unitsFor(sim));
  built.tx.sign([mint]);
  const size = built.tx.serialize().length;
  if (size > sol.MAX_TX) throw bad(422, 'the launch transaction is too large; shorten the name or ticker', 'too_large');
  const coin = {
    mint: mintAddr, status: 'launching', mode, slug,
    owner: owner ? owner.toBase58() : null, launcher: launcher.toBase58(), creator: creator.toBase58(),
    name, symbol, description, image, website, metadataUri: meta.uri, feeBps,
    campaign: publicCampaign(campaign), campaignAt: Date.now(),
    message: sol.messageB64(built.tx), lastValidBlockHeight: built.lastValidBlockHeight,
    preparedAt: Date.now(), launchedAt: null, signature: null, curve: null, curveAt: 0, escrow: null, delisted: false,
  };
  db.coins = db.coins.filter((c) => !(c.status === 'launching' && c.slug === slug && c.launcher === coin.launcher)).concat(coin);
  commit('coins');
  return { mint: mintAddr, transaction: sol.serializeB64(built.tx), lastValidBlockHeight: built.lastValidBlockHeight, feeBps, image, mode, creator: creator.toBase58() };
}

const nameOf = (body, campaign) => str(body.name, 32) || str(campaign.title, 32);
function symbolOf(body) {
  const symbol = str(body.symbol, 10).replace(/^\$/, '').toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(symbol)) throw bad(400, 'the ticker is 2-10 letters or digits', 'bad_symbol');
  return symbol;
}

/** Owner launch: the verified organizer's wallet pays, signs and is the creator. */
export async function prepareLaunch(body) {
  const owner = sol.pubkey(body.wallet);
  if (!owner) throw bad(400, 'connect a Solana wallet first', 'bad_wallet');
  const claim = verifiedClaim(body.claim, owner);
  if (liveCoinForSlug(claim.slug)) throw bad(409, 'this fundraiser already has a coin; claim its escrow instead', 'already_launched');
  const f = directory.getRow(claim.slug);
  if (f && f.delisted) throw bad(409, 'this fundraiser was delisted by its organizer', 'delisted');
  const campaign = claim.campaign;
  const name = nameOf(body, campaign);
  const symbol = symbolOf(body);
  const description = str(body.description, 600) || str(campaign.summary, 600);
  const bytes = await coinImage(body, campaign, { allowCampaignPhoto: true });
  return buildLaunch({ slug: claim.slug, campaign, payer: owner, creator: owner, mode: 'owner', launcher: owner, owner, name, symbol, description, bytes });
}

const openRate = new Map(); // ip|wallet -> [timestamps]
function openAllowed(key) {
  const now = Date.now();
  const hits = (openRate.get(key) || []).filter((t) => now - t < 3_600_000);
  if (hits.length >= CONFIG.openLaunchesPerHour) return false;
  hits.push(now);
  openRate.set(key, hits);
  return true;
}

/** Open launch: anyone pays and signs; the fundraiser's escrow wallet is the creator. */
export async function prepareOpenLaunch(body, ip = 'local') {
  const launcher = sol.pubkey(body.wallet);
  if (!launcher) throw bad(400, 'connect a Solana wallet first', 'bad_wallet');
  let slug = str(body.slug, 120).toLowerCase();
  if (!slug) { const p = gfm.parseFundraiserUrl(body.url); slug = p.short ? await gfm.resolveShort(p.short) : p.slug; }
  let f = directory.getRow(slug);
  if (!f || !f.enriched) f = await directory.ensureFresh(slug);
  if (!f || !f.active) throw bad(400, 'this fundraiser is not active on GoFundMe', 'inactive');
  if (f.delisted) throw bad(409, 'this fundraiser\'s organizer asked for it not to have a coin here', 'delisted');
  if (liveCoinForSlug(slug)) throw bad(409, 'this fundraiser already has a coin', 'already_launched');
  if (!openAllowed(`ip:${ip}`) || !openAllowed(`w:${launcher.toBase58()}`)) throw bad(429, `you can prepare ${CONFIG.openLaunchesPerHour} launches an hour; try again later`, 'rate_limited');
  const campaign = f.campaign;
  const name = nameOf(body, campaign);
  const symbol = symbolOf(body);
  const description = str(body.description, 600) || `A coin for the GoFundMe "${campaign.title}". Creator fees go to escrow that only the fundraiser's organizer can claim.`.slice(0, 600);
  const bytes = await coinImage(body, campaign, { allowCampaignPhoto: false });
  return buildLaunch({ slug, campaign, payer: launcher, creator: escrow.escrowKeypair(slug).publicKey, mode: 'open', launcher, owner: null, name, symbol, description, bytes });
}

/** Broadcast the transaction the payer signed; the coin is live once the cluster confirms it. */
export async function submitLaunch(body) {
  const coin = coinByMint(str(body.mint, 64));
  if (!coin || coin.status !== 'launching') throw bad(404, 'no launch to submit; prepare it again', 'no_launch');
  if (liveCoinForSlug(coin.slug)) throw bad(409, 'this fundraiser already has a coin', 'already_launched');
  let tx;
  try { tx = VersionedTransaction.deserialize(Buffer.from(String(body.signedTransaction || ''), 'base64')); } catch { throw bad(400, 'that is not a signed transaction', 'bad_tx'); }
  if (sol.messageB64(tx) !== coin.message) throw bad(400, 'the signed transaction is not the one that was prepared', 'bad_tx');
  if (tx.signatures.some((s) => s.every((b) => b === 0))) throw bad(400, 'the transaction is not fully signed', 'bad_tx');
  const raw = tx.serialize();
  const signature = sol.signatureOf(tx);
  coin.signature = signature;
  commit('coins');
  try {
    await sol.broadcast(raw);
    await sol.confirm(signature, raw, coin.lastValidBlockHeight, { timeoutMs: 90_000 });
  } catch (e) {
    const [curve] = await pump.curves([coin.mint]).catch(() => [null]);
    if (!curve) throw e;
  }
  coin.status = 'live';
  coin.launchedAt = Date.now();
  delete coin.message;
  commit('coins');
  directory.setMint(coin.slug, coin.mint);
  refreshCurves([coin]).catch(() => {});
  if (coin.mode === 'open') escrow.refreshEscrows([coin]).catch(() => {});
  return { signature, coin: publicCoin(coin) };
}

/* ------------------------------------------------------------- the organizer's claims */

/** Escrow sweep for the verified organizer of a fundraiser with an open coin. */
export async function prepareEscrowClaim(body) {
  const owner = sol.pubkey(body.wallet);
  if (!owner) throw bad(400, 'connect a Solana wallet first', 'bad_wallet');
  const claim = verifiedClaim(body.claim, owner);
  return escrow.prepareClaim(claim.slug, owner);
}

/** The organizer does not want a coin here: hide the fundraiser and block launches. The on-chain coin cannot be removed. */
export async function delist(body) {
  const owner = sol.pubkey(body.wallet);
  if (!owner) throw bad(400, 'connect a Solana wallet first', 'bad_wallet');
  const claim = verifiedClaim(body.claim, owner);
  directory.setDelisted(claim.slug, true);
  for (const c of db.coins) if (c.slug === claim.slug) c.delisted = true;
  commit('coins');
  return { ok: true, slug: claim.slug };
}

/* ------------------------------------------------------------- owner-coin fees */

export async function feesOf(wallet) {
  const owner = sol.pubkey(wallet);
  if (!owner) throw bad(400, 'not a wallet address', 'bad_wallet');
  const owed = await pump.creatorOwed(owner);
  const claimed = db.fees.filter((f) => f.wallet === owner.toBase58() && f.status === 'done').reduce((a, f) => a + BigInt(f.lamports), 0n);
  return { wallet: owner.toBase58(), owedLamports: owed.toString(), claimedLamports: claimed.toString() };
}

/** The transaction that pays a creator wallet what pump.fun owes it (the wallet signs and pays the fee). */
export async function prepareClaim(body) {
  const owner = sol.pubkey(body.wallet);
  if (!owner) throw bad(400, 'connect a Solana wallet first', 'bad_wallet');
  const owed = await pump.creatorOwed(owner);
  if (owed < 1_000_000n) throw bad(400, 'nothing to collect yet (fees show up as people trade)', 'nothing_owed');
  const ixs = await pump.collectInstructions(owner, owner);
  if (!ixs.length) throw bad(400, 'nothing to collect yet', 'nothing_owed');
  const sim = await sol.simulate(owner, ixs);
  if (sim.err) throw bad(422, `the chain would refuse that: ${sol.explain(sim)}`, 'simulation');
  const built = await sol.compile(owner, ixs, sol.unitsFor(sim));
  const id = crypto.randomBytes(8).toString('hex');
  db.fees.push({ id, wallet: owner.toBase58(), lamports: owed.toString(), status: 'pending', message: sol.messageB64(built.tx), lastValidBlockHeight: built.lastValidBlockHeight, at: Date.now(), signature: null });
  commit('fees');
  return { id, transaction: sol.serializeB64(built.tx), owedLamports: owed.toString() };
}

export async function submitClaim(body) {
  const rec = db.fees.find((f) => f.id === str(body.id, 32) && f.status === 'pending');
  if (!rec) throw bad(404, 'no fee claim to submit', 'no_claim');
  let tx;
  try { tx = VersionedTransaction.deserialize(Buffer.from(String(body.signedTransaction || ''), 'base64')); } catch { throw bad(400, 'that is not a signed transaction', 'bad_tx'); }
  if (sol.messageB64(tx) !== rec.message) throw bad(400, 'the signed transaction is not the one that was prepared', 'bad_tx');
  const raw = tx.serialize();
  const signature = sol.signatureOf(tx);
  rec.signature = signature;
  commit('fees');
  await sol.broadcast(raw);
  await sol.confirm(signature, raw, rec.lastValidBlockHeight, { timeoutMs: 90_000 });
  rec.status = 'done';
  delete rec.message;
  commit('fees');
  return { signature, lamports: rec.lamports };
}

/* ------------------------------------------------------------- refresh loops */

export async function refreshCurves(coins = db.coins.filter((c) => c.status === 'live')) {
  if (!coins.length) return;
  const list = await pump.curves(coins.map((c) => c.mint));
  coins.forEach((c, i) => {
    const stats = pump.curveStats(list[i]);
    if (stats) { c.curve = stats; c.curveAt = Date.now(); }
  });
  commit('coins');
}

/** Re-read each live coin's fundraiser now and then (sequentially, politely). */
export async function refreshCampaigns() {
  const stale = db.coins.filter((c) => c.status === 'live' && Date.now() - c.campaignAt > CONFIG.gfmRefreshMinutes * MIN);
  for (const c of stale) {
    try {
      const page = await gfm.fetchFundraiser(c.slug, { fresh: true });
      c.campaign = publicCampaign(page);
      directory.upsertFromPage(page);
    } catch (e) {
      console.warn(`[gfm] ${c.slug}: ${e.message}`);
    }
    c.campaignAt = Date.now();
    commit('coins');
  }
}

export async function refreshSolPrice() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { signal: AbortSignal.timeout(10_000) });
    const j = await res.json();
    if (j?.solana?.usd) { db.state.solUsd = Number(j.solana.usd); db.state.solUsdAt = Date.now(); commit('state'); }
  } catch { /* keep the last */ }
}

/* ------------------------------------------------------------- shapes the site sees */

export function publicCoin(c) {
  return {
    mint: c.mint, slug: c.slug, mode: c.mode || 'owner', name: c.name, symbol: c.symbol, description: c.description, image: c.image,
    owner: c.owner, creator: c.creator || c.owner, launcher: c.launcher || c.owner,
    feeBps: c.feeBps, launchedAt: c.launchedAt, signature: c.signature, campaign: c.campaign, curve: c.curve,
    escrow: c.mode === 'open' ? (c.escrow ? { ...c.escrow, claimedLamports: escrow.claimedFor(c.slug).toString() } : { address: c.creator, inEscrowLamports: '0', owedLamports: '0', balanceLamports: '0', claimedLamports: escrow.claimedFor(c.slug).toString(), at: 0 }) : null,
    delisted: Boolean(c.delisted),
    pumpUrl: `https://pump.fun/coin/${c.mint}`,
  };
}
