// The password-protected overview for the operator: every fundraiser, its coin, what its escrow holds,
// what was paid out, requests and comments. Read-only: there is deliberately no way to move money here.
import crypto from 'node:crypto';
import { CONFIG } from './config.js';
import { db, coinByMint } from './store.js';
import * as directory from './directory.js';
import * as escrow from './escrow.js';
import { countComments } from './comments.js';

export function adminOk(req) {
  const given = String(req.headers['x-admin-key'] || '');
  if (!CONFIG.adminKey || !given) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(CONFIG.adminKey).digest();
  return crypto.timingSafeEqual(a, b);
}

export function overview() {
  const extra = [...db.claims.filter((c) => c.verifiedAt).map((c) => c.slug), ...db.comments.map((c) => c.slug)];
  const rows = directory.adminRows(extra).map((f) => {
    const coin = f.mint ? coinByMint(f.mint) : null;
    const live = coin && coin.status === 'live' ? coin : null;
    const esc = live && live.mode === 'open' ? live.escrow : null;
    return {
      slug: f.slug,
      title: f.campaign.title,
      organizer: f.campaign.organizer,
      url: f.campaign.url,
      raised: f.campaign.raised,
      goal: f.campaign.goal,
      addedAt: f.addedAt,
      delisted: Boolean(f.delisted),
      requests: f.requests,
      comments: countComments(f.slug),
      coin: live ? { mint: live.mint, mode: live.mode || 'owner', symbol: live.symbol, launcher: live.launcher || live.owner, creator: live.creator || live.owner, launchedAt: live.launchedAt, marketCapLamports: live.curve?.marketCapLamports || null } : null,
      escrowAddress: live && live.mode === 'open' ? live.creator : null,
      inEscrowLamports: esc ? esc.inEscrowLamports : '0',
      claimedLamports: escrow.claimedFor(f.slug).toString(),
      verifiedWallet: (db.claims.find((c) => c.slug === f.slug && c.verifiedAt) || {}).wallet || null,
    };
  });
  const sum = (k) => rows.reduce((a, r) => a + BigInt(r[k] || 0), 0n).toString();
  return {
    rows,
    counts: directory.counts(),
    totals: { fundraisers: directory.counts().total, shown: rows.length, coins: rows.filter((r) => r.coin).length, openCoins: rows.filter((r) => r.coin && r.coin.mode === 'open').length, inEscrowLamports: sum('inEscrowLamports'), claimedLamports: sum('claimedLamports') },
    ledger: escrow.publicLedger(),
    solUsd: db.state.solUsd,
    escrowSeedFromEnv: Boolean(CONFIG.escrowSeed),
  };
}
