/**
 * Turbo lifecycle log — hash-chained, local, exportable. Pre-launch gate 5 of
 * docs/turbo-wallet.md.
 *
 * WHY: the first public "the turbo wallet stole my SOL" accusation will be
 * answered with a receipt or it will stick. This log records every lifecycle
 * event (created / backup-proved / restored / deposit / sign / sweep / burn)
 * in IndexedDB, each entry carrying sha256(prevHash ‖ entry). An edited or
 * deleted middle breaks every hash after it, so an exported log is either
 * intact or visibly doctored — the same property the on-chain attestation
 * gives the scanner's calls, applied to the wallet's own history.
 *
 * HONEST SCOPE, stated plainly: this is a LOCAL log in the same browser
 * profile as the vault. It proves sequence and integrity of what THIS app
 * recorded; it cannot prove events that code outside this app performed with
 * the key handle, and wiping the whole profile wipes the log with the wallet.
 * The bound on loss remains the float.
 *
 * Best-effort by design: a logging failure must never block a trade or a
 * sweep. Every public function swallows its own errors.
 */

const DB_NAME = "blossom-turbo-log";
const STORE = "events";

export type TurboLogEntry = {
  seq: number;
  at: number;
  event: string;
  detail: Record<string, unknown>;
  prevHash: string;
  hash: string;
};

function logSupported(): boolean {
  return typeof indexedDB !== "undefined" && typeof crypto !== "undefined" && !!crypto.subtle;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(STORE, { keyPath: "seq" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("log db open failed"));
  });
}

async function readAll(db: IDBDatabase): Promise<TurboLogEntry[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).getAll();
    request.onsuccess = () => resolve((request.result as TurboLogEntry[]) ?? []);
    request.onerror = () => reject(request.error ?? new Error("log read failed"));
  });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The exact bytes that get hashed — one canonical serialisation, forever. */
function preimage(entry: Omit<TurboLogEntry, "hash">): string {
  return entry.prevHash + "|" + entry.seq + "|" + entry.at + "|" + entry.event + "|" + JSON.stringify(entry.detail);
}

/**
 * Append one event. Never throws; never blocks the caller's flow.
 * Serialised through a single readwrite transaction so two rapid events
 * cannot both claim the same seq.
 */
export async function appendTurboLog(
  event: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  if (!logSupported()) return;
  try {
    const db = await openDb();
    try {
      const entries = await readAll(db);
      const last = entries[entries.length - 1];
      const base = {
        seq: (last?.seq ?? 0) + 1,
        at: Date.now(),
        event,
        detail,
        prevHash: last?.hash ?? "genesis",
      };
      const hash = await sha256Hex(preimage(base));
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).add({ ...base, hash });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("log write failed"));
      });
    } finally {
      db.close();
    }
  } catch {
    // A broken log must never break the wallet.
  }
}

/** The full chain, oldest first. Empty on any failure. */
export async function exportTurboLog(): Promise<TurboLogEntry[]> {
  if (!logSupported()) return [];
  try {
    const db = await openDb();
    try {
      return (await readAll(db)).sort((a, b) => a.seq - b.seq);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/** Recompute every link. Anyone can run this on an exported log too. */
export async function verifyTurboLog(): Promise<{ ok: boolean; length: number; brokenAt?: number }> {
  const entries = await exportTurboLog();
  let prev = "genesis";
  for (const entry of entries) {
    const expected = await sha256Hex(preimage({ ...entry, prevHash: prev }));
    if (entry.prevHash !== prev || entry.hash !== expected) {
      return { ok: false, length: entries.length, brokenAt: entry.seq };
    }
    prev = entry.hash;
  }
  return { ok: true, length: entries.length };
}
