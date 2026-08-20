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
  // Two events fired in the same tick (sign → landed, or a close batch loop)
  // both read the same tail and computed the same seq; `add` rejected the
  // loser with a ConstraintError, the catch swallowed it, and the event
  // VANISHED from a chain that still verified as intact. A dropped event in a
  // log whose purpose is answering an accusation is the worst kind of bug:
  // silent, and only discovered when it matters. Retry on collision.
  for (let attempt = 0; attempt < 5; attempt += 1) {
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
        return;
      } finally {
        db.close();
      }
    } catch (cause) {
      const name = (cause as { name?: string } | null)?.name;
      if (name !== "ConstraintError") return; // not a collision — give up quietly
      // Someone else took our seq. Re-read and try again.
    }
  }
}

/**
 * The full chain, oldest first.
 *
 * `readable` distinguishes "the log is empty" from "the log could not be
 * read" — collapsing those was how an unreadable log reported itself INTACT,
 * which is precisely the claim this module exists to make honestly.
 */
export async function exportTurboLog(): Promise<{ entries: TurboLogEntry[]; readable: boolean }> {
  if (!logSupported()) return { entries: [], readable: false };
  try {
    const db = await openDb();
    try {
      return { entries: (await readAll(db)).sort((a, b) => a.seq - b.seq), readable: true };
    } finally {
      db.close();
    }
  } catch {
    return { entries: [], readable: false };
  }
}

export type TurboLogVerdict = {
  /** True only for a chain that was READ and whose every link recomputes. */
  ok: boolean;
  length: number;
  brokenAt?: number;
  /** False when the store could not be opened or read at all. */
  readable: boolean;
  /**
   * What the chain can and cannot prove, carried WITH the verdict so it
   * travels into whatever the user pastes. A hash chain proves nothing was
   * edited or removed from the middle of what this app recorded; it cannot
   * prove the log is complete, because a truncated tail — or a profile wiped
   * entirely — verifies exactly like an honest short chain. The on-chain
   * attestation is the append-only record; this is the local companion.
   */
  scope: string;
};

const SCOPE =
  "This chain proves nothing was edited or deleted from the middle of what this app recorded on this device. It cannot prove completeness: a truncated tail verifies like an honest short chain, and it never sees what other code did with the key.";

/** Recompute every link. Anyone can run this on an exported log too. */
export async function verifyTurboLog(): Promise<TurboLogVerdict> {
  const { entries, readable } = await exportTurboLog();
  if (!readable) return { ok: false, length: 0, readable: false, scope: SCOPE };
  let prev = "genesis";
  for (const entry of entries) {
    const expected = await sha256Hex(preimage({ ...entry, prevHash: prev }));
    if (entry.prevHash !== prev || entry.hash !== expected) {
      return { ok: false, length: entries.length, brokenAt: entry.seq, readable: true, scope: SCOPE };
    }
    prev = entry.hash;
  }
  return { ok: true, length: entries.length, readable: true, scope: SCOPE };
}
