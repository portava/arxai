/**
 * Single-trade DEMO certification (spec Phase 15).
 *
 *   pnpm --filter @workspace/api-server run certify:deriv-demo-trade -- \
 *     --authorize=PLACE-ONE-DEMO-ORDER
 *
 * THIS PLACES A REAL ORDER on a real venue, against a demo account. It buys
 * ONE capped multiplier contract, observes it, sells that same contract, and
 * reconciles the P/L. Without the exact authorization string it refuses and
 * exits non-zero.
 *
 * NOT in the ci chain, NOT reachable from strategy, dispatch or scheduler
 * code, and NOT connected to the 18-gate live-order path.
 */

import { resolveNewApiConfig } from "../lib/deriv/newApi/restClient.js";
import {
  runDemoTradeCertification, DEMO_TRADE_AUTHORIZATION, DEMO_TRADE_MAX_STAKE,
} from "../lib/deriv/newApi/demoTradeCertify.js";

async function main(): Promise<void> {
  const authorization = process.argv.find((a) => a.startsWith("--authorize="))?.split("=")[1];
  const stakeArg = process.argv.find((a) => a.startsWith("--stake="))?.split("=")[1];

  console.log("Deriv DEMO trade certification");
  console.log(`Places ONE multiplier order capped at ${DEMO_TRADE_MAX_STAKE}, then closes it.`);
  console.log("Real-money accounts are refused. Nothing autonomous runs here.\n");

  if (authorization !== DEMO_TRADE_AUTHORIZATION) {
    console.error("REFUSED: this command places a real order on the venue.");
    console.error(`Re-run with --authorize=${DEMO_TRADE_AUTHORIZATION} if that is what you intend.`);
    process.exitCode = 1;
    return;
  }

  const config = resolveNewApiConfig();
  if (typeof config === "string") {
    console.error(`cannot run: ${config}`);
    process.exitCode = 1;
    return;
  }

  const report = await runDemoTradeCertification(config, {
    authorization,
    stake: stakeArg ? Number(stakeArg) : undefined,
  });

  for (const s of report.steps) {
    console.log(`  [${s.status.padEnd(10)}] ${s.step.padEnd(16)} ${s.detail}`
      + (s.errorCode ? `  (${s.errorCode})` : ""));
  }

  if (report.reconciliation) {
    const r = report.reconciliation;
    console.log("\n  Reconciliation:");
    console.log(`    buy ${r.buyPrice ?? "?"}  proceeds ${r.sellProceeds ?? "?"}`);
    console.log(`    derived P/L ${r.derivedProfit ?? "?"}  Deriv-reported ${r.reportedProfit ?? "?"}`);
    console.log(`    agrees: ${r.agrees === null ? "UNRESOLVED" : r.agrees}`);
  }

  console.log("");
  // An open position is the loudest thing this command can report, so it is
  // printed last and repeated regardless of the overall verdict.
  if (report.positionLeftOpen) {
    console.error("!! A POSITION MAY STILL BE OPEN !!");
    console.error(`   contract id: ${report.contractId ?? "UNKNOWN — an order was sent"}`);
    console.error("   Verify and close it in the Deriv interface before re-running.");
    process.exitCode = 1;
    return;
  }
  if (report.certified) {
    console.log("DEMO TRADE CERTIFIED: one order placed, closed, and reconciled.");
    console.log("This certifies buy/sell semantics and reconciliation ONLY.");
    console.log("It does NOT authorise autonomous or live-money execution.");
    return;
  }
  console.log("NOT CERTIFIED — see the failing step above.");
  process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(`demo trade certification aborted: ${e instanceof Error ? e.constructor.name : "unknown"}`);
  console.error("If an order was sent, verify your open positions in the Deriv interface.");
  process.exitCode = 1;
});
