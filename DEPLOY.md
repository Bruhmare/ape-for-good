# Deploying Ape for Good

API on Railway; the website (not in this repo) on Vercel.

| | where | staging |
|---|---|---|
| site | Vercel project `charity` (static `site/`) | a staging folder outside the repo |
| API | Railway service `charity-api`, volume at `/data` | a staging folder outside the repo |

Never deploy from this folder; copy into the staging folder and keep its `.vercel` / `.railway` link.

## API (Railway)

    mkdir -p <staging-api>
    cd api
    cp package.json package-lock.json Dockerfile .dockerignore <staging-api>/
    cp -r src <staging-api>/
    cd <staging-api>
    railway up --service charity-api --detach
    curl https://charity-api-production-d1b7.up.railway.app/api/health

Variables: `NODE_ENV=production`, `HOST=0.0.0.0`, `DATA_DIR=/data`, `SERVE_SITE=0`,
`PUBLIC_ORIGIN=<the Vercel site URL>`, `EXTRA_ORIGINS=<other site origins, comma-separated>`,
`RPC_URL=<keyed mainnet RPC>` (secret), `CLAIM_SECRET=<random hex>` (secret), **`ESCROW_SEED=<random hex>`**
(secret — every fundraiser's escrow wallet derives from it; back it up, never rotate it once coins exist),
`ADMIN_KEY=<the /admin password>`, optional `CREATOR_FEE_BPS` (300, clamped to what pump.fun allows),
`OPEN_LAUNCHES_PER_HOUR` (3). Without CLAIM_SECRET/ESCROW_SEED they are generated into `/data/state.json`.
**`IMPORT_SITEMAPS=1`** on the first boot: pulls every fundraiser from GoFundMe's 43 sitemaps (~860k rows, a few
minutes) into `/data/catalog.db` (SQLite, ~300 MB with the search index — size the volume for 1 GB). The crawler
(`ENRICH=1` by default, one page every `ENRICH_GAP_MS`=4000) fills in photos and figures newest-first, forever;
fundraisers also fill in the moment someone opens them. `GFM_MIN_GAP_MS` (3000) is the floor between any two reads.
Add the `/data` volume before the first run: coins, claims and self-hosted pictures live there.

## Site

The website is deployed separately and is not in this repository.

## Going live checklist

1. `/api/health` answers on Railway and `GET /api/coins` returns `{"coins":[]}` through the Vercel domain.
2. From the live site: paste a fundraiser link → the preview shows its title, photo and figures
   (this proves Railway's egress can read gofundme.com; if it cannot, set a proxy or move the API).
3. A real launch needs a wallet with ~0.03 SOL; the first one is the end-to-end test.
