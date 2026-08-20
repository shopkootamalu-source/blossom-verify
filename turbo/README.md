# Turbo Wallet — the vault, published

This is the actual signing core of the Blossom Turbo Wallet, a browser burner
trading wallet: a non-extractable WebCrypto Ed25519 key in IndexedDB that
places Jupiter buys and sells with no wallet popups, and sweeps back to
Phantom in one tap.

It is published because a wallet that asks for trust without showing its code
has not earned any.

```
turbo-vault.ts   key lifecycle: create, backup ceremony, restore, sign, burn
turbo-guard.ts   the allow-list simulator every signature must pass
turbo-log.ts     hash-chained local lifecycle log the user can export
guardtest.mts    37 hostile transactions, run them yourself
base58.ts        no dependency, so the encoding can be checked too
sender.ts        the tip accounts the guard allows (constants only)
```

## Run the hostile suite

```
node --experimental-strip-types guardtest.mts
```

Requires `@solana/web3.js` on the path (it compiles the attack transactions).
It prints one line per test and exits non-zero if any attack survives.

The suite is not decoration. Each test is a transaction that would take
somebody's money, compiled for real and fed to the same `assessTurboMessage`
the app calls: a drain to a stranger, a delegate approval, a `setAuthority`,
a close whose rent goes elsewhere, a durable-nonce sign-now-drain-later, a fee
bomb, a second signer smuggled into the message, a drain hidden behind an
address lookup table, a wSOL laundering chain, and a spend that bleeds out
across several individually-innocent transfers. It also asserts the guard
ACCEPTS the real ape, sell, sweep and close shapes — a guard that blocks the
product is also a bug.

## What the security model actually is

Stated precisely, because the useful version of this is never the marketing
version:

1. **After setup, the stored key cannot be EXPORTED by any script.** The
   browser enforces non-extractability. Verified empirically, not assumed:
   `probeTurboSupport()` mints a key, signs with it, and requires export to
   THROW before the feature will render at all.
2. **During create and restore the private key is in page memory and on
   screen.** Those are the highest-risk moments in the design and no copy
   anywhere pretends otherwise.
3. **Non-extractability prevents key THEFT, not key USE.** Any script running
   on the origin can open IndexedDB and sign with the key handle. The signing
   funnel is a review point for our behaviour, not a boundary against an
   attacker. **The bound on loss is the size of the float.**
4. **Whoever serves the origin's JavaScript can drain the float** — us, the
   hosting platform, or anyone who compromises either. That is true of every
   web-based wallet. We name it instead of hiding it.
5. **No weaker fallback exists.** A runtime that fails the probe gets no
   wallet at all, permanently, rather than a silently downgraded one.

The recovery code handed to the user at creation IS the private key, in the
same base58 64-byte format Phantom imports — so rescue never depends on this
app, or on us, continuing to exist.

## What the guard does and does not bound

It fully deserializes the exact bytes that will be signed, resolves every
address lookup table first (a static view can look benign while the executed
transaction drains), and judges every top-level instruction against a closed
allow-list. It refuses anything unrecognised rather than shrugging.

It bounds TOP-LEVEL instructions only. Jupiter's router is trusted wholesale —
value moved inside its CPI is invisible here — and a compromised quote source
is out of scope. What it does guarantee: no top-level instruction can move SOL
to a stranger, grant standing authority that survives a burn, defer execution
past blockhash expiry, or inflate fees past a cap.

## Honest scope of this publication

This is the code we WROTE. Binding what a user's browser actually RUNS to this
repository requires the frozen, hash-published cross-origin vault iframe on the
roadmap. Until that ships, treat this as an auditable statement of intent and
design, not a proof of delivery — and keep the float small.
