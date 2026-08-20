#!/usr/bin/env node
/**
 * prove.js — the ten-second proof, for showing on camera.
 *
 * Takes the newest call Blossom has sealed, then verifies it against Solana
 * from scratch: pulls the transaction by signature, confirms the attestation
 * wallet paid for it, reads the memo the chain actually stores, and reports
 * the gap between the call firing and the block that made it permanent.
 *
 * Nothing here trusts blossomscanner.dev. Every number comes from the chain.
 */
const WALLET = "954wdksZqnk9RQRJpgq564omv5aAiLfTG8Fqqb5y6AD9";
const RPC = process.env.SOLANA_RPC || "https://solana-rpc.publicnode.com";

const rpc = async (method, params) =>
  (await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((r) => r.json())).result;

const usd = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1e3)}K`);

(async () => {
  console.log("\nBLOSSOM — PROVING THE NEWEST CALL, LIVE FROM THE CHAIN");
  console.log("=".repeat(58));

  const rows = await rpc("getSignaturesForAddress", [WALLET, { limit: 5 }]);
  const row = (rows || []).find((r) => !r.err && r.memo && r.memo.includes("BLSM1|"));
  if (!row) return console.log("no sealed call in the last few signatures — try again");

  const parts = row.memo.replace(/^\[\d+\]\s*/, "").split("|");
  const symbol = parts[2] || parts[1].slice(0, 6);
  const mcap = Number(parts[3]);
  const firedAt = Number(parts[4]);

  console.log(`\n  CALL:      $${symbol}`);
  console.log(`  MCAP:      ${usd(mcap)} at the moment it fired`);
  console.log(`  SIGNATURE: ${row.signature}`);

  console.log("\n  fetching that transaction from Solana, independently...");
  const tx = await rpc("getTransaction", [row.signature, { maxSupportedTransactionVersion: 0 }]);
  if (!tx) return console.log("  not found yet — the seal is still confirming");

  const payer = tx.transaction.message.accountKeys[0];
  const sealedAt = tx.blockTime * 1000;
  const gap = ((sealedAt - firedAt) / 1000).toFixed(1);

  console.log(`\n  fee payer on-chain:  ${payer}`);
  console.log(`  matches our wallet:  ${payer === WALLET ? "YES" : "NO"}`);
  console.log(`  block time:          ${new Date(sealedAt).toISOString()}  (set by validators, not by us)`);
  console.log(`  call fired:          ${new Date(firedAt).toISOString()}`);
  console.log(`\n  SEALED ${gap < 1 ? "UNDER 1" : gap} SECOND${gap >= 2 ? "S" : ""} AFTER THE CALL — BEFORE ANYONE KNEW THE OUTCOME.`);
  console.log(`\n  check it yourself: https://solscan.io/tx/${row.signature}\n`);
})();
