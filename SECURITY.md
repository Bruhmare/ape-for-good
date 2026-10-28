# Security

## What this is, in plain words

Ape for Good is not a smart contract. It is a server that builds Solana transactions for wallets to sign, plus a
set of wallets, one per fundraiser, that it derives from a secret. Here is exactly what that means for the money.

**What is fixed on-chain and cannot be changed by anyone, including us**

- The creator of every coin launched here. pump.fun stores the creator on the coin's bonding curve at launch and
  pays that address the creator fee of every trade. For a coin launched by anyone for a fundraiser, that address
  is the fundraiser's escrow wallet. Read it yourself: `node api/tools/verify.mjs --mint <mint>`.
- Every transfer out of an escrow wallet. Solana keeps the history; the wallet's address is public on the
  fundraiser's page and in `GET /api/coins`.

**What this code promises, and how you check it**

- The escrow key is derived when a transaction is built and is never written anywhere
  ([`api/src/escrow.js`](api/src/escrow.js), `escrowKeypair`).
- Exactly one transaction is ever signed with it: the organizer's sweep in `prepareClaim`, which pays the whole
  balance to the wallet that proved it owns the fundraiser. The test
  `the escrow key is private to escrow.js` in [`api/test/money.test.js`](api/test/money.test.js) fails if any
  other code path touches the key.
- Who counts as the organizer is decided by a code they place in their own fundraiser story
  ([`api/src/gfm.js`](api/src/gfm.js), `codeIsInPage`): story or title only, never donor comments.
- Every payout is published with its Solana signature (`GET /api/ledger`).
- `node api/tools/verify.mjs --all` reads all of the above from the chain and reports any transfer out of an
  escrow wallet that is not a published payout.

**What you are trusting**

- That the server running at the public API is this code. The deploy is a container built from this repository
  (`.github/workflows/publish.yml`), but you cannot prove from outside which image a server runs. What you *can*
  prove is the on-chain record: if an escrow wallet ever paid anyone but its organizer, it would be in the
  wallet's history and `verify.mjs` would flag it.
- Custody of `ESCROW_SEED`. If it leaked, escrow wallets could be emptied by whoever held it. It lives only in the
  server's environment, is never logged, and no route reads it.

There is no fee to the operator anywhere in the flow: a launch pays pump.fun's create cost and the network fee;
a claim pays the network fee. Nothing is deducted from a payout.

## Reporting a problem

If you find a way to move money out of an escrow wallet to anyone but its organizer, to pass as an organizer, or
to make the ledger lie, please report it privately through GitHub's **Report a vulnerability** on this repository
rather than in a public issue. Anything else, open an issue.
