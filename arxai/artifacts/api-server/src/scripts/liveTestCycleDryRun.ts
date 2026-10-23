// READ-ONLY dry-run for the Live Test Cycle (Bridge v2 #399).
//
// WHAT THIS IS: a thin wrapper that runs the EXISTING `runPrecheck` +
// `previewCycle` for one user against the REAL gate evaluator. `previewCycle`
// creates a single short-lived LIVE_CONFIRMATION_REQUIRED draft and immediately
// CANCELS it (no EA contact, no dispatch, no broker order). It exists purely to
// surface the honest precheck list + preflight verdict so we know whether the
// 16-gate path would PASS *before* committing to a real dispatch.
//
// It NEVER places, modifies, or closes a live trade and NEVER changes any
// allocation. Safe to run repeatedly.
//
// USAGE:
//   tsx src/scripts/liveTestCycleDryRun.ts --user=4 [--side=BUY] [--sl=1.0890]

import { runPrecheck, previewCycle } from "../lib/live/liveTestCycle.js";
import { routeQuote } from "../lib/data/marketDataRouter.js";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
}

async function main() {
  const userId = parseInt(arg("user") ?? "0", 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    console.error("ERROR: --user=<id> is required");
    process.exit(2);
  }
  const side = (arg("side") ?? "BUY").toUpperCase() === "SELL" ? "SELL" : "BUY";

  // Resolve a real EURUSD reference price for a valid stop-loss, unless the
  // operator pinned one explicitly.
  let entryRef: number | null = null;
  try {
    const q = await routeQuote("EURUSD");
    const anyQ = q as unknown as { price?: number; bid?: number; ask?: number; ok?: boolean };
    entryRef = anyQ.price ?? anyQ.bid ?? anyQ.ask ?? null;
    console.log("EURUSD routeQuote:", JSON.stringify(q, null, 2));
  } catch (e) {
    console.log("routeQuote failed (preflight SL sanity will skip on quote-fail):", e instanceof Error ? e.message : String(e));
  }

  let stopLoss: number;
  const slArg = arg("sl");
  if (slArg) {
    stopLoss = Number(slArg);
  } else if (entryRef && entryRef > 0) {
    // BUY: SL ~1% below ref (well inside the ≤50% physics check, clearly below
    // entry, far from "too close to market"). SELL: ~1% above.
    stopLoss = side === "BUY"
      ? Number((entryRef * 0.99).toFixed(5))
      : Number((entryRef * 1.01).toFixed(5));
  } else {
    stopLoss = side === "BUY" ? 1.0700 : 1.1300;
    console.log(`No live quote — falling back to nominal SL ${stopLoss}`);
  }

  console.log(`\n=== DRY-RUN: user=${userId} side=${side} symbol=EURUSD vol=0.01 SL=${stopLoss} ===\n`);

  const pre = await runPrecheck(userId);
  console.log("PRECHECK ok=" + pre.ok + " masterSwitchEnabled=" + pre.masterSwitchEnabled);
  for (const c of pre.checks) {
    console.log(`  [${c.ok ? "PASS" : "FAIL"}] ${c.key} — ${c.detail}`);
  }
  if (pre.cycleInProgress) {
    console.log("  cycleInProgress:", pre.cycleInProgress.cycleId, pre.cycleInProgress.status);
  }

  console.log("\nPREVIEW (createLiveDraft preflight, then cancel — audit-only, no EA contact):");
  const prev = await previewCycle({ userId, side, stopLoss });
  console.log(JSON.stringify({
    ok: prev.ok,
    masterSwitchEnabled: prev.masterSwitchEnabled,
    preflight: prev.preflight,
    cancelledDraftId: prev.cancelledDraftId,
    note: prev.note,
  }, null, 2));

  console.log(`\nRESULT: dry-run ${prev.ok ? "WOULD PASS preflight" : "WOULD BLOCK"} (SL=${stopLoss}). No trade placed, no allocation changed.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("DRY-RUN FAILED:", e);
  process.exit(1);
});
