/**
 * Turbo guard — the allow-list simulator that stands between a built
 * transaction and the turbo wallet's signature. Phase 4 of
 * docs/turbo-wallet.md; the spec is the adversarial panel's, verbatim.
 *
 * WHY IT EXISTS: the naive check ("fee payer must be turbo") auto-signs a
 * SystemProgram.transfer that drains the entire float — a drain IS a
 * transaction with turbo as fee payer. So nothing is judged by who pays;
 * every instruction is judged by WHAT IT DOES, against a closed allow-list,
 * over the RESOLVED account set (lookup tables expanded first — a static
 * view can look benign while the executed transaction drains).
 *
 * WHAT IT IS NOT: a security boundary against a hostile origin. Any script on
 * the page can reach the key handle without ever calling this module. The
 * guard exists so that OUR signing behaviour is reviewable in one place and
 * cannot be widened by accident — an honesty mechanism, same family as the
 * attestation wallet. The bound against a hostile origin remains the float.
 *
 * SINGLE-SOURCE RULE: callers pass the exact serialized MESSAGE BYTES they
 * will sign. This module deserializes those bytes itself; nothing is
 * re-compiled between inspection and signature.
 *
 * FAIL-CLOSED RULE: anything unrecognized — program, opcode, lookup table
 * that will not resolve — is a rejection, never a shrug. If Jupiter ever
 * changes shape and a legitimate ape is refused, we widen the list
 * deliberately, in review, with a test. Losing a fill beats losing a float.
 * (Known deliberate refusals: top-level SPL transfers — a buy moves tokens
 * inside Jupiter's CPI, never top-level — and Token-2022
 * TransferCheckedWithFee (26), so taxed-token apes lose the fill by design.)
 *
 * TRUST ASSUMPTION, STATED (impl-review finding): lookup tables are resolved
 * through the same RPC proxy that quoted and built the transaction. Against a
 * compromised proxy the ALT check is circular — that adversary is in the same
 * trust domain as the transaction source itself, and the float remains the
 * bound. The check exists to catch poisoned BUILDS, not a poisoned chain view.
 *
 * SCOPE, STATED (impl-review finding): the guard bounds top-level
 * instructions only. Jupiter's router is trusted wholesale — every value
 * movement inside its CPI is invisible here, and `maxSpendLamports` bounds
 * only top-level System transfers, not what the swap itself routes. A
 * compromised quote source is therefore OUT OF SCOPE, and the float is the
 * bound. What this module does guarantee: no top-level instruction can move
 * SOL to a stranger, grant standing authority, defer execution, or inflate
 * fees past the cap.
 */
import { PublicKey, VersionedMessage } from "@solana/web3.js";

import { base58ToBytes } from "./base58.ts";
import { SENDER_TIP_ACCOUNTS } from "./sender.ts";

// ---------------------------------------------------------------------------
// The closed world. Every id spelled out; nothing inherited from config.
// ---------------------------------------------------------------------------

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const JUPITER_V6_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

/** Worst-case total fee (base + compute price × limit) a turbo tx may carry. */
export const TURBO_FEE_CAP_LAMPORTS = 5_000_000; // 0.005 SOL
/** A Sender tip transfer may not exceed this (Sender Max is 1_000_000). */
export const TURBO_TIP_CAP_LAMPORTS = 2_000_000;
/** UI blocks Quick Ape above this balance until the user sweeps. */
export const TURBO_FLOAT_CEILING_LAMPORTS = 1_500_000_000; // 1.5 SOL
/** UI warns above this balance. */
export const TURBO_FLOAT_WARN_LAMPORTS = 1_000_000_000; // 1.0 SOL

const BASE_FEE_LAMPORTS = 5_000;

export type TurboVerdict = { ok: true } | { ok: false; reason: string };

export type TurboGuardContext = {
  /** The turbo wallet address — sole signer and fee payer. */
  turboAddress: string;
  /** The user's Phantom address — the only foreign SOL destination allowed. */
  sweepAddress: string | null;
  /**
   * Resolve a lookup table to its FULL ordered address list, or null if it
   * cannot be resolved. Callers back this with the RPC; tests with fixtures.
   */
  resolveLookupTable: (tableAddress: string) => Promise<string[] | null>;
  /**
   * The lamports the user intends to spend. When set, the SUM of all System
   * transfers in the transaction is capped at this plus one tip plus slack —
   * many small allowed-destination transfers can no longer bleed the float
   * (impl-review finding: no aggregate bound).
   */
  maxSpendLamports?: number;
};

/** The turbo wallet's associated wSOL account — the only wrap destination. */
export function wsolAtaOf(owner: string): string {
  const [ata] = PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBytes(), new PublicKey(TOKEN_PROGRAM).toBytes(), new PublicKey(WSOL_MINT).toBytes()],
    new PublicKey(ATA_PROGRAM),
  );
  return ata.toBase58();
}

// DataView, not bitwise OR: `a | (d << 24)` coerces to SIGNED int32, so a
// crafted high-bit value (e.g. a 0x80000000 compute-unit limit) would read
// NEGATIVE and slide under the fee cap. Unsigned by construction instead.
// Length-guarded (impl-review finding): DataView throws RangeError on a short
// buffer and BigInt(undefined) throws TypeError — a crafted 1-byte instruction
// must produce a VERDICT, not an exception. Throwing here is caught by the
// caller's malformed-data net, so either way the answer is a rejection.
const readU32 = (data: Uint8Array, offset: number): number => {
  if (data.length < offset + 4) throw new Error("truncated instruction data");
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
};

const readU64 = (data: Uint8Array, offset: number): bigint => {
  if (data.length < offset + 8) throw new Error("truncated instruction data");
  let value = 0n;
  for (let i = 7; i >= 0; i -= 1) value = (value << 8n) | BigInt(data[offset + i]!);
  return value;
};

type FlatInstruction = { programId: string; accounts: string[]; data: Uint8Array };

/**
 * Deserialize the exact message bytes and flatten every instruction against
 * the FULLY RESOLVED account list. Runtime account ordering for v0 messages:
 * static keys, then every table's writable addresses in table order, then
 * every table's readonly addresses in table order.
 */
async function flatten(
  messageBytes: Uint8Array,
  ctx: TurboGuardContext,
): Promise<{ instructions: FlatInstruction[]; signerCount: number; feePayer: string } | { error: string }> {
  let message: VersionedMessage;
  try {
    message = VersionedMessage.deserialize(messageBytes);
  } catch {
    return { error: "not a parseable transaction message" };
  }

  const staticKeys = message.staticAccountKeys.map((key) => key.toBase58());
  const writable: string[] = [];
  const readonly: string[] = [];

  if (message.version === 0) {
    for (const lookup of message.addressTableLookups) {
      const table = await ctx.resolveLookupTable(lookup.accountKey.toBase58());
      if (!table) return { error: `lookup table ${lookup.accountKey.toBase58()} did not resolve` };
      for (const index of lookup.writableIndexes) {
        const address = table[index];
        if (!address) return { error: "lookup index outside table" };
        writable.push(address);
      }
      for (const index of lookup.readonlyIndexes) {
        const address = table[index];
        if (!address) return { error: "lookup index outside table" };
        readonly.push(address);
      }
    }
  }

  const keys = [...staticKeys, ...writable, ...readonly];

  const instructions: FlatInstruction[] = message.compiledInstructions.map((ix) => ({
    programId: keys[ix.programIdIndex] ?? "<out of range>",
    accounts: ix.accountKeyIndexes.map((index) => keys[index] ?? "<out of range>"),
    data: ix.data instanceof Uint8Array ? ix.data : base58ToBytes(String(ix.data)),
  }));

  return {
    instructions,
    signerCount: message.header.numRequiredSignatures,
    feePayer: staticKeys[0] ?? "",
  };
}

/**
 * The verdict. Called with the exact bytes that will be signed on approval.
 */
export async function assessTurboMessage(
  messageBytes: Uint8Array,
  ctx: TurboGuardContext,
): Promise<TurboVerdict> {
  const flat = await flatten(messageBytes, ctx);
  if ("error" in flat) return { ok: false, reason: flat.error };

  // Exactly ONE signer, and it is turbo. This kills co-signing traps and
  // makes fee payer == turbo structurally true rather than checked.
  if (flat.signerCount !== 1) return { ok: false, reason: `${flat.signerCount} signers required — turbo signs alone` };
  if (flat.feePayer !== ctx.turboAddress) return { ok: false, reason: "fee payer is not the turbo wallet" };

  const allowedSolDestinations = new Set<string>([
    ctx.turboAddress,
    wsolAtaOf(ctx.turboAddress),
    ...(ctx.sweepAddress ? [ctx.sweepAddress] : []),
  ]);
  const tipAccounts = new Set<string>(SENDER_TIP_ACCOUNTS);

  // Missing SetComputeUnitLimit does NOT mean 200k: the runtime grants
  // 200k PER INSTRUCTION up to 1.4M (impl-review finding — the old flat
  // default under-counted the fee bound by up to 7x). Assume the worst.
  let computeUnitLimit = BigInt(Math.min(flat.instructions.length * 200_000, 1_400_000));
  let computeUnitPriceMicro = 0n;
  let totalTransferLamports = 0n;
  let tipCount = 0;
  let sawLimit = false;
  let sawPrice = false;

  for (const [position, ix] of flat.instructions.entries()) {
    const at = `instruction ${position}`;

    try {
    switch (ix.programId) {
      case COMPUTE_BUDGET_PROGRAM: {
        if (ix.data.length < 1) return { ok: false, reason: `${at}: empty ComputeBudget data` };
        const opcode = ix.data[0];
        if (opcode === 1) break; // RequestHeapFrame — harmless
        if (opcode === 2) {
          // Duplicates are refused rather than last-wins: two limit
          // instructions let a crafted build show the guard one value and the
          // runtime another (impl-review finding).
          if (sawLimit) return { ok: false, reason: `${at}: duplicate SetComputeUnitLimit` };
          sawLimit = true;
          computeUnitLimit = BigInt(readU32(ix.data, 1));
          break;
        }
        if (opcode === 3) {
          if (sawPrice) return { ok: false, reason: `${at}: duplicate SetComputeUnitPrice` };
          sawPrice = true;
          computeUnitPriceMicro = readU64(ix.data, 1);
          break;
        }
        return { ok: false, reason: `${at}: ComputeBudget opcode ${opcode} is not allowed` };
      }

      case SYSTEM_PROGRAM: {
        const opcode = readU32(ix.data, 0);
        if (opcode === 4) {
          // AdvanceNonceAccount — durable nonces defeat blockhash expiry:
          // sign now, drain later, drain future deposits after burn.
          return { ok: false, reason: `${at}: durable-nonce transactions are refused` };
        }
        if (opcode !== 2) {
          // Not Transfer. CreateAccount/Allocate/Assign have no place in an
          // ape built through our own pipeline — fail closed, widen in review.
          return { ok: false, reason: `${at}: System opcode ${opcode} is not allowed` };
        }
        const destination = ix.accounts[1] ?? "";
        const lamports = readU64(ix.data, 4);
        totalTransferLamports += lamports;
        if (tipAccounts.has(destination)) {
          tipCount += 1;
          if (tipCount > 1) return { ok: false, reason: `${at}: more than one tip transfer` };
          if (lamports > BigInt(TURBO_TIP_CAP_LAMPORTS)) {
            return { ok: false, reason: `${at}: tip of ${lamports} lamports exceeds the cap` };
          }
          break;
        }
        if (!allowedSolDestinations.has(destination)) {
          return { ok: false, reason: `${at}: SOL transfer to ${destination.slice(0, 8)}… is not allowed` };
        }
        break;
      }

      case TOKEN_PROGRAM:
      case TOKEN_2022_PROGRAM: {
        if (ix.data.length < 1) return { ok: false, reason: `${at}: empty token instruction data` };
        const opcode = ix.data[0];
        // Allowed: SyncNative(17) and CloseAccount(9) with rent to turbo.
        // Top-level Transfer(3)/TransferChecked(12) were allowed in v1 and the
        // implementation review correctly killed them: with no destination
        // check they were a wSOL/position drain the System allow-list could
        // not see. A buy moves tokens inside Jupiter's CPI, never top-level —
        // so there is nothing legitimate to allow. Approve(4/13),
        // SetAuthority(6) and every mint op grant standing rights: refused.
        if (opcode === 17) break;
        if (opcode === 9) {
          const rentDestination = ix.accounts[1] ?? "";
          if (rentDestination !== ctx.turboAddress) {
            return { ok: false, reason: `${at}: closeAccount rent to ${rentDestination.slice(0, 8)}… — only turbo` };
          }
          break;
        }
        return { ok: false, reason: `${at}: token opcode ${opcode} is not allowed` };
      }

      case ATA_PROGRAM: {
        // Create (no data / [0]) or CreateIdempotent ([1]); payer and owner
        // must both be turbo, or the ape is planting accounts for someone.
        const opcode = ix.data.length === 0 ? 0 : ix.data[0];
        if (opcode !== 0 && opcode !== 1) {
          return { ok: false, reason: `${at}: ATA opcode ${opcode} is not allowed` };
        }
        if (ix.accounts[0] !== ctx.turboAddress || ix.accounts[2] !== ctx.turboAddress) {
          return { ok: false, reason: `${at}: ATA create must be paid by and owned by turbo` };
        }
        break;
      }

      case JUPITER_V6_PROGRAM:
      case MEMO_PROGRAM:
        break;

      default:
        return { ok: false, reason: `${at}: program ${ix.programId.slice(0, 8)}… is not on the allow-list` };
    }
    } catch {
      // A read past the end of crafted instruction data is an attack shape,
      // not an exception: the guard must always produce a verdict.
      return { ok: false, reason: `${at}: malformed instruction data` };
    }
  }

  const worstCaseFee =
    BigInt(BASE_FEE_LAMPORTS) + (computeUnitLimit * computeUnitPriceMicro) / 1_000_000n;
  if (worstCaseFee > BigInt(TURBO_FEE_CAP_LAMPORTS)) {
    return { ok: false, reason: `worst-case fee ${worstCaseFee} lamports exceeds the ${TURBO_FEE_CAP_LAMPORTS} cap` };
  }

  if (ctx.maxSpendLamports !== undefined) {
    const ceiling = BigInt(ctx.maxSpendLamports) + BigInt(TURBO_TIP_CAP_LAMPORTS) + 100_000n;
    if (totalTransferLamports > ceiling) {
      return {
        ok: false,
        reason: `transfers total ${totalTransferLamports} lamports — over the ${ceiling} spend ceiling`,
      };
    }
  }

  return { ok: true };
}

/** Re-exported for the UI so the doctrine and the mechanism share numbers. */
export function floatStatus(lamports: number): "ok" | "warn" | "blocked" {
  if (lamports > TURBO_FLOAT_CEILING_LAMPORTS) return "blocked";
  if (lamports > TURBO_FLOAT_WARN_LAMPORTS) return "warn";
  return "ok";
}
