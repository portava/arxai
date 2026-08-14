// ARX AI — Per-user demo dispatch gate.
//
// Phase 28-MT5-DEMO-ARMING (May 2026) — sub-phase 3B.
//
// Server-side aggregator over per-user runtime preconditions used both by
// the consumer (before writing SENT_TO_MT5_DEMO) and by the EA-facing demo
// poll endpoint (before serving a row to the EA).
//
// SAFETY:
//   - READ-ONLY. Never mutates a command. Never calls the EA.
//   - The chokepoint `canDispatchToMt5(inputs)` is consulted SEPARATELY
//     by the consumer/route after this gate returns.
//   - No tokens, no apiKeyHash, no broker passwords ever returned.

import { eq } from "drizzle-orm";
import { db, mt5ConnectionTable } from "@workspace/db";
import {
  evaluatePerUserDispatchEligibility,
  eaVersionAtLeast,
  EA_MIN_DEMO_VERSION,
  type PerUserDispatchEligibility,
} from "@workspace/domain/safety-contracts/executionMode";
import { runDemoVerificationGate } from "./demoVerificationGate.js";
import { getDuplicateEaProbe } from "../../routes/mt5.js";
import { isArmedForDemo } from "./demoArmingService.js";

const HEARTBEAT_FRESH_SECONDS = 15;

export interface PerUserDispatchEvaluation {
  eligibility: PerUserDispatchEligibility;
  evidence: {
    executionModeReported: string;
    armed: boolean;
    verifiedDemo: boolean;
    accountTypeReported: string;
    accountTypeExplicitDemo: boolean;
    heartbeatAgeSeconds: number | null;
    heartbeatFresh: boolean;
    userOwnsBridge: boolean;
    bridgeConnectionId: number | null;
    accountLogin: string | null;
    reportedEaVersion: string | null;
    eaVersionAtLeast: boolean;
    eaMinDemoVersion: string;
    // EA Inputs reported via heartbeat (v1.26+). `null` = not reported yet
    // (treat as unknown — allowed, with a warning). Booleans are
    // authoritative when present.
    readOnlyModeReported: boolean | null;
    enableDemoExecutionReported: boolean | null;
    // The list of disqualifying reasons for the chosen bridge. Empty array
    // when the bridge is fully execution-ready.
    bridgeBlockers: string[];
  };
}

function extractEaInputs(
  caps: unknown,
): { readOnlyMode: boolean | null; enableDemoExecution: boolean | null } {
  if (!caps || typeof caps !== "object") return { readOnlyMode: null, enableDemoExecution: null };
  const ea = (caps as Record<string, unknown>)["eaInputs"];
  if (!ea || typeof ea !== "object") return { readOnlyMode: null, enableDemoExecution: null };
  const r = (ea as Record<string, unknown>)["readOnlyMode"];
  const e = (ea as Record<string, unknown>)["enableDemoExecution"];
  return {
    readOnlyMode: typeof r === "boolean" ? r : null,
    enableDemoExecution: typeof e === "boolean" ? e : null,
  };
}

/** Score a bridge row for demo-execution eligibility. Higher is better. */
function scoreBridge(row: typeof mt5ConnectionTable.$inferSelect): {
  score: number;
  blockers: string[];
} {
  const blockers: string[] = [];
  if (row.tokenRevokedAt) blockers.push("BRIDGE_REVOKED");
  const hbAge = row.lastHeartbeat
    ? Math.floor((Date.now() - new Date(row.lastHeartbeat).getTime()) / 1000)
    : null;
  const hbFresh = hbAge !== null && hbAge <= HEARTBEAT_FRESH_SECONDS;
  if (!hbFresh) blockers.push(hbAge === null ? "NO_HEARTBEAT" : `HEARTBEAT_STALE(${hbAge}s)`);
  const accountType = (row.accountType ?? "unknown").toString();
  if (accountType !== "demo" && accountType !== "contest") {
    blockers.push(`ACCOUNT_TYPE_NOT_DEMO(${accountType})`);
  }
  const eaOk = eaVersionAtLeast(row.eaVersion ?? null, EA_MIN_DEMO_VERSION);
  if (!eaOk) blockers.push(`EA_VERSION_TOO_OLD(${row.eaVersion ?? "none"})`);
  const ea = extractEaInputs(row.capabilities);
  if (ea.readOnlyMode === true) blockers.push("EA_READ_ONLY_MODE_TRUE");
  if (ea.enableDemoExecution === false) blockers.push("EA_DEMO_EXECUTION_DISABLED");
  // Ranking: fully-eligible bridges first, then by freshest heartbeat.
  // Inside the eligible set, freshest heartbeat wins. Inside the
  // ineligible set, prefer fewer blockers then freshest heartbeat.
  const eligible = blockers.length === 0;
  const hbScore = hbAge === null ? 0 : Math.max(0, 1_000_000 - hbAge);
  const score = (eligible ? 10_000_000 : 0) - blockers.length * 100_000 + hbScore;
  return { score, blockers };
}

export async function evaluatePerUserDispatchGate(args: {
  userId: number;
  userConfirmed: boolean;
  duplicateClear: boolean;
  riskGatePassed?: boolean;
}): Promise<PerUserDispatchEvaluation> {
  // Per-user demo-bridge selector (sub-phase 3D follow-up — fix May 2026).
  //
  // The old selector picked the freshest non-revoked row. That broke when a
  // user had multiple bridges for the same account where the freshest was a
  // *read-only* registration — newer EA installs would race the heartbeat
  // and win the slot, then every dispatch would return
  // REJECTED_READ_ONLY_MODE_ACTIVE.
  //
  // New ranking (per `scoreBridge`):
  //   1. fully-eligible bridges (heartbeat fresh + accountType=demo +
  //      eaVersion>=1.26 + !readOnlyMode + enableDemoExecution!==false)
  //   2. inside each tier, fewer blockers wins
  //   3. tie-break by freshest heartbeat
  // Revoked rows are excluded entirely.
  const allRows = await db
    .select()
    .from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.userId, args.userId));
  const nonRevoked = allRows.filter((r) => !r.tokenRevokedAt);
  const ranked = nonRevoked
    .map((r) => ({ row: r, ...scoreBridge(r) }))
    .sort((a, b) => b.score - a.score);
  const top = ranked[0];
  const conn = top?.row ?? null;
  const bridgeBlockers = top?.blockers ?? (nonRevoked.length === 0 ? ["NO_BRIDGE_CONNECTION"] : []);

  const userOwnsBridge = !!conn;
  const heartbeatAgeSeconds = conn?.lastHeartbeat
    ? Math.floor((Date.now() - new Date(conn.lastHeartbeat).getTime()) / 1000)
    : null;
  const heartbeatFresh =
    heartbeatAgeSeconds !== null && heartbeatAgeSeconds <= HEARTBEAT_FRESH_SECONDS;
  const accountTypeReported = (conn?.accountType ?? "none").toString();
  const accountTypeExplicitDemo = accountTypeReported === "demo" || accountTypeReported === "contest";
  const reportedEaVersion = conn?.eaVersion ?? null;
  const eaOk = eaVersionAtLeast(reportedEaVersion, EA_MIN_DEMO_VERSION);
  const eaInputs = extractEaInputs(conn?.capabilities ?? null);

  const probe = getDuplicateEaProbe();
  const readiness = await runDemoVerificationGate({
    userId: args.userId,
    duplicateEaProbe: { suspected: probe.suspected, reason: probe.reason ?? null },
  });
  const verifiedDemo = readiness.status === "VERIFIED_DEMO";

  const armed = await isArmedForDemo(args.userId);
  const executionMode = armed ? "MT5_DEMO_EXECUTION" : "MT5_DEMO_READ_ONLY";

  const eligibility = evaluatePerUserDispatchEligibility({
    executionMode,
    verifiedDemo,
    accountTypeExplicitDemo,
    userOwnsBridge,
    bridgeConnected: userOwnsBridge && heartbeatFresh,
    heartbeatFresh,
    userConfirmed: args.userConfirmed,
    duplicateClear: args.duplicateClear,
    riskGatePassed: args.riskGatePassed ?? true,
    liveLocked: true,
    eaVersionAtLeast: eaOk,
    reportedEaVersion,
  });

  return {
    eligibility,
    evidence: {
      executionModeReported: executionMode,
      armed,
      verifiedDemo,
      accountTypeReported,
      accountTypeExplicitDemo,
      heartbeatAgeSeconds,
      heartbeatFresh,
      userOwnsBridge,
      bridgeConnectionId: conn?.id ?? null,
      accountLogin: conn?.accountNumber ?? null,
      reportedEaVersion,
      eaVersionAtLeast: eaOk,
      eaMinDemoVersion: EA_MIN_DEMO_VERSION,
      readOnlyModeReported: eaInputs.readOnlyMode,
      enableDemoExecutionReported: eaInputs.enableDemoExecution,
      bridgeBlockers,
    },
  };
}
