// pump.fun through its own SDK (as in the user's puffworks api). Every coin here is an ordinary
// pump.fun coin whose creator AND payer is the verified fundraiser owner's wallet: pump.fun pays
// the coin's creator fee into a vault only that wallet can collect. This file is the only place
// that knows the SDK.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { PUMP_SDK, OnlinePumpSdk, bondingCurvePda, feeSharingConfigPda, canonicalPumpPoolPda } from '@pump-fun/pump-sdk';
import { CONFIG } from './config.js';
import * as sol from './sol.js';

const online = new OnlinePumpSdk(sol.connection);
const big = (v) => BigInt(v.toString());

let cached = null;
export async function protocol() {
  if (cached && Date.now() - cached.at < 120_000) return cached;
  const global = await online.fetchGlobal();
  cached = {
    global,
    initialVirtualSol: big(global.initialVirtualSolReserves),
    initialVirtualTokens: big(global.initialVirtualTokenReserves),
    initialRealTokens: big(global.initialRealTokenReserves),
    at: Date.now(),
  };
  return cached;
}

/** The creator fee a coin is launched with: CREATOR_FEE_BPS, never above what pump.fun allows right now (0 = pump.fun's default). */
export async function creatorFeeBpsNow() {
  const { global } = await protocol();
  if (!global.creatorFeeConfigurable) return 0;
  const max = Number(global.maxConfigurableCreatorFeeBps.toString());
  return Math.max(0, Math.min(CONFIG.creatorFeeBps, max));
}

/** The create instruction for a coin whose creator is `creator`, paid by `user`. No dev buy. */
export async function createInstruction({ mint, user, creator, name, symbol, uri }) {
  const feeBps = await creatorFeeBpsNow();
  const base = { mint, name, symbol, uri, creator, user, mayhemMode: false };
  if (feeBps > 0) base.creatorFeeBps = new BN(feeBps);
  return { ix: await PUMP_SDK.createV2Instruction(base), feeBps };
}

/** Lamports pump.fun owes a creator and has not paid out yet (curve and pool programs). */
export const creatorOwed = async (creator) => big(await online.getCreatorVaultBalanceBothPrograms(creator));

/** The instructions that pay a creator what it is owed (empty when there is nothing to pay). */
export const collectInstructions = (creator, feePayer) => online.collectCoinCreatorFeeInstructions(creator, feePayer);

/* ------------------------------------------------------------ handing a coin's fees to its organizer */

/** The coin's fee-sharing account on pump.fun: once it exists it is the coin's creator, and only its shareholders are paid. */
export const sharingConfigAddress = (mint) => feeSharingConfigPda(new PublicKey(mint));

/** The decoded fee-sharing account ({ version, admin, adminRevoked, shareholders }), or null while the coin has none. */
export async function sharingConfig(mint) {
  const info = await sol.connection.getAccountInfo(sharingConfigAddress(mint), sol.COMMITMENT);
  return info ? PUMP_SDK.decodeSharingConfig(info) : null;
}

/**
 * Point all of a coin's creator fees at `owner`, for good: create the coin's fee-sharing account (the creator signs and
 * pays its rent) and make `owner` its only shareholder. pump.fun revokes the creator's authority on that first update
 * (adminRevoked), so the split can never be changed again, by the creator or anyone else.
 */
export async function lockFeesTo({ creator, mint, owner, graduated }) {
  mint = new PublicKey(mint);
  return [
    await PUMP_SDK.createFeeSharingConfig({ creator, mint, pool: graduated ? canonicalPumpPoolPda(mint) : null }),
    await PUMP_SDK.updateFeeShares({ authority: creator, mint, currentShareholders: [creator], newShareholders: [{ address: owner, shareBps: 10_000 }] }),
  ];
}

/** Pays a locked coin's accrued fees to its shareholders. Anyone may send it. */
export async function distributeInstruction(mint, config) {
  mint = new PublicKey(mint);
  return PUMP_SDK.distributeCreatorFees({ mint, sharingConfig: config, sharingConfigAddress: sharingConfigAddress(mint) });
}

/** Decoded curves for many mints: [{ vSol, vTok, realSol, supply, complete, creator } | null]. */
export async function curves(mints) {
  const out = [];
  for (let i = 0; i < mints.length; i += 100) {
    const infos = await sol.connection.getMultipleAccountsInfo(mints.slice(i, i + 100).map((m) => bondingCurvePda(new PublicKey(m))), sol.COMMITMENT);
    for (const info of infos) {
      if (!info) { out.push(null); continue; }
      const c = PUMP_SDK.decodeBondingCurve(info);
      out.push({
        vSol: big(c.virtualQuoteReserves ?? c.virtualSolReserves),
        vTok: big(c.virtualTokenReserves),
        realSol: big(c.realQuoteReserves ?? c.realSolReserves ?? 0),
        supply: big(c.tokenTotalSupply),
        complete: Boolean(c.complete),
        creator: c.creator ? new PublicKey(c.creator).toBase58() : null,
      });
    }
  }
  return out;
}

/** Market cap in lamports (price per whole token x total supply) and progress to graduation (0..1). */
export function curveStats(curve) {
  if (!curve) return null;
  const mcap = curve.vTok > 0n ? (curve.vSol * curve.supply) / curve.vTok : 0n;
  const GRADUATION = 85_000_000_000n; // ~85 SOL of real SOL fills a pump.fun curve
  const progress = curve.complete ? 1 : Math.min(1, Number(curve.realSol) / Number(GRADUATION));
  return { marketCapLamports: mcap.toString(), realSolLamports: curve.realSol.toString(), progress, complete: curve.complete };
}

/* ------------------------------------------------------------ metadata */

const IMAGE_TYPES = [
  { ext: 'png', mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
  { ext: 'jpg', mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { ext: 'webp', mime: 'image/webp', magic: [0x52, 0x49, 0x46, 0x46] },
  { ext: 'gif', mime: 'image/gif', magic: [0x47, 0x49, 0x46] },
];
export const imageType = (buf) => IMAGE_TYPES.find((t) => t.magic.every((b, i) => buf[i] === b)) || null;

/** Save an image under DATA_DIR/u and return its public URL. */
export function hostImage(bytes) {
  const type = imageType(bytes) || IMAGE_TYPES[0];
  const name = `${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 40)}.${type.ext}`;
  fs.writeFileSync(path.join(CONFIG.dataDir, 'u', name), bytes);
  return { url: `${CONFIG.publicOrigin}/u/${name}`, file: name };
}

/**
 * Pin the coin's picture + metadata through pump.fun's own uploader (IPFS), so the coin looks
 * right on pump.fun and in wallets; if it is unreachable, serve both from /u/. Resolves { uri, image, where }.
 */
export async function publishMetadata(coin, bytes) {
  const type = imageType(bytes) || IMAGE_TYPES[0];
  try {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: type.mime }), `coin.${type.ext}`);
    for (const k of ['name', 'symbol', 'description', 'twitter', 'telegram', 'website']) form.append(k, coin[k] || '');
    form.append('showName', 'true');
    const res = await fetch('https://pump.fun/api/ipfs', { method: 'POST', body: form, signal: AbortSignal.timeout(25_000) });
    if (!res.ok) throw new Error(`uploader answered ${res.status}`);
    const j = await res.json();
    if (!/^https?:\/\//.test(j?.metadataUri || '')) throw new Error('uploader gave no link');
    return { uri: j.metadataUri, image: j.metadata?.image || '', where: 'ipfs' };
  } catch (e) {
    console.warn(`[meta] pump.fun uploader failed (${e.message}), self-hosting`);
  }
  const image = hostImage(bytes).url;
  const body = JSON.stringify({ name: coin.name, symbol: coin.symbol, description: coin.description || '', image, showName: true, website: coin.website || undefined });
  const metaName = `${crypto.createHash('sha256').update(body).digest('hex').slice(0, 40)}.json`;
  fs.writeFileSync(path.join(CONFIG.dataDir, 'u', 'm', metaName), body);
  return { uri: `${CONFIG.publicOrigin}/u/m/${metaName}`, image, where: 'self' };
}
