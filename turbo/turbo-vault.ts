/**
 * Turbo Wallet vault — the signing core.
 *
 * A burner TRADING wallet born in this browser. The private key is imported
 * into WebCrypto as a NON-EXTRACTABLE Ed25519 key.
 *
 * THE SECURITY MODEL, STATED PRECISELY (adversarially reviewed 2026-08-19 —
 * five hostile lenses; every overclaim they found is corrected here):
 *
 *   - AFTER setup, the stored key cannot be EXPORTED by any script — ours,
 *     the host's, or an attacker's. The browser enforces non-extractability.
 *   - During CREATE and RESTORE the private key is briefly present in page
 *     memory and on screen. Those two moments are the highest-risk windows
 *     of the whole design, and no wording is allowed to hide that.
 *   - Non-extractability prevents key THEFT, not key USE. Any script running
 *     on this origin can open IndexedDB and sign with the key handle — the
 *     chokepoint below is a review point, NOT a security boundary. The real
 *     bound on loss is the FLOAT: never keep more than a snipe's worth here.
 *   - Whoever serves this origin's JavaScript (us, the hosting platform, or
 *     anyone who compromises either) could ship code that signs a drain.
 *     That is true of every web-based wallet; we say it instead of hiding it.
 *
 * The recovery code handed to the user at creation IS the private key — the
 * standard Solana 64-byte secret key in base58, THE SAME FORMAT PHANTOM
 * IMPORTS. If this app vanished tomorrow, the user pastes it into Phantom and
 * owns the funds. Rescue never depends on us existing.
 *
 * Custody: generated on-device; our servers hold nothing and no server-side
 * signing, MPC share, or operated recovery exists — permanently. The one
 * remaining trust dependency (the served JavaScript, above) is named, not
 * hidden.
 *
 * Dependency-free by construction: the vault MODULE adds zero third-party
 * code — WebCrypto + IndexedDB + the app's own base58. (A claim about this
 * module, not the app around it.) Import-safe under SSR.
 *
 * Verified empirically before this file was written: pkcs8 import of raw
 * entropy as non-extractable works in Chrome, signs 64-byte signatures,
 * export throws, the CryptoKey survives IndexedDB, the same seed restores
 * the same address, and the derivation matches web3.js (RFC 8032 vector).
 */
import { base58ToBytes, bytesToBase58 } from "./base58.ts";

export type TurboWalletInfo = {
  /** base58 Solana address (the raw 32-byte Ed25519 public key). */
  address: string;
  /** Unix ms when this vault record was created on this device. */
  createdAt: number;
  /**
   * Whether the backup ceremony COMPLETED (the full key pasted back). False
   * means the key was shown once and never proven saved — a reload
   * mid-ceremony leaves exactly this state, and there is deliberately no
   * "show it again" path. Callers must block DEPOSITS (new money into an
   * unrecoverable wallet) while false; exits stay open.
   */
  backupProved: boolean;
};

/**
 * RFC 8410 PrivateKeyInfo prefix for an Ed25519 seed. WebCrypto only imports
 * private Ed25519 keys as pkcs8, so the 32-byte seed is wrapped in this fixed
 * 16-byte header: SEQUENCE { version 0, OID 1.3.101.112, OCTET STRING(32) }.
 */
const PKCS8_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
  0x04, 0x22, 0x04, 0x20,
]);

const DB_NAME = "blossom-turbo";
const STORE = "vault";
const RECORD_KEY = "wallet";

type VaultRecord = {
  privateKey: CryptoKey; // non-extractable — the whole point
  publicKeyRaw: ArrayBuffer;
  createdAt: number;
  /**
   * Unix ms when the backup ceremony completed, null while it has not.
   * ABSENT (undefined) on records written before this field existed — those
   * are grandfathered as proved: every pre-field ACTIVE wallet got there
   * through the ceremony UI, and retroactively locking a live funded wallet
   * out of deposits would be the worse failure.
   */
  backupProvedAt?: number | null;
};

function seedToPkcs8(seed: Uint8Array): Uint8Array {
  if (seed.length !== 32) throw new Error("Seed must be exactly 32 bytes.");
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  pkcs8.set(PKCS8_ED25519_PREFIX);
  pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);
  return pkcs8;
}

/**
 * Derive the Ed25519 public key for a seed. Uses a TEMPORARY extractable
 * import purely to read the public half out of the JWK (`x`); the temporary
 * key object is dropped immediately. Runs only inside the create/restore
 * window, where the seed itself is already (unavoidably, briefly) in memory.
 */
export async function publicKeyFromSeed(seed: Uint8Array): Promise<Uint8Array> {
  const temp = await crypto.subtle.importKey("pkcs8", seedToPkcs8(seed), "Ed25519", true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", temp);
  if (!jwk.x) throw new Error("Ed25519 JWK missing public key.");
  const b64 = jwk.x.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const pub = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) pub[i] = binary.charCodeAt(i);
  if (pub.length !== 32) throw new Error("Ed25519 public key must be 32 bytes, got " + pub.length + ".");
  return pub;
}

/**
 * Encode the Phantom-importable recovery code: base58(seed || publicKey).
 * This is the exact format solana-keygen, Phantom and Solflare accept, so
 * the user's escape hatch is any mainstream wallet — never this app.
 */
export function encodeRecoveryCode(seed: Uint8Array, publicKey: Uint8Array): string {
  if (seed.length !== 32 || publicKey.length !== 32) throw new Error("Malformed key material.");
  const full = new Uint8Array(64);
  full.set(seed);
  full.set(publicKey, 32);
  return bytesToBase58(full);
}

/**
 * Decode + INTEGRITY-CHECK a recovery code. The embedded public key must match
 * the one derived from the seed — a mistyped or corrupted code is rejected
 * here instead of restoring a wallet that silently controls nothing.
 */
export async function decodeRecoveryCode(code: string): Promise<{ seed: Uint8Array; publicKey: Uint8Array }> {
  let bytes: Uint8Array;
  try {
    bytes = base58ToBytes(code.trim());
  } catch {
    throw new Error("That is not a valid recovery code.");
  }
  if (bytes.length !== 64) throw new Error("A recovery code decodes to exactly 64 bytes.");
  const seed = bytes.slice(0, 32);
  const claimed = bytes.slice(32);
  const derived = await publicKeyFromSeed(seed);
  for (let i = 0; i < 32; i += 1) {
    if (derived[i] !== claimed[i]) throw new Error("Recovery code failed its integrity check.");
  }
  return { seed, publicKey: claimed };
}

// ---------------------------------------------------------------------------
// IndexedDB — smallest possible wrapper, no library.
// ---------------------------------------------------------------------------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed."));
  });
}

async function putRecord(record: VaultRecord): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(record, RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Vault write failed."));
    });
  } finally {
    db.close();
  }
}

async function getRecord(): Promise<VaultRecord | null> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(RECORD_KEY);
      request.onsuccess = () => resolve((request.result as VaultRecord | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error("Vault read failed."));
    });
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** True in any environment where the vault can exist at all. */
export function turboSupported(): boolean {
  return typeof indexedDB !== "undefined" && typeof crypto !== "undefined" && !!crypto.subtle;
}

let probeResult: Promise<boolean> | null = null;

/**
 * EMPIRICAL feature gate (panel finding: API presence is not support). Proves
 * this runtime can (1) mint a non-extractable Ed25519 key, (2) sign with it,
 * and (3) that export genuinely THROWS — the property the whole design rests
 * on. Runtimes that fail any leg (e.g. WebKit builds without Ed25519) get NO
 * wallet — never a silently weaker fallback. There is no extractable-seed
 * fallback in this codebase, deliberately and permanently.
 */
export function probeTurboSupport(): Promise<boolean> {
  if (!turboSupported()) return Promise.resolve(false);
  probeResult ??= (async () => {
    try {
      const pair = (await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])) as CryptoKeyPair;
      const sig = await crypto.subtle.sign("Ed25519", pair.privateKey, new Uint8Array(8));
      if (new Uint8Array(sig).length !== 64) return false;
      try {
        await crypto.subtle.exportKey("pkcs8", pair.privateKey);
        return false; // export SUCCEEDED — non-extractability is not enforced here.
      } catch {
        return true;
      }
    } catch {
      return false;
    }
  })();
  return probeResult;
}

/**
 * Ask the browser to protect the vault from storage eviction, and report the
 * truth. Chrome CAN silently evict IndexedDB under pressure — for a record
 * that IS the wallet, eviction is fund loss (recoverable only via the saved
 * private key). The UI gates messaging, and callers gate deposits, on this.
 */
export async function ensurePersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    return (await navigator.storage.persisted()) || (await navigator.storage.persist());
  } catch {
    return false;
  }
}

/**
 * Create a new turbo wallet on this device.
 *
 * Returns the recovery code EXACTLY ONCE. The caller must display it, force
 * the user to confirm they saved it, and then let go — it is not stored, and
 * there is deliberately no "show it again" anywhere in this module.
 */
export async function createTurboWallet(): Promise<{ info: TurboWalletInfo; recoveryCode: string }> {
  if (await getRecord()) throw new Error("A turbo wallet already exists on this device. Burn it first.");
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = await publicKeyFromSeed(seed);
  const recoveryCode = encodeRecoveryCode(seed, publicKey);
  const privateKey = await crypto.subtle.importKey("pkcs8", seedToPkcs8(seed), "Ed25519", false, ["sign"]);
  seed.fill(0); // best-effort wipe; JS cannot guarantee zeroization and we say so.

  /**
   * RESTORE SELF-TEST before the wallet exists (panel finding): the recovery
   * code must provably round-trip to this exact address NOW — not on the day
   * the user needs it and discovers a bug. Decode it exactly the way restore
   * will, and refuse to create the wallet if the addresses disagree.
   */
  const roundTrip = await decodeRecoveryCode(recoveryCode);
  const restored = bytesToBase58(roundTrip.publicKey);
  const address = bytesToBase58(publicKey);
  roundTrip.seed.fill(0);
  if (restored !== address) throw new Error("Recovery self-test failed — wallet NOT created.");

  const createdAt = Date.now();
  // backupProvedAt starts null: the record is written BEFORE the ceremony so
  // the key object can never exist unsaved-anywhere, but the wallet is not
  // deposit-safe until the ceremony completes. A reload between here and
  // markBackupProved() leaves a wallet whose key can never be shown again —
  // the UI blocks deposits and steers to burn-and-recreate.
  await putRecord({ privateKey, publicKeyRaw: publicKey.slice().buffer, createdAt, backupProvedAt: null });
  return { info: { address, createdAt, backupProved: false }, recoveryCode };
}

/**
 * The backup ceremony completed: the user pasted the full key back. Flip the
 * durable flag. Idempotent; throws if no wallet exists.
 */
export async function markBackupProved(): Promise<void> {
  const record = await getRecord();
  if (!record) throw new Error("No turbo wallet on this device.");
  if (record.backupProvedAt) return;
  await putRecord({ ...record, backupProvedAt: Date.now() });
}

/** Restore a wallet from its recovery code (same code Phantom would accept). */
export async function restoreTurboWallet(code: string): Promise<TurboWalletInfo> {
  if (await getRecord()) throw new Error("A turbo wallet already exists on this device. Burn it first.");
  const { seed, publicKey } = await decodeRecoveryCode(code);
  const privateKey = await crypto.subtle.importKey("pkcs8", seedToPkcs8(seed), "Ed25519", false, ["sign"]);
  seed.fill(0);
  const createdAt = Date.now();
  // Restore PROVES possession of the code — that is what restore is.
  await putRecord({ privateKey, publicKeyRaw: publicKey.slice().buffer, createdAt, backupProvedAt: createdAt });
  return { address: bytesToBase58(publicKey), createdAt, backupProved: true };
}

/** The wallet on this device, or null. Never throws on a missing/broken DB. */
export async function loadTurboWallet(): Promise<TurboWalletInfo | null> {
  if (!turboSupported()) return null;
  try {
    const record = await getRecord();
    if (!record) return null;
    return {
      address: bytesToBase58(new Uint8Array(record.publicKeyRaw)),
      createdAt: record.createdAt,
      // Grandfather: undefined (pre-field record) counts as proved — see
      // VaultRecord.backupProvedAt. Only an explicit null means unproved.
      backupProved: record.backupProvedAt === undefined ? true : record.backupProvedAt !== null,
    };
  } catch {
    return null;
  }
}

/**
 * The signing funnel — a REVIEW point, not a security boundary. The panel's
 * verdict is correct and stands in this comment permanently: any same-origin
 * script can open IndexedDB itself and sign with the key handle, bypassing
 * this function entirely. Routing our own code through one place makes OUR
 * behaviour auditable; it constrains no attacker. The bound on loss is the
 * float. Transaction-level policy (the allow-list simulator specified in
 * docs/turbo-wallet.md) lives in the callers. Do not re-export.
 *
 * THE BINDING INVARIANT (an implementation review caught it being violated —
 * sweep once signed without the guard, which made the "one reviewed signing
 * path" claim false in shipped code): EVERY caller must pass its exact
 * message bytes through assessTurboMessage and sign only on an `ok` verdict.
 * Callers today: ape() and sweep() in TurboWallet.tsx, both guarded. Adding
 * an unguarded one silently falsifies the claims in turbo-guard.ts.
 */
export async function signWithTurbo(message: Uint8Array): Promise<Uint8Array> {
  const record = await getRecord();
  if (!record) throw new Error("No turbo wallet on this device.");
  const signature = await crypto.subtle.sign("Ed25519", record.privateKey, message);
  return new Uint8Array(signature);
}

/**
 * Destroy the vault record. The caller is responsible for the sweep-out
 * ceremony BEFORE calling this — burning with a balance strands the float
 * unless the user kept their recovery code.
 */
export async function burnTurboWallet(): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Vault delete failed."));
    });
  } finally {
    db.close();
  }
}
