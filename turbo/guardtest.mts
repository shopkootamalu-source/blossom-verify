/**
 * Hostile suite for turbo-guard: every attack the adversarial panel named,
 * as real compiled transactions, against the actual guard code.
 */
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
} from "@solana/web3.js";
import { assessTurboMessage, wsolAtaOf, type TurboGuardContext } from "./turbo-guard.ts";
import { SENDER_TIP_ACCOUNTS } from "./sender.ts";

const turbo = Keypair.generate();
const phantom = Keypair.generate();
const attacker = Keypair.generate();
const mint = Keypair.generate().publicKey;

const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const JUP = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const CB = new PublicKey("ComputeBudget111111111111111111111111111111");
const SYS = SystemProgram.programId;
const EVIL_PROGRAM = Keypair.generate().publicKey;
const BLOCKHASH = "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta";

const ctx: TurboGuardContext = {
  turboAddress: turbo.publicKey.toBase58(),
  sweepAddress: phantom.publicKey.toBase58(),
  resolveLookupTable: async () => null, // overridden per-test
};

const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
const cat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

const meta = (pubkey: PublicKey, w = false, s = false) => ({ pubkey, isWritable: w, isSigner: s });
const wsolAta = new PublicKey(wsolAtaOf(turbo.publicKey.toBase58()));

const ix = (programId: PublicKey, keys: ReturnType<typeof meta>[], data: Uint8Array) =>
  new TransactionInstruction({ programId, keys, data: Buffer.from(data) });

const cuLimit = (n: number) => ix(CB, [], cat(new Uint8Array([2]), u32(n)));
const cuPrice = (n: bigint) => ix(CB, [], cat(new Uint8Array([3]), u64(n)));
const sysTransfer = (from: PublicKey, to: PublicKey, lamports: bigint) =>
  ix(SYS, [meta(from, true, true), meta(to, true)], cat(u32(2), u64(lamports)));
const advanceNonce = () => ix(SYS, [meta(turbo.publicKey, true, true)], u32(4));
const tokTransfer = () => ix(TOKEN, [meta(wsolAta, true), meta(wsolAta, true), meta(turbo.publicKey, false, true)], cat(new Uint8Array([3]), u64(1n)));
const tokApprove = () => ix(TOKEN, [meta(wsolAta, true), meta(attacker.publicKey), meta(turbo.publicKey, false, true)], cat(new Uint8Array([4]), u64(2n ** 63n)));
const tokSetAuthority = () => ix(TOKEN, [meta(wsolAta, true), meta(turbo.publicKey, false, true)], new Uint8Array([6, 2, 1, ...attacker.publicKey.toBytes()]));
const tokClose = (dest: PublicKey) => ix(TOKEN, [meta(wsolAta, true), meta(dest, true), meta(turbo.publicKey, false, true)], new Uint8Array([9]));
const syncNative = () => ix(TOKEN, [meta(wsolAta, true)], new Uint8Array([17]));
const ataCreate = (payer: PublicKey, owner: PublicKey) =>
  ix(ATA, [meta(payer, true, payer.equals(turbo.publicKey)), meta(wsolAta, true), meta(owner), meta(mint), meta(SYS), meta(TOKEN)], new Uint8Array([1]));
const jupRoute = () => ix(JUP, [meta(turbo.publicKey, true, true), meta(wsolAta, true)], new Uint8Array([229, 23, 203, 151, 0, 0, 0, 0]));
const tip = (lamports: bigint) => sysTransfer(turbo.publicKey, new PublicKey(SENDER_TIP_ACCOUNTS[0]), lamports);

function legacy(instructions: TransactionInstruction[], payer: PublicKey = turbo.publicKey): Uint8Array {
  return new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions }).compileToLegacyMessage().serialize();
}

let pass = 0, fail = 0;
async function expect(name: string, bytes: Uint8Array, shouldPass: boolean, ctxOverride?: Partial<TurboGuardContext>) {
  const verdict = await assessTurboMessage(bytes, { ...ctx, ...ctxOverride });
  const good = verdict.ok === shouldPass;
  console.log(`${good ? "PASS" : "FAIL"}  ${name}${verdict.ok ? "" : `  [${(verdict as { reason: string }).reason.slice(0, 70)}]`}`);
  good ? pass++ : fail++;
}

// 1. The benign ape — everything a real Jupiter buy contains.
await expect("benign ape (cu, ata, wrap, sync, route, close, tip)", legacy([
  cuLimit(600_000), cuPrice(1_000n),
  ataCreate(turbo.publicKey, turbo.publicKey),
  sysTransfer(turbo.publicKey, wsolAta, 20_000_000n),
  syncNative(),
  jupRoute(),
  tokClose(turbo.publicKey),
  tip(1_000_000n),
]), true);

// 2-14. The attacks.
await expect("drain: transfer to attacker", legacy([sysTransfer(turbo.publicKey, attacker.publicKey, 500_000_000n)]), false);
await expect("sweep to phantom allowed", legacy([sysTransfer(turbo.publicKey, phantom.publicKey, 100_000_000n)]), true);
await expect("token approve (delegation)", legacy([tokApprove()]), false);
await expect("setAuthority to attacker", legacy([tokSetAuthority()]), false);
await expect("closeAccount rent to attacker", legacy([tokClose(attacker.publicKey)]), false);
await expect("durable nonce (sign now drain later)", legacy([advanceNonce(), sysTransfer(turbo.publicKey, phantom.publicKey, 1n)]), false);
await expect("fee bomb (1.4M CU x 10 SOL/M)", legacy([cuLimit(1_400_000), cuPrice(10_000_000_000n), jupRoute()]), false);
await expect("fee payer not turbo", legacy([jupRoute()], attacker.publicKey), false);
await expect("unknown program", legacy([ix(EVIL_PROGRAM, [meta(turbo.publicKey, true, true)], new Uint8Array([0]))]), false);
await expect("tip over cap", legacy([tip(50_000_000n)]), false);
await expect("ATA planted for foreign owner", legacy([ataCreate(turbo.publicKey, attacker.publicKey)]), false);
// v2: top-level token transfers are REFUSED — with no destination check they
// were a wSOL/position drain (impl-review fatal). Buys move tokens via CPI.
await expect("top-level token transfer (wSOL drain vector)", legacy([tokTransfer()]), false);
await expect("truncated ComputeBudget data (1 byte after opcode)", legacy([ix(CB, [], new Uint8Array([2, 7])), jupRoute()]), false);
// No SetComputeUnitLimit → runtime grants 200k PER instruction; 5 ix at a
// high price must be priced as 1M CU, not 200k, and refused.
await expect("missing CU limit under-count (5 ix, high price)", legacy([
  cuPrice(20_000_000n), jupRoute(), jupRoute(), jupRoute(), jupRoute(),
]), false);
await expect("two tip transfers", legacy([tip(1_000_000n), tip(1_000_000n)]), false);
// Aggregate bleed: five small transfers to ALLOWED destinations, each fine
// alone, together far over the declared 0.02 SOL spend.
await expect("aggregate bleed over declared spend", legacy([
  sysTransfer(turbo.publicKey, wsolAta, 20_000_000n),
  sysTransfer(turbo.publicKey, wsolAta, 20_000_000n),
  sysTransfer(turbo.publicKey, wsolAta, 20_000_000n),
  sysTransfer(turbo.publicKey, wsolAta, 20_000_000n),
  sysTransfer(turbo.publicKey, wsolAta, 20_000_000n),
]), false, { maxSpendLamports: 20_000_000 });
await expect("declared spend honored (wrap + tip within ceiling)", legacy([
  cuLimit(600_000), cuPrice(1_000n),
  sysTransfer(turbo.publicKey, wsolAta, 20_000_000n),
  tip(1_000_000n),
  jupRoute(),
]), true, { maxSpendLamports: 20_000_000 });

// Two signers: turbo + attacker both sign.
{
  const two = new TransactionMessage({
    payerKey: turbo.publicKey, recentBlockhash: BLOCKHASH,
    instructions: [ix(JUP, [meta(turbo.publicKey, true, true), meta(attacker.publicKey, true, true)], new Uint8Array([1]))],
  }).compileToLegacyMessage().serialize();
  await expect("second signer smuggled in", two, false);
}

// v0 + lookup table: the drain destination hidden behind a table index.
{
  const table = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [attacker.publicKey] },
  });
  const msg = new TransactionMessage({
    payerKey: turbo.publicKey, recentBlockhash: BLOCKHASH,
    instructions: [sysTransfer(turbo.publicKey, attacker.publicKey, 500_000_000n)],
  }).compileToV0Message([table]);
  const bytes = msg.serialize();
  await expect("v0 drain hidden behind lookup table (resolved)", bytes, false,
    { resolveLookupTable: async () => [attacker.publicKey.toBase58()] });
  await expect("v0 with unresolvable lookup table", bytes, false,
    { resolveLookupTable: async () => null });
}

// Regression: high-bit CU limit must read UNSIGNED (a signed bitwise read
// went negative and slid under the fee cap before the DataView fix).
await expect("high-bit CU limit (0x80000000) fee bypass", legacy([cuLimit(0x80000000), cuPrice(10_000n), jupRoute()]), false);

// v3 (impl-review round 2):
// The wSOL laundering chain the third reviewer described end-to-end — wrap the
// whole float into turbo's OWN wSOL ATA (an allowed destination), sync it, then
// ship the wSOL out. Killing top-level token transfers breaks the last link.
await expect("wSOL laundering chain (wrap -> sync -> transfer out)", legacy([
  ataCreate(turbo.publicKey, turbo.publicKey),
  sysTransfer(turbo.publicKey, wsolAta, 500_000_000n),
  syncNative(),
  tokTransfer(),
]), false);
await expect("duplicate SetComputeUnitLimit (show one, run another)", legacy([cuLimit(600_000), cuLimit(1_400_000), jupRoute()]), false);
await expect("duplicate SetComputeUnitPrice", legacy([cuPrice(1_000n), cuPrice(50_000_000n), jupRoute()]), false);
await expect("empty ComputeBudget data", legacy([ix(CB, [], new Uint8Array([])), jupRoute()]), false);
await expect("empty token instruction data", legacy([ix(TOKEN, [meta(wsolAta, true)], new Uint8Array([]))]), false);
// The sweep shape must PASS the guard now that sweep() is guarded too.
await expect("guarded sweep shape (whole balance to phantom)", legacy([
  sysTransfer(turbo.publicKey, phantom.publicKey, 99_995_000n),
]), true, { maxSpendLamports: 100_000_000 });

// SELL SHAPE — the exit path. If the guard refused this, turbo could buy but
// never sell, which is the exact trap the sell button exists to prevent.
await expect("sell: token -> SOL via Jupiter (ata, route, sync, unwrap, tip)", legacy([
  cuLimit(600_000), cuPrice(1_000n),
  ataCreate(turbo.publicKey, turbo.publicKey),
  jupRoute(),
  syncNative(),
  tokClose(turbo.publicKey),
  tip(1_000_000n),
]), true);

// A sell must still refuse a drain smuggled in beside it.
await expect("sell shape with a drain appended", legacy([
  cuLimit(600_000),
  jupRoute(),
  tokClose(turbo.publicKey),
  sysTransfer(turbo.publicKey, attacker.publicKey, 500_000_000n),
]), false);

// And must refuse a sell whose unwrap sends the rent somewhere else.
await expect("sell with unwrap rent to attacker", legacy([
  cuLimit(600_000),
  jupRoute(),
  tokClose(attacker.publicKey),
]), false);

// TOKEN-AWARE SWEEP — a batch of 8 closes, rent to turbo. If the guard
// refused this, the sweep would silently reclaim nothing.
await expect(
  "sweep: batch of 8 account closes (rent to turbo)",
  legacy(Array.from({ length: 8 }, () => tokClose(turbo.publicKey))),
  true,
);

// One foreign destination inside an otherwise clean batch must sink it.
await expect(
  "close batch with one foreign rent destination",
  legacy([tokClose(turbo.publicKey), tokClose(turbo.publicKey), tokClose(attacker.publicKey)]),
  false,
);

// v4 (2026-08-20): the cap is now a REQUIRED argument of signAndSend, and the
// three non-ape callers pass 0. These lock in that contract: with a 0 ceiling
// the guard must still accept the real shapes (the tip + 100k slack exists for
// exactly this) while refusing the wrap-the-whole-float drain that used to be
// unbounded on sell, close and sweep.
await expect("sell at maxSpend 0 still accepts the real sell shape", legacy([
  cuLimit(600_000), cuPrice(1_000n),
  ataCreate(turbo.publicKey, turbo.publicKey),
  jupRoute(),
  syncNative(),
  tokClose(turbo.publicKey),
  tip(1_000_000n),
]), true, { maxSpendLamports: 0 });

await expect("sell at maxSpend 0 REFUSES a full-float wrap", legacy([
  cuLimit(600_000),
  sysTransfer(turbo.publicKey, wsolAta, 500_000_000n),
  syncNative(),
  jupRoute(),
]), false, { maxSpendLamports: 0 });

await expect("close batch at maxSpend 0 accepted", legacy([
  tokClose(turbo.publicKey), tokClose(turbo.publicKey),
]), true, { maxSpendLamports: 0 });

await expect("close batch at maxSpend 0 REFUSES a smuggled wrap", legacy([
  tokClose(turbo.publicKey),
  sysTransfer(turbo.publicKey, wsolAta, 300_000_000n),
]), false, { maxSpendLamports: 0 });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
