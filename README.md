# Ape for Good — the backend

Open source so anyone can check what the money does. **Live:** https://charity-ruddy-mu.vercel.app
(the website itself is not in this repository; this is the API that holds every rule about launches,
escrow and claims).

Every public GoFundMe fundraiser, on-chain: anyone can launch a pump.fun coin for a fundraiser; the creator fee
from every trade goes into that fundraiser's own escrow wallet, and only the organizer — after proving the
fundraiser is theirs — can claim it.

## Verify it yourself (the parts that matter)

- **No key on the server can spend escrow on its own.** Each fundraiser's escrow wallet is derived in
  [`api/src/escrow.js`](api/src/escrow.js) (`escrowKeypair`) only at the moment a transaction is built, and the
  only transaction ever built with it is `prepareClaim`: collect the pump.fun creator vault and sweep the whole
  balance **to the verified organizer's wallet**. There is no withdraw route, no admin transfer, nothing else that
  signs with it — grep the repo for `escrowKeypair`.
- **Who can claim** is decided in [`api/src/launch.js`](api/src/launch.js): `verifiedClaim` only accepts a token
  issued after the organizer put a one-time code in their own fundraiser story
  ([`api/src/gfm.js`](api/src/gfm.js) `codeIsInPage` — story or title only, never comments).
- **Every payout is public**: written to the ledger (`GET /api/ledger`) with its Solana signature; every escrow
  wallet address is returned with its fundraiser (`GET /api/fundraisers/:slug`), so balances can be checked
  on-chain by anyone.
- **The admin endpoint is read-only** ([`api/src/admin.js`](api/src/admin.js)): it reports balances, it cannot move them.
- **No fee to the operator**: launches pay pump.fun's create cost and the network fee, nothing else.
- The server reads only public GoFundMe pages; it never signs in or posts there.

Secrets (`RPC_URL`, `CLAIM_SECRET`, `ESCROW_SEED`, `ADMIN_KEY`) are environment variables — see
[`api/.env.example`](api/.env.example). Nothing secret is in this repository.

## How it works

- **Directory.** Every fundraiser in GoFundMe's public sitemaps (~860k) lives in SQLite (`node:sqlite`,
  FTS5 over titles) — `api/src/directory.js`. A row starts as a slug; it is filled in (title, photo, goal,
  raised, organizer) from the public page the first time someone opens it and by a background reader,
  newest first, one page every `ENRICH_GAP_MS`.
- **Open launch (anyone).** `POST /api/launch/open/prepare` builds a pump.fun `create_v2` with the launcher's
  wallet as payer and the fundraiser's **escrow wallet** as creator, pre-signs with the mint keypair; the
  wallet signs the rest; `POST /api/launch/submit` broadcasts. One coin per fundraiser; the fundraiser's own
  photo is refused for coins launched by others. Rate limit `OPEN_LAUNCHES_PER_HOUR` per IP and wallet.
- **Escrow.** `api/src/escrow.js`: `Keypair.fromSeed(HMAC-SHA256(ESCROW_SEED, "charity-escrow:"+slug))`,
  derived on demand, never stored. pump.fun pays each trade's creator fee into that wallet's vault.
- **Organizer claim.** The organizer verifies (code `APE-XXXX-XXXX` in the story or title) and gets an HMAC
  claim token; `POST /api/escrow/prepare` builds ONE transaction (collect the vault, paid by the organizer, plus
  a system transfer of the whole escrow balance to them), signed by the escrow key server-side and by the
  organizer's wallet. Verified organizers can also **delist** their fundraiser or launch the coin themselves
  (then their wallet is the creator and pump.fun pays them directly).
- **Comments and requests** per fundraiser, rate-limited per IP.

The server never holds a key that can move money on its own initiative: the only transaction it builds for an
escrow wallet is its organizer's sweep.

## Run

    cd api && npm ci
    cp .env.example .env            # optional
    node src/server.js              # API on :4270

    node --test test/unit.test.js                       # parser, ownership check, directory, escrow, comments (no network)
    DATA_DIR=./data-sim node test/sim.mjs               # mainnet simulation of an owner launch, an open launch and a claim; no SOL spent

Node 24 (the pump.fun SDK and `node:sqlite` need it). Deploy notes in `DEPLOY.md`.

## Endpoints

    GET  /api/health  /api/state  /api/coins  /api/coins/:mint  /api/fees/:wallet  /api/ledger
    GET  /api/fundraisers?q=&sort=new|raised|funded|requested|coin|donations&limit=&offset=   /api/fundraisers/:slug
    POST /api/fundraisers {url}                 POST /api/fundraisers/request {slug}
    POST /api/fundraisers/delist {wallet, claim}
    GET  /api/comments/:slug                    POST /api/comments {slug, name, text, wallet?}
    POST /api/verify/start {url, wallet}        POST /api/verify/check {slug, wallet}
    POST /api/launch/open/prepare {wallet, slug|url, name, symbol, description, imageDataUrl}
    POST /api/launch/prepare {wallet, claim, name, symbol, description, imageDataUrl?}
    POST /api/launch/submit {mint, signedTransaction}
    POST /api/escrow/prepare {wallet, claim}    POST /api/escrow/submit {id, signedTransaction}
    POST /api/fees/prepare {wallet}             POST /api/fees/submit {id, signedTransaction}
    GET  /api/admin/overview  (header x-admin-key)
