# blossom-verify

**Don't trust our track record. Rebuild it yourself.**

Everybody in this market says *trust me*. This repository is the opposite of that: it is the tool that lets a stranger check every claim we make, including the ones that make us look bad. If any of it were false, this is the code that would prove it.

[Blossom Scanner](https://blossomscanner.dev) is a Solana memecoin scanner whose every call is written to the blockchain as a signed memo — seconds after the call fires, and **before anyone knows the outcome**. Wins, losses, rugs: all of it, permanently, from one public wallet.

This repository is the auditor, not the marketing. It reconstructs the entire record straight from Solana and prints it — including the losers.

```bash
node verify.js
```

No dependencies. No API keys. No account. Node 18+.

---

## What it does

```
node verify.js                 # rebuild the record: count, seal latency, recent calls
node verify.js --outcomes 50   # ALSO price the last 50 calls — the full distribution, losers included
node verify.js --json          # machine-readable dump of every sealed call
node verify.js --rpc <url>     # use your own RPC (archival endpoints see the full history)
node verify.js --offline       # chain only — skip the one call to blossomscanner.dev
```

Everything is read from the attestation wallet:

```
954wdksZqnk9RQRJpgq564omv5aAiLfTG8Fqqb5y6AD9
```

Nothing in this repo talks to a Blossom server for the proof itself.

There is exactly one non-chain request: after rebuilding the record, the script asks `blossomscanner.dev/api/sealed-count` how many calls the full ledger holds, purely so it can warn you when your RPC pruned history and you are seeing a slice. It never feeds a number into the proof. If you would rather touch nothing but Solana, run `node verify.js --offline` and that request never happens.

The endpoint you pass with `--rpc` is never printed — archival providers put their API key in the URL, and this tool's output is meant to be screenshotted.

## What it proves

**A call cannot be backdated, edited, or deleted.** Each memo carries the market cap and timestamp of the moment the scanner fired; the transaction carries a block time set by Solana's validators. Nobody — including us — can move either one afterwards. The script computes the delay between the two (median ~5 seconds) and prints the distribution.

That's the whole claim, and it's the only one that matters: **you are looking at predictions recorded before their outcomes existed.**

## The honest part

`--outcomes` prices the sampled calls at their *current* market cap versus the sealed entry and prints the whole distribution — the "down 80%+" bucket first. Most memecoins die. Our own median call is around break-even. Those numbers are in this tool on purpose: a record that can't hide its losers is the only kind worth checking.

Peaks are peaks. Nothing here is anyone's actual return, and nothing here is financial advice.

## ⚠️ Public RPCs prune history

The default endpoint is a free public node, and most public nodes only keep recent signatures. A default run typically rebuilds the **last few days** of calls, not the whole ledger — the script detects that, tells you how many it reached versus how many exist, and stops you drawing the wrong conclusion.

To rebuild the complete history, point it at an archival RPC (Helius, QuickNode and Alchemy all have free tiers):

```bash
node verify.js --rpc https://your-archival-endpoint
```

## The memo format

```
BLSM1|<mint>|<symbol>|<mcapCallUsd>|<tsCallMs>|<feed>|<smartCount>|<conviction>
```

| field | meaning |
|---|---|
| `mint` | the token's Solana mint address |
| `symbol` | ticker at call time (may contain spaces; can be absent) |
| `mcapCallUsd` | market cap in USD at the moment of the call |
| `tsCallMs` | when the scanner fired, epoch milliseconds |
| `feed` | which detector fired: `smartmoney`, `trending`, `dex` |
| `smartCount` | number of tracked smart-money wallets converging |
| `conviction` | `1` if the call cleared the high-conviction gate |

Solana's RPC prefixes memos with their byte length (`[91] BLSM1|…`); the parser strips that. Verify any single call by hand at `https://solscan.io/tx/<signature>`.

## For machines: the agent endpoint

```
GET https://blossomscanner.dev/api/agent
```

One call, no documentation required. It describes itself — what the record is, where it came from, and the exact `getTransaction` call that verifies **each individual signal** against Solana without trusting the server that served it.

The honest limits are structured fields rather than prose, so an agent reporting only the winners would have to ignore the schema to do it:

```json
"isFinancialAdvice": false,
"guaranteesOutcomes": false,
"whatIsProven": "That each call was recorded on Solana before its outcome was known.",
"whatIsNotProven": "That any call was, or will be, profitable."
```

Every other signal API asks a machine to trust its output. This one ships the procedure for disproving it — because a claim an agent can check is worth more than one it has to accept. An autonomous agent verified this feed manually before the endpoint existed; now that loop is a single request.

## Nine Solana bugs that cost us weeks

Every hard-won mainnet gotcha we hit building this — Token-2022 accounts vanishing from close loops, compute budgets consumed by instructions you didn't write, a platform fee the docs permit and the program rejects, market data that corrupts instead of erroring, and five more. What we expected, what actually happened, how to detect it, and what fixed it.

**→ [SOLANA-GOTCHAS.md](./SOLANA-GOTCHAS.md)**

Published as a public good. None of it announced itself; all of it is waiting for anyone building trading, reclaim, or portfolio tooling on Solana.

## The app the record belongs to

The scanner is one half. The other half is [blossomscanner.dev](https://blossomscanner.dev) — a trading app built on the same rule: every number a user sees is one they can check themselves.

**It never holds your money.** No deposits, no balances, no accounts. Keys stay in the user's own wallet, every transaction is signed by them, and every payout lands at their own address. There is nothing here to withdraw, because there is nothing here to hold.

**Swap — any Solana token to any other, in one transaction, 0.75% flat on every pair.** The price impact, the route and the fee are all shown *before* signing, not after. Wallets typically charge more and show less.

**Send — SOL transfers at the network's own minimum, 0.000005 SOL.** No platform fee and no priority bidding added on top. That is the floor a Solana transaction can cost, and it means more of the amount actually arrives.

**Reclaim — get back the SOL your dead memecoins are sitting on.** Every token account you ever opened holds roughly 0.002 SOL of your own rent deposit. When the coin dies, that deposit doesn't come back on its own. Reclaim finds those accounts, closes them, and returns the SOL to your address for a 1% fee — the lowest of any Solana reclaim tool.

Every one of those fee claims is checkable the same way the track record is: the fee accounts are public, on-chain, and permanent. Nobody has to take our word for the fees either.

### Cheaper, on published numbers

| | Blossom | Phantom |
|---|---|---|
| swap fee | **0.75% flat — every pair, no exceptions** | 0.85%, *"charged on select swap pairs"* |
| sending SOL | **0.000005 SOL — the network minimum, nothing added** | priority fees applied on top |
| reclaiming dead rent | **1%** | not offered |

Phantom's figure and wording are quoted from their own help centre, read on 16 August 2026. We don't publish a rival's number we haven't checked ourselves that week, and we date it so you can catch it going stale.

On a swap that's 0.10% back in your pocket on every pair, every time. On a max send it's the priority bid you were never told about — the difference lands in the amount that actually arrives.

### Faster, because there's nothing in the middle

Prices come from the chain, not from an index of the chain.

For a coin still on its bonding curve, the app subscribes to the curve account itself — the exact account the program prices trades against — so the number on screen moves when Solana moves, not when an aggregator catches up. Sub-second, straight from the source, while the fallback poll runs underneath it.

That's an architectural claim, and it's the kind you can check: open the app, watch a live coin, and compare it against anything else you have open.

### The test that settles it

Take a contract address off the feed while it's still fresh — minutes old, still on its bonding curve — and paste it into whatever you normally trade with.

Then paste the same address into Blossom.

Wallet swappers work off token lists and routing that has to catch up with a new mint; a coin that launched ten minutes ago is frequently just *not there yet*. Blossom prices it off the curve account directly, so the coins that matter most in the trenches — the ones nobody has heard of yet — are tradeable at the moment they're worth trading, not an hour later when the move is over.

That's the entire reason the feed and the app are one product. A call you can see but can't act on is a screenshot.

### And on the way out

The pipeline is built to keep as much of the money as the network allows: reclaim the rent your dead bags are sitting on, swap at 0.75% flat, then send to your exchange at 0.000005 SOL with nothing added on top.

Each step is the cheapest version of itself, so the number that lands in your exchange account is the largest one available. That's the point of building it this way.

## How the seal actually works

Enough to judge the design. Not enough to clone the product.

**The sealer cannot be influenced by the thing it seals.** Attestation runs as its own process. It watches the scanner's output *read-only* and writes each call to Solana as a signed memo from a wallet that does nothing else. The scanner has no ability to edit, delay, or veto a seal, because it has no write access to the sealing path at all. A record the caller can quietly suppress is not a record — so the caller was never given the ability.

**The memo is the whole claim, and it's tiny on purpose.** Ticker, market cap, timestamp, which detector fired. No prose, no interpretation, nothing that could be spun later. It costs a fraction of a cent to write and it is final the moment a validator includes it. Cheap enough to do thousands of times, permanent enough that doing it thousands of times is a commitment.

**Nothing is trusted twice.** Prices for a bonding-curve coin are read from the curve account itself rather than an index of it. Ownership and balances are read from the chain, never from browser storage — an earlier version trusted local state, showed a position from a *reverted* purchase, and that class of bug was removed at the root rather than patched. Cost basis is reconstructed from the wallet's own transaction history; where the chain can't prove a number, the app prints "unknown" instead of a guess.

**The statistics are built to be unflattering.** Outcomes are only measured on matured windows, because sampling a call too early inflates it. Peak *and* final multiples are both reported, since peak-only reporting hides every loser. A model that failed out-of-sample validation was shelved rather than shipped. None of that makes the numbers prettier — it makes them survivable when somebody checks.

**Things that were broken, found on-chain, and fixed:** a fee configuration that a program's deployed code rejected despite the docs permitting it; compute budgets sized with no headroom, so a route that ran hot at execution reverted; token accounts under a newer token standard being silently skipped by tooling written for the older one; a market-data call that returned corrupted values when batched too aggressively. Every one was caught by testing against mainnet rather than trusting a document, and every one is now a comment in the codebase explaining why it must never be "simplified" back.

That is the standard the record is built on. The parts that decide *what* gets called stay private — but the parts that decide whether you can believe the output are described above, and the tool in this repository lets you test all of it.

## What is deliberately NOT in this repository

The scanner engine — the smart-money detection, the wallet clustering, the filters and gates that decide *what* gets called — is not here and won't be. Neither is the app's trading pipeline: how routes are built, how fees are attached, how transactions are landed. This repo exists so the **record** can be audited by anyone, which is a different thing from open-sourcing the product.

That distinction is the point: our claim isn't "our code is clever." It's "our history is unfakeable, and here is the tool that proves it."

And the record itself cannot be copied. Anyone can fork this repository, run it, and audit us — but a competitor who starts sealing calls today starts at zero today. The one asset that matters here is time already spent on-chain, and that is the one thing nobody can backfill.

## Consuming the feed programmatically

The same sealed calls this repository audits are available as an API — because a signal stream whose history is provably honest is worth more to a machine than to a human.

```
GET https://blossomscanner.dev/api/signals
```

**Sample tier — free, no key.** The last few signals, deliberately delayed. It exists so an integrator can verify the schema and the shape of the data before talking to anyone. It is intentionally too late to trade on; the delay is the point.

**Firehose tier — zero delay, by key.** Every call the instant it is sealed, with the signature attached so your system can verify each one against the chain before acting on it. Built for trading agents, terminals, dashboards, and research.

An autonomous trading agent — [@bankrbot](https://x.com/bankrbot) — ran its own verification against this endpoint and published the result publicly: schema match, signature structure parsing cleanly, delivery clean. That happened without our involvement, which is the entire idea. Integration discussions are ongoing.

**Interested in a key, an integration, or a partnership?** Reach [@blossomScanner](https://x.com/blossomScanner) on X. We price latency and provenance. We never promise returns — the distribution in this repo is exactly why.

## Support the build

The scanner seals a call to Solana every few minutes, around the clock. The infrastructure that keeps it honest — the attestation wallet's transaction fees, the RPC bills, the servers — costs real money, and the feed is free.

If this tool proved something to you, or the free feed made you money, you can send SOL here:

```
6jvPJN5riL6ytkPZwx3hTZQYS5R6KVyTLpGKhPztY67x
```

Nothing is gated behind it — the feed is free, the record is public, and this auditor works whether you donate or not. Donations keep the attestor funded so the record never has a gap.

## Links

- App and live feed — https://blossomscanner.dev
- Full track record — https://blossomscanner.dev/track-record
- Free call feed — https://t.me/blossomscanner
- The wallet — https://solscan.io/account/954wdksZqnk9RQRJpgq564omv5aAiLfTG8Fqqb5y6AD9

## Attribution

The MIT license covers **this verification script** — read it, fork it, audit us with it, build your own tooling on it.

It does not grant use of the Blossom Scanner name, branding, or track record to represent another product. The attestation wallet's history belongs to the project that created it, call by call, in public, over time. Verify it freely; don't claim it.

## Every claim on this page, and how to check it yourself

| we say | check it |
|---|---|
| calls are sealed before their outcomes | `node verify.js` — reads the memos and the validator block times off Solana |
| ~9,400 of them, and counting | the same command; the wallet is public |
| we publish our losers | `node verify.js --outcomes 50` — prints the rug bucket first |
| most of our calls go nowhere | same command; our median call sits near break-even |
| swap is 0.75%, reclaim is 1% | the fee accounts are public on-chain — read what actually arrived |
| the app never holds your money | connect a wallet and look: no deposit exists to make |
| Phantom charges 0.85% on select pairs | their own help centre, read 16 Aug 2026 — go read it again today |
| fresh coins are tradeable here first | paste a ten-minute-old CA into both and see which one quotes |

Not one of those asks for the benefit of the doubt.

That is the whole business model, honestly: in a market where anyone can screenshot a win and delete a loss, the only durable advantage left is being the one project that **cannot** do either — and then handing everybody the tool to hold us to it.

MIT licensed. Fork it, break it, prove us wrong if you can.
