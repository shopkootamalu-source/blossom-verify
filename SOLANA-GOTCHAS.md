# Nine Solana bugs that cost us weeks

Every one of these was found on mainnet, with real money, after the documentation said we were doing it right. None of them threw a useful error. Most of them failed *silently*, which is worse.

We run [Blossom Scanner](https://blossomscanner.dev) — a Solana trading terminal where every signal is sealed on-chain before its outcome exists. Getting it to work meant walking into each of these walls face-first. Here they are, so you don't have to.

Each entry: what we expected, what actually happened, how to detect it, and what fixed it.

---

## 1. Token-2022 accounts vanish from your close loop

**The trap:** pump.fun mints are **Token-2022**, not the original SPL Token program. If you're building anything that closes token accounts — a rent-reclaim tool, a wallet cleaner, a batch sweeper — and you build your close instruction against the legacy Token program, Token-2022 accounts are silently skipped. No error. They just don't close.

**How bad:** on one real wallet we found the loop was closing **8 of 34 accounts**. The other 26 were Token-2022 and the tool reported success anyway. Every user of a tool with this bug is being handed a fraction of their SOL back and told the job is done.

**Detect it:** for each token account, read the account's `owner` field (the *program* that owns the account, not the wallet). Compare against both program IDs:

```
TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA   (SPL Token, legacy)
TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb   (Token-2022)
```

If they don't match your close instruction's program, you're dropping accounts.

**Fix:** group accounts by their owning program and emit close instructions against the matching program per group. Don't assume one program for the whole wallet.

**Also:** count what you closed and compare it to what you found. A close loop that can't report `closed N of M` is a close loop that's lying to you.

---

## 2. Your compute budget is not yours alone

**The trap:** you simulate a transaction, get the consumed units, set `SetComputeUnitLimit` to roughly that, and ship. It works in testing and fails intermittently in production with `ComputationalBudgetExceeded`.

**Why:** wallets can *append instructions at signing time* — most notably Lighthouse assertion instructions, which several wallets add to protect users. Those instructions consume compute units that were never in your simulation. If you sized your ceiling exactly, you just went over it.

**Detect it:** compare the instruction count of the transaction you built against the one that actually landed on-chain (Solscan shows it). If there are extra instructions you didn't add, that's the cause.

**Fix:** leave headroom. We raise the CU ceiling by ~50% at transaction construction, with a floor of +60,000 units and a hard cap at the network maximum. Unused CU is *not* charged — you only pay for consumed units, so the headroom is free. Sizing your limit exactly to simulation is a false economy.

**And do it at the right place:** we first patched this at the send call and still saw failures, because one code path handed the transaction straight to the wallet and skipped our patch. Raise the ceiling where the transaction is *born*, not where it's sent.

---

## 3. A platform fee the docs allow, the program rejects

**The trap:** aggregator documentation may describe a platform fee on the input side of an ExactIn swap. We implemented it exactly as written. On mainnet, the swap program rejected it — `Custom: 6014`, which decodes to an incorrect-token-program error.

**Detect it:** it will *quote* fine. The break happens at execution, so any test that stops at quoting will pass. You have to land a real transaction.

**Fix:** collect fees on the output side, and where the output token uses a different token program, make sure your fee account is derived for *that* program. Two rules that saved us:

1. **A quote succeeding is not a swap succeeding.** Test the landed transaction, always.
2. When docs and mainnet disagree, mainnet is right. Write the workaround down with the date, because docs change.

---

## 4. Market-data batching that corrupts prices instead of failing

**The trap:** a popular market-data endpoint accepts a comma-separated list of token addresses. Naturally you batch 30 to save requests. The endpoint returns roughly **30 pairs total for the whole request** — not 30 per token.

**Why it's dangerous:** you don't get an error. You get *one arbitrary pool per token*, often a thin one, and thin pools give absurd prices. Your app now displays confidently wrong market caps.

**Detect it:** batch one token and 30 tokens and compare the pair counts you get back per token. If they differ, you've been silently truncated all along.

**Fix:** batch small (we use 4) and, for each mint, select the pool with the **highest liquidity** rather than whatever came first. Then defend downstream: if you keep a running maximum of anything (a peak price, an all-time high), one bad sample poisons it permanently. Bound your inputs before they reach anything monotonic.

---

## 5. Legacy transactions sort account keys. v0 transactions do not.

**The trap:** if you hand-write transaction bytes (we do, to keep the bundle small), it is easy to carry legacy-transaction habits into versioned ones. Legacy transaction serialization sorts account keys in a defined order. **v0 does not** — the order comes from the message and must be preserved exactly.

**Symptom:** `Reached end of buffer` or a signature that verifies against nothing. Rejected before it reaches a validator.

**Detect it:** build the same transaction twice — once by hand, once with the reference library — and diff the raw bytes. The first differing offset tells you exactly which field you got wrong. This one technique found four separate encoding bugs for us.

**Fix:** diff against the reference implementation. Every time.

---

## 6. base58 gets longer when your bytes get smaller

**The trap:** base58 encodes each leading zero byte as a literal `1` character. An all-zero 32-byte array does not encode to something short — it encodes to 32 ones. If you have any length assumption around encoded keys or signatures, an edge case with leading zeros will break it.

**Fix:** never infer byte length from encoded-string length. Decode, then measure.

---

## 7. `confirmed` blockhashes get your transaction "blocked"

**The trap:** you fetch a blockhash at `confirmed` commitment because it's faster. Sometimes the wallet then shows a scary "unable to simulate" or "request blocked" warning to your user — not on every transaction, just often enough to erode trust.

**Why:** the simulating party may not have caught up to that blockhash yet. Your transaction is fine; the simulation ran against a view of the chain where the blockhash doesn't exist yet.

**Fix:** build with a **finalized** blockhash. It costs a little freshness and buys a clean confirmation sheet. If you're re-preparing transactions in a loop for responsiveness, refresh them on a timer (we use 45 seconds) rather than reaching for a faster commitment.

---

## 8. Never let local state decide what a user owns

**The trap:** you cache a user's position after a buy so the UI feels instant. The transaction later reverts. Your app now confidently tells the user they hold something they do not.

**How we found it:** a reverted purchase displayed as a held position. The user nearly acted on it. This is the bug in this list that could actually cost somebody money, and it was entirely self-inflicted.

**Fix:** the chain is the only source of truth for ownership and balances. Read positions from the wallet, not from browser storage. Where the chain genuinely can't tell you something — an average cost basis across untracked transfers, say — print `unknown`. A guess dressed as a fact is worse than an absence.

---

## 9. Public RPCs prune history and won't tell you

**The trap:** you walk `getSignaturesForAddress` with pagination until it returns fewer rows than you asked for, and treat that as the beginning of the account's history. On most public endpoints it is not — it's just as far back as *that node* retains.

**Why it matters:** any tool that counts an account's lifetime activity will silently under-report, and the number looks authoritative because it came from the chain.

**Detect it:** run the same walk against an archival endpoint and compare the oldest timestamp you reach.

**Fix:** know the difference between "the account has no more history" and "this node has no more history," and say which one you're showing. Our own auditor ([`verify.js`](./verify.js) in this repo) hits this: on a default public RPC it rebuilds only the most recent slice of our record, so it detects the gap, prints both numbers, and points you at an archival endpoint. Under-reporting yourself on purpose is cheaper than being caught over-reporting by accident.

---

## The pattern behind all nine

Not one of these announced itself. The docs were confident, the tests passed, the UI looked fine, and the numbers were wrong. What actually surfaced them:

- **Test the landed transaction, not the quote.** Simulation and reality diverge exactly where it costs you.
- **Diff against a reference implementation** when you hand-roll anything the ecosystem has already standardised.
- **Count what you processed and compare it to what you found.** `closed 8 of 34` is a bug report; `success` is not.
- **Treat silence as failure.** The dangerous bugs here never threw. They returned partial data with a confident face.

---

## Why we published this

Because our entire product is the claim that a record can be checked rather than trusted, and knowledge behaves the same way. These are general Solana platform gotchas — every one of them is waiting for anyone building trading, reclaim, or portfolio tooling. Keeping them private would have bought us a few weeks of other people's pain and no durable advantage.

What is **not** here, and won't be: the scanner engine — the detection, the wallet clustering, the filters and gates that decide *what* gets called — and the app's trading pipeline. That distinction is deliberate. These are the walls; the map isn't ours to give away.

Also worth stating plainly: the tool in this repository lets you audit our track record yourself, losers included. If you're going to take engineering advice from a project, take it from one whose numbers you can check.

---

## If this saved you a week

The scanner seals a call to Solana every few minutes, around the clock, and the feed is free. The transaction fees, RPC bills, and servers behind it are not.

```
6jvPJN5riL6ytkPZwx3hTZQYS5R6KVyTLpGKhPztY67x
```

Nothing is gated behind it. Send SOL if any of this earned it.

---

**Attribution:** MIT applies to the code in this repository. This document may be quoted and linked freely with attribution to [Blossom Scanner](https://blossomscanner.dev). It does not grant use of the Blossom Scanner name, branding, or track record to represent another product.

Found an error here, or hit one we missed? Open an issue — corrections get credited.

🌸 [blossomscanner.dev](https://blossomscanner.dev) · [@blossomScanner](https://x.com/blossomScanner) · [free feed](https://t.me/blossomscanner)
