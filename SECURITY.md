# Security

## What this is, in plain words

Ape for Good is not a smart contract. It is a server that builds Solana transactions for wallets to sign, plus a
set of wallets, one per fundraiser, that it derives from a secret. Here is exactly what that means for the money.

**What is fixed on-chain and cannot be changed by anyone, including us**

- The creator of every coin launched here. pump.fun stores the creator on the coin's bonding curve at launch and
  pays that address the creator fee of every trade. For a coin launched by anyone for a fundraiser, that address
  is the fundraiser's escrow wallet. Read it yourself: `node api/tools/verify.mjs --mint <mint>`.
- **Where a coin's fees go once its organizer has claimed.** The first claim creates the coin's fee-sharing
  account on pump.fun's own fee program, with the organizer's wallet as the only shareholder at 100%. pump.fun
  revokes the creator's authority on that first update (`adminRevoked`), and the coin's creator becomes that
  account. From then on pump.fun pays every fee of that coin to the organizer, and nobody can change the split:
  not the escrow key, not this server, not whoever might hold `ESCROW_SEED`. A second update fails on-chain with
  `SharingConfigAdminRevoked`. `verify.mjs` checks the account, the 100% split and the lock for every claimed coin.
- Every transfer out of an escrow wallet. Solana keeps the history; the wallet's address is public on the
  fundraiser's page and in `GET /api/coins`.

**What this code promises, and how you check it**

- The escrow key is derived when a transaction is built and is never written anywhere
  ([`api/src/escrow.js`](api/src/escrow.js), `escrowKeypair`).
- Exactly one transaction is ever signed with it: the organizer's claim in `prepareClaim`. It collects the escrow's
  vault, on the first claim hands the coin's fees to the organizer (above), and pays the escrow's whole balance to
  the wallet that proved it owns the fundraiser. The tests in [`api/test/money.test.js`](api/test/money.test.js)
  fail if any other code path touches the key, if the sweep stops paying the organizer, or if the fee hand-over
  stops naming the organizer as the only shareholder.
- Who counts as the organizer is decided by a code they place in their own fundraiser story
  ([`api/src/gfm.js`](api/src/gfm.js), `codeIsInPage`): story or title only, never donor comments.
- Every payout is published with its Solana signature (`GET /api/ledger`).
- `node api/tools/verify.mjs --all` reads all of the above from the chain and reports any transfer out of an
  escrow wallet that is not a published payout, and any claimed coin whose fees are not locked to its organizer.

**What you are trusting, and for how long**

- Until a fundraiser's organizer claims, its coin's fees collect in the escrow wallet, and the escrow key is
  derived from `ESCROW_SEED` in the server's environment. In that window, someone holding the seed could move
  those fees. The seed is never logged and no route reads it, but that is a promise, not a proof. The window ends
  at the first claim: the fees collected so far are paid out, and every later fee goes to the organizer through
  pump.fun with no key of ours involved.
- That the server running at the public API is this code. The deploy is a container built from this repository
  (`.github/workflows/publish.yml`), but you cannot prove from outside which image a server runs. What you *can*
  prove is the on-chain record: if an escrow wallet ever paid anyone but its organizer, it would be in the
  wallet's history and `verify.mjs` would flag it.

There is no fee to the operator anywhere in the flow: a launch pays pump.fun's create cost and the network fee;
a claim pays the network fee, and the first claim pays pump.fun's rent for the fee-sharing account (about
0.006 SOL), out of the escrow. Nothing else is deducted from a payout.

## Reporting a problem

If you find a way to move money out of an escrow wallet to anyone but its organizer, to pass as an organizer, or
to make the ledger lie, please report it privately through GitHub's **Report a vulnerability** on this repository
rather than in a public issue. Anything else, open an issue.
