#!/usr/bin/env node
/**
 * blossom-verify — reconstruct Blossom Scanner's entire track record from the
 * Solana blockchain, independently, with no trust in blossomscanner.dev.
 *
 * Every call the scanner fires is written to Solana as a signed memo from one
 * wallet, seconds after the call and BEFORE the outcome exists. Solana block
 * times cannot be edited, deleted, or backdated by anyone — including us — so
 * this script can rebuild the record from the chain and check our claims.
 *
 * No dependencies. No API keys. Node 18+.
 *
 *   node verify.js                 # count + seal-latency proof + recent calls
 *   node verify.js --outcomes 50   # ALSO price the last 50 calls (winners AND losers)
 *   node verify.js --json          # machine-readable dump of every sealed call
 *   node verify.js --rpc <url>     # use your own RPC (default: a public node)
 *   node verify.js --offline       # chain only: skip the one call to blossomscanner.dev
 *
 * MIT licensed. Fork it, break it, prove us wrong if you can.
 */

const WALLET = "954wdksZqnk9RQRJpgq564omv5aAiLfTG8Fqqb5y6AD9";
const DEFAULT_RPC = "https://solana-rpc.publicnode.com";
const PAGE = 1000;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const RPC = value("--rpc", process.env.SOLANA_RPC || DEFAULT_RPC);
const AS_JSON = flag("--json");
const OFFLINE = flag("--offline");

/**
 * Never print the endpoint itself. Archival RPCs carry their credential IN the
 * URL, and this tool exists to produce output people screenshot — printing it
 * verbatim would leak the auditor's own key in the headline block. The
 * hostname alone says which node the audit ran against.
 */
const rpcLabel = (() => {
  try {
    return new URL(RPC).hostname;
  } catch {
    return "custom endpoint";
  }
})();
const OUTCOMES = flag("--outcomes") ? Number(value("--outcomes", 50)) : 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Strip any URL out of text before it is printed — an upstream error body can
 *  quote the endpoint back, credential and all. */
const scrub = (text) => String(text).replace(/https?:\/\/\S+/g, "<endpoint>");

async function rpc(method, params) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (res.status === 429) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      const body = await res.json();
      if (body.error) throw new Error(JSON.stringify(body.error));
      return body.result;
    } catch (cause) {
      if (attempt === 3) throw cause;
      await sleep(1000 * (attempt + 1));
    }
  }
  return null;
}

/**
 * Memo format, verified against live mainnet data:
 *   BLSM1|<mint>|<symbol>|<mcapCallUsd>|<tsCallMs>|<feed>|<smartCount>|<conviction>
 *
 * The RPC prefixes memos with their byte length, e.g. `[91] BLSM1|…`, so that
 * is stripped first. Symbols may contain spaces (and, defensively, pipes), so
 * the fields are read from both ends rather than by naive index.
 */
function parseMemo(raw) {
  if (!raw) return null;
  const text = raw.replace(/^\[\d+\]\s*/, "").trim();
  if (!text.startsWith("BLSM1|")) return null;
  const parts = text.split("|");
  if (parts.length < 8) return null;
  const tail = parts.slice(-5); // mcapCall, tsCall, feed, smart, conviction
  const symbol = parts.slice(2, parts.length - 5).join("|");
  const mcapCallUsd = Number(tail[0]);
  const tsCallMs = Number(tail[1]);
  if (!Number.isFinite(mcapCallUsd) || !Number.isFinite(tsCallMs)) return null;
  return {
    mint: parts[1],
    symbol: symbol || null,
    mcapCallUsd,
    tsCallMs,
    feed: tail[2] || null,
    smartCount: Number(tail[3]) || 0,
    conviction: tail[4] === "1",
  };
}

async function readAllSealedCalls() {
  const calls = [];
  let before;
  let pages = 0;
  let signatures = 0;
  process.stderr.write("reading the chain");
  for (;;) {
    const options = { limit: PAGE };
    if (before) options.before = before;
    const rows = await rpc("getSignaturesForAddress", [WALLET, options]);
    if (!rows || rows.length === 0) break;
    pages += 1;
    signatures += rows.length;
    process.stderr.write(".");
    for (const row of rows) {
      if (row.err) continue; // a failed transaction seals nothing
      const parsed = parseMemo(row.memo);
      if (!parsed) continue;
      calls.push({
        ...parsed,
        signature: row.signature,
        slot: row.slot,
        blockTime: row.blockTime ?? null,
      });
    }
    if (rows.length < PAGE) break;
    before = rows[rows.length - 1].signature;
    await sleep(120);
  }
  process.stderr.write(` ${pages} pages, ${signatures} signatures\n\n`);
  return calls;
}

/**
 * How many calls the ledger holds in total, per Blossom's own public endpoint.
 *
 * This exists to EXPOSE a limitation, not to paper over one: most public RPCs
 * prune old signatures, so a default run reaches back only days and reports a
 * fraction of the record. Rather than quietly under-report (or worse, let a
 * reader think the shortfall is the claim collapsing), the script asks for the
 * full figure and prints the gap with the reason. Re-run with an archival
 * --rpc to reproduce the whole thing from the chain alone; this number is a
 * signpost, never the proof.
 */
async function claimedTotal() {
  try {
    const res = await fetch("https://blossomscanner.dev/api/sealed-count");
    if (!res.ok) return null;
    const body = await res.json();
    return Number.isFinite(body?.sealed) ? body.sealed : null;
  } catch {
    return null;
  }
}

const usd = (n) =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`;
const pct = (part, total) => (total ? ((part / total) * 100).toFixed(1) : "0.0");

/**
 * Solana block times have SECOND granularity while calls are stamped in
 * milliseconds, so a call fired at :59.9 and sealed at :00.1 can compute to a
 * small negative delay. That is clock resolution, not time travel — anything
 * inside a second is reported as "<1s" rather than printed as a negative.
 */
const latency = (ms) => (ms < 1000 ? "<1s" : `${(ms / 1000).toFixed(1)}s`);

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next !== undefined ? sorted[base] + rest * (next - sorted[base]) : sorted[base];
}

/** Current market caps, batched small — a large batch silently returns one
 *  pool per token and corrupts the numbers. */
async function currentMarketCaps(mints) {
  const caps = {};
  for (let i = 0; i < mints.length; i += 4) {
    const chunk = mints.slice(i, i + 4);
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(",")}`);
      if (res.ok) {
        const body = await res.json();
        for (const pair of body.pairs ?? []) {
          if (pair.chainId !== "solana") continue;
          const mint = pair.baseToken?.address;
          const cap = Number(pair.marketCap ?? pair.fdv);
          if (!mint || !Number.isFinite(cap)) continue;
          const liq = Number(pair.liquidity?.usd ?? 0);
          if (!caps[mint] || liq > caps[mint].liq) caps[mint] = { cap, liq };
        }
      }
    } catch {
      // A price miss is not a proof failure — the seal is the claim being checked.
    }
    process.stderr.write(".");
    await sleep(260);
  }
  return Object.fromEntries(Object.entries(caps).map(([m, v]) => [m, v.cap]));
}

(async () => {
  const calls = await readAllSealedCalls();
  if (!calls.length) {
    console.error("No sealed calls found. Check the RPC endpoint and try again.");
    process.exit(1);
  }
  calls.sort((a, b) => b.tsCallMs - a.tsCallMs);

  if (AS_JSON) {
    console.log(JSON.stringify(calls, null, 2));
    return;
  }

  const first = calls[calls.length - 1];
  const last = calls[0];
  const mints = new Set(calls.map((c) => c.mint));
  const latencies = calls
    .filter((c) => c.blockTime)
    .map((c) => Math.max(0, c.blockTime * 1000 - c.tsCallMs))
    .filter((ms) => ms < 10 * 60 * 1000)
    .sort((a, b) => a - b);

  console.log("BLOSSOM SCANNER — TRACK RECORD, REBUILT FROM THE CHAIN");
  console.log("=".repeat(58));
  console.log(`wallet          ${WALLET}`);
  console.log(`rpc             ${rpcLabel}`);
  console.log("");
  console.log(`sealed calls    ${calls.length.toLocaleString()}  (reconstructed by you, from the chain)`);
  console.log(`distinct coins  ${mints.size.toLocaleString()}`);
  console.log(
    `first sealed    ${new Date(first.tsCallMs).toISOString()}  ($${first.symbol || first.mint.slice(0, 6)})`,
  );
  console.log(
    `last sealed     ${new Date(last.tsCallMs).toISOString()}  ($${last.symbol || last.mint.slice(0, 6)})`,
  );
  const total = OFFLINE ? null : await claimedTotal();
  if (total && total > calls.length * 1.05) {
    console.log("");
    console.log("⚠ THIS RPC ONLY RETAINS PART OF THE HISTORY — you are seeing a slice.");
    console.log(
      `  Reached back to ${new Date(first.tsCallMs).toISOString().slice(0, 10)}: ${calls.length.toLocaleString()} sealed calls. The full ledger holds ${total.toLocaleString()}.`,
    );
    console.log("  Public nodes prune old signatures; every older memo is still on Solana.");
    console.log("  Rebuild ALL of them yourself with an archival endpoint:");
    console.log("      node verify.js --rpc <archival-rpc-url>");
    console.log("  (free archival tiers: helius.dev, quicknode.com, alchemy.com)");
  }
  console.log("");
  console.log("SEAL LATENCY — time from the call firing to it landing on Solana");
  console.log(
    `  median ${latency(quantile(latencies, 0.5))}   p90 ${latency(quantile(latencies, 0.9))}   fastest ${latency(latencies[0])}   (n=${latencies.length})`,
  );
  console.log(
    "  Every one of those block times is set by Solana's validators, not by us.",
  );
  console.log("  A backdated or edited call is not possible — that is the whole point.");
  console.log("");

  if (OUTCOMES > 0) {
    const sample = calls.slice(0, Math.min(OUTCOMES, calls.length));
    process.stderr.write(`pricing the last ${sample.length} calls`);
    const caps = await currentMarketCaps([...new Set(sample.map((c) => c.mint))]);
    process.stderr.write("\n\n");
    const priced = sample
      .map((c) => ({ ...c, now: caps[c.mint] }))
      .filter((c) => Number.isFinite(c.now) && c.mcapCallUsd > 0)
      .map((c) => ({ ...c, x: c.now / c.mcapCallUsd }));

    if (priced.length) {
      const xs = priced.map((c) => c.x).sort((a, b) => a - b);
      const band = (lo, hi) => priced.filter((c) => c.x >= lo && c.x < hi).length;
      console.log(`OUTCOMES — last ${priced.length} sealed calls, priced right now`);
      console.log("(current market cap vs the sealed entry — NOT peaks, NOT anyone's returns)");
      console.log(`  down 80%+ (rug/dead) ${band(0, 0.2).toString().padStart(5)}  ${pct(band(0, 0.2), priced.length)}%`);
      console.log(`  down             ${band(0.2, 1).toString().padStart(8)}  ${pct(band(0.2, 1), priced.length)}%`);
      console.log(`  up (under 2x)    ${band(1, 2).toString().padStart(8)}  ${pct(band(1, 2), priced.length)}%`);
      console.log(`  2x — 5x          ${band(2, 5).toString().padStart(8)}  ${pct(band(2, 5), priced.length)}%`);
      console.log(`  5x — 10x         ${band(5, 10).toString().padStart(8)}  ${pct(band(5, 10), priced.length)}%`);
      console.log(`  10x+             ${band(10, Infinity).toString().padStart(8)}  ${pct(band(10, Infinity), priced.length)}%`);
      console.log(`  median           ${quantile(xs, 0.5).toFixed(2)}x`);
      console.log("");
      console.log("  Most memecoins die. This distribution is the honest picture, and it");
      console.log("  is the number a caller who could edit their history would never show.");
      console.log("");
    }
  }

  console.log("10 MOST RECENT SEALED CALLS");
  for (const c of calls.slice(0, 10)) {
    const lat = c.blockTime ? latency(Math.max(0, c.blockTime * 1000 - c.tsCallMs)) : "?";
    console.log(
      `  $${(c.symbol || c.mint.slice(0, 6)).padEnd(12)} sealed @ ${usd(c.mcapCallUsd).padEnd(8)} ` +
        `${new Date(c.tsCallMs).toISOString().replace("T", " ").slice(0, 19)}  ` +
        `${(lat.startsWith("<") ? lat : `+${lat}`).padEnd(6)} ${c.signature.slice(0, 12)}…`,
    );
  }
  console.log("");
  console.log("Check any line above yourself:  https://solscan.io/tx/<signature>");
  console.log("Full record + the app:          https://blossomscanner.dev/track-record");
})().catch((cause) => {
  console.error("\nverification failed:", scrub(cause.message));
  console.error("(a public RPC may be rate-limiting — retry, or pass --rpc <your endpoint>)");
  process.exit(1);
});
