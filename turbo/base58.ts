/**
 * Dependency-free base58 (Bitcoin alphabet) + base64 helpers.
 *
 * Exists so the transaction path never has to touch `Buffer`, `bn.js`,
 * `bs58` or `@solana/web3.js`. Jupiter already returns a fully-formed,
 * serialized transaction; Phantom can sign it as-is when handed base58 via
 * `provider.request({ method: "signAndSendTransaction" })`. Deserializing it
 * first was the *only* reason web3.js sat on the critical path — and it dragged
 * in the CommonJS Buffer chain that crashed the app before any wallet call.
 *
 * Pure Uint8Array + atob/btoa: works identically in the browser, in SSR and in
 * a Cloudflare Worker, with no polyfill and no bundler configuration.
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** base64 → bytes (no Buffer). */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** bytes → base64 (no Buffer). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

/** bytes → base58. Standard big-integer base conversion over byte digits. */
export function bytesToBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";

  // Leading zero bytes map to leading '1's and must be preserved.
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;

  // Starts EMPTY, not [0]. Seeded with a zero, an all-zero input never enters
  // the loop below, so that seed survives and emits one extra '1' — 32 zero
  // bytes encoded to 33 ones. The seed is unnecessary anyway: the first
  // iteration's inner loop is a no-op and the carry is pushed directly.
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) out += ALPHABET[digits[i]!];
  return out;
}

/** base58 → bytes. */
export function base58ToBytes(value: string): Uint8Array {
  if (value.length === 0) return new Uint8Array(0);

  let zeros = 0;
  while (zeros < value.length && value[zeros] === "1") zeros += 1;

  // Starts EMPTY, not [0] — see bytesToBase58 above for the same fault. With a
  // zero seed, "111…1" (all leading ones, no numeric part) skipped the loop and
  // returned zeros+1 bytes. SystemProgram is exactly that string, which is how
  // a 33-byte account key reached a transaction and the wallet reported
  // "Reached end of buffer unexpectedly".
  //
  // Safe because leading '1's are stripped above, so the first character
  // processed here is never '1' and therefore never index 0 — the case where an
  // empty accumulator would drop a digit.
  const bytes: number[] = [];
  for (let i = zeros; i < value.length; i += 1) {
    const index = ALPHABET.indexOf(value[i]!);
    if (index < 0) throw new Error(`Invalid base58 character "${value[i]}"`);
    let carry = index;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[zeros + i] = bytes[bytes.length - 1 - i]!;
  return out;
}

/** Jupiter hands back base64; Phantom's request API wants base58. */
export function base64ToBase58(base64: string): string {
  return bytesToBase58(base64ToBytes(base64));
}

/**
 * Extracts the MESSAGE from a serialized Solana transaction.
 *
 * Phantom's `request({ method: "signAndSendTransaction" })` expects
 * `params.message` to be `bs58.encode(transaction.serializeMessage())` — the
 * message ONLY. Passing the full serialized transaction (signature section
 * included) is malformed and Phantom answers "Request blocked".
 *
 * Wire format:  [compact-u16 signature count][64 bytes per signature][message]
 * Jupiter returns the transaction with empty signature placeholders, so the
 * message begins right after that fixed-size block.
 */
export function extractTransactionMessage(txBytes: Uint8Array): Uint8Array {
  let offset = 0;
  let count = 0;
  let shift = 0;

  // compact-u16 (shortvec) decode of the signature count
  for (;;) {
    const byte = txBytes[offset];
    if (byte === undefined) throw new Error("Malformed transaction: truncated signature count.");
    offset += 1;
    count |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 21) throw new Error("Malformed transaction: invalid signature count.");
  }

  const start = offset + count * 64;
  if (start > txBytes.length) throw new Error("Malformed transaction: signatures exceed length.");
  return txBytes.slice(start);
}

/** Serialized transaction (base64) → base58 of its message, for Phantom. */
export function base64TxToBase58Message(base64: string): string {
  return bytesToBase58(extractTransactionMessage(base64ToBytes(base64)));
}
