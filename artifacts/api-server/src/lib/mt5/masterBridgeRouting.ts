// ARX AI — Centralized Master MT5 Bridge — routing for the modern
// per-user demo command queue (Slice 1 + 2).
//
// This is the missing wire between `resolveRouting()` and the modern
// demo dispatch path:
//   demoDispatchGate.ts / demoCommandQueue.ts / demoCommandConsumer.ts
//     -> evaluateRoutedDemoDispatchGate (this file)
//        -> resolveRouting({ mode: "DEMO" })
//             -> USER_OWNED_MT5 : delegate to evaluatePerUserDispatchGate
//             -> SHARED_MASTER_MT5 : evaluate against the master bridge
//
// SAFETY (inviolable):
//   - Live trading remains locked at every chokepoint. This file only
//     ever calls `resolveRouting({ mode: "DEMO" })`. There is no "LIVE"
//     code path here. `liveLocked: true` is passed unchanged.
//   - Master-routed dispatches still require the *user* to be
//     VERIFIED_DEMO AND armed. Master bridge presence does NOT bypass
//     per-user verification or arming.
//   - No tokens, hashes, or broker passwords are ever returned.
//   - The master account number is included in evidence ONLY as a
//     server-internal field used to populate the EA's
//     `bridgeReadinessAtDraft` snapshot. It is masked when surfaced to
//     end users in UI/Ruby copy (mt5-setup / scanner / assistant).

import { eq } from "drizzle-orm";
import { db, mt5ConnectionTable, sharedTradeAttributionTable, sharedMasterAccountsTable } from "@workspace/db";
import {
  evaluatePerUserDispatchEligibility,
  eaVersionAtLeast,
  EA_MIN_DEMO_VERSION,
} from "@workspace/domain/safety-contracts/executionMode";
import { resolveRouting } from "../adminTrading/routingResolver.js";
import { runDemoVerificationGate } from "./demoVerificationGate.js";
import { getDuplicateEaProbe } from "../../routes/mt5.js";
import { isArmedForDemo } from "./demoArmingService.js";
import {
  evaluatePerUserDispatchGate,
  type PerUserDispatchEvaluation,
} from "./demoDispatchGate.js";
import { and, sql } from "drizzle-orm";

const HEARTBEAT_FRESH_SECONDS = 15;

export interface RoutedDemoDispatchEvaluation {
  eligibility: PerUserDispatchEvaluation["eligibility"];
  evidence: PerUserDispatchEvaluation["evidence"];
  routing: {
    effectiveRoutingMode: "USER_OWNED_MT5" | "SHARED_MASTER_MT5";
    routedViaMaster: boolean;
    sharedMasterAccountId: number | null;
    virtualAccountId: number | null;
    masterConnectionId: number | null;
    routingBlockReason: string | null;
    routingNotes: string[];
  };
}

function extractEaInputs(caps: unknown): {
  readOnlyMode: boolean | null;
  enableDemoExecution: boolean | null;
} {
  if (!caps || typeof caps !== "object")
    return { readOnlyMode: null, enableDemoExecution: null };
  const ea = (caps as Record<string, unknown>)["eaInputs"];
  if (!ea || typeof ea !== "object")
    return { readOnlyMode: null, enableDemoExecution: null };
  const r = (ea as Record<string, unknown>)["readOnlyMode"];
  const e = (ea as Record<string, unknown>)["enableDemoExecution"];
  return {
    readOnlyMode: typeof r === "boolean" ? r : null,
    enableDemoExecution: typeof e === "boolean" ? e : null,
  };
}

/**
 * Modern demo dispatch gate — routing-aware. Wraps `resolveRouting()`:
 *   - USER_OWNED_MT5 → delegate to `evaluatePerUserDispatchGate`.
 *   - SHARED_MASTER_MT5 → evaluate readiness against the master bridge
 *     while still requiring the user to be VERIFIED_DEMO + armed.
 */
export async function evaluateRoutedDemoDispatchGate(args: {
  userId: number;
  userConfirmed: boolean;
  duplicateClear: boolean;
  riskGatePassed?: boolean;
}): Promise<RoutedDemoDispatchEvaluation> {
  const routing = await resolveRouting({ userId: args.userId, mode: "DEMO" });

  // USER_OWNED path (default + when override pins user-owned).
  if (routing.effectiveRoutingMode === "USER_OWNED_MT5") {
    const base = await evaluatePerUserDispatchGate(args);
    return {
      eligibility: base.eligibility,
      evidence: base.evidence,
      routing: {
        effectiveRoutingMode: "USER_OWNED_MT5",
        routedViaMaster: false,
        sharedMasterAccountId: null,
        virtualAccountId: null,
        masterConnectionId: null,
        routingBlockReason: routing.ok ? null : routing.blockReason,
        routingNotes: routing.notes,
      },
    };
  }

  // SHARED_MASTER_MT5 — must have a master conn id and matching active
  // shared_master_accounts row. resolveRouting returns ok=false with a
  // precise blockReason if any of these are missing.
  if (!routing.ok || !routing.connectionId) {
    // We still want to report the *user's* armed/verified state so the
    // UI can show why the dispatch will refuse even without a master.
    const probe = getDuplicateEaProbe();
    const readiness = await runDemoVerificationGate({
      userId: args.userId,
      duplicateEaProbe: { suspected: probe.suspected, reason: probe.reason ?? null },
    });
    const armed = await isArmedForDemo(args.userId);
    const executionMode = armed ? "MT5_DEMO_EXECUTION" : "MT5_DEMO_READ_ONLY";
    const reason = routing.blockReason ?? "SHARED_DEMO_MASTER_NOT_CONFIGURED";
    const eligibility = evaluatePerUserDispatchEligibility({
      executionMode,
      verifiedDemo: readiness.status === "VERIFIED_DEMO",
      accountTypeExplicitDemo: false,
      userOwnsBridge: false,
      bridgeConnected: false,
      heartbeatFresh: false,
      userConfirmed: args.userConfirmed,
      duplicateClear: args.duplicateClear,
      riskGatePassed: args.riskGatePassed ?? true,
      liveLocked: true,
      eaVersionAtLeast: false,
      reportedEaVersion: null,
    });
    return {
      eligibility,
      evidence: {
        executionModeReported: executionMode,
        armed,
        verifiedDemo: readiness.status === "VERIFIED_DEMO",
        accountTypeReported: "none",
        accountTypeExplicitDemo: false,
        heartbeatAgeSeconds: null,
        heartbeatFresh: false,
        userOwnsBridge: false,
        bridgeConnectionId: null,
        accountLogin: null,
        reportedEaVersion: null,
        eaVersionAtLeast: false,
        eaMinDemoVersion: EA_MIN_DEMO_VERSION,
        readOnlyModeReported: null,
        enableDemoExecutionReported: null,
        bridgeBlockers: [reason],
      },
      routing: {
        effectiveRoutingMode: "SHARED_MASTER_MT5",
        routedViaMaster: true,
        sharedMasterAccountId: routing.sharedMasterAccountId,
        virtualAccountId: routing.virtualAccountId,
        masterConnectionId: routing.connectionId,
        routingBlockReason: reason,
        routingNotes: routing.notes,
      },
    };
  }

  // Master conn present — evaluate master bridge readiness.
  const [conn] = await db
    .select()
    .from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.id, routing.connectionId))
    .limit(1);

  const hbAge = conn?.lastHeartbeat
    ? Math.floor((Date.now() - new Date(conn.lastHeartbeat).getTime()) / 1000)
    : null;
  const hbFresh = hbAge !== null && hbAge <= HEARTBEAT_FRESH_SECONDS;
  const accountTypeReported = (conn?.accountType ?? "none").toString();
  const accountTypeExplicitDemo =
    accountTypeReported === "demo" || accountTypeReported === "contest";
  const reportedEaVersion = conn?.eaVersion ?? null;
  const eaOk = eaVersionAtLeast(reportedEaVersion, EA_MIN_DEMO_VERSION);
  const eaInputs = extractEaInputs(conn?.capabilities ?? null);

  const masterBlockers: string[] = [];
  if (!conn) masterBlockers.push("MASTER_BRIDGE_GONE");
  if (!hbFresh)
    masterBlockers.push(
      hbAge === null ? "MASTER_NO_HEARTBEAT" : `MASTER_HEARTBEAT_STALE(${hbAge}s)`,
    );
  if (!accountTypeExplicitDemo)
    masterBlockers.push(`MASTER_ACCOUNT_TYPE_NOT_DEMO(${accountTypeReported})`);
  if (!eaOk)
    masterBlockers.push(`MASTER_EA_VERSION_TOO_OLD(${reportedEaVersion ?? "none"})`);
  if (eaInputs.readOnlyMode === true) masterBlockers.push("MASTER_EA_READ_ONLY_MODE_TRUE");
  if (eaInputs.enableDemoExecution === false)
    masterBlockers.push("MASTER_EA_DEMO_EXECUTION_DISABLED");

  // User must still be VERIFIED_DEMO and armed.
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
    userOwnsBridge: !!conn, // master conn fills the bridge slot
    bridgeConnected: !!conn && hbFresh,
    heartbeatFresh: hbFresh,
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
      heartbeatAgeSeconds: hbAge,
      heartbeatFresh: hbFresh,
      userOwnsBridge: !!conn,
      bridgeConnectionId: conn?.id ?? null,
      accountLogin: conn?.accountNumber ?? null,
      reportedEaVersion,
      eaVersionAtLeast: eaOk,
      eaMinDemoVersion: EA_MIN_DEMO_VERSION,
      readOnlyModeReported: eaInputs.readOnlyMode,
      enableDemoExecutionReported: eaInputs.enableDemoExecution,
      bridgeBlockers: masterBlockers,
    },
    routing: {
      effectiveRoutingMode: "SHARED_MASTER_MT5",
      routedViaMaster: true,
      sharedMasterAccountId: routing.sharedMasterAccountId,
      virtualAccountId: routing.virtualAccountId,
      masterConnectionId: conn?.id ?? null,
      routingBlockReason: null,
      routingNotes: routing.notes,
    },
  };
}

/**
 * MASTER_ACCOUNT_EXPOSURE guard (M06).
 *
 * Aggregates open lots already attributed to the master account across
 * all users (status IN 'pending','open'). If
 * `currentOpenLots + addingLot > maxTotalExposureLots`, refuse with
 * `MASTER_ACCOUNT_EXPOSURE_LIMIT_REACHED`.
 *
 * No-cap (maxTotalExposureLots <= 0 or NULL) means unrestricted.
 */
export async function checkMasterExposure(args: {
  sharedMasterAccountId: number;
  addingLot: number;
}): Promise<{ ok: boolean; reason?: string; currentOpenLots: number; cap: number | null }> {
  const [master] = await db
    .select()
    .from(sharedMasterAccountsTable)
    .where(eq(sharedMasterAccountsTable.id, args.sharedMasterAccountId))
    .limit(1);
  const cap = (master as { maxTotalExposureLots?: number | null } | undefined)
    ?.maxTotalExposureLots ?? null;
  // Sum currently open + pending attribution lots for this master.
  const rows = await db
    .select({
      total: sql<number>`COALESCE(SUM(${sharedTradeAttributionTable.lotSize}), 0)`,
    })
    .from(sharedTradeAttributionTable)
    .where(
      and(
        eq(sharedTradeAttributionTable.sharedMasterAccountId, args.sharedMasterAccountId),
        sql`${sharedTradeAttributionTable.status} IN ('pending','open')`,
      ),
    );
  const currentOpenLots = Number(rows[0]?.total ?? 0);
  if (cap !== null && cap > 0 && currentOpenLots + args.addingLot > cap) {
    return {
      ok: false,
      reason: "MASTER_ACCOUNT_EXPOSURE_LIMIT_REACHED",
      currentOpenLots,
      cap,
    };
  }
  return { ok: true, currentOpenLots, cap };
}

/**
 * Build the EA order-comment string. Format:
 *   `ARX|user:{userId}|cmd:{commandId}|src:{source}`
 *
 * Embedded in the demo command payload so the EA (no code changes) can
 * pass it through to MT5. If the broker/EA truncates the comment, the
 * server-side mapping by commandId + brokerTicket remains authoritative.
 */
export function buildArxOrderComment(args: {
  userId: number;
  commandId: string;
  source: string;
}): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_\-]/g, "").slice(0, 32);
  return `ARX|user:${args.userId}|cmd:${safe(args.commandId)}|src:${safe(args.source)}`;
}
