// Phase 28-MT5-OPS — Paper Beta Readiness Gate.
//
// Single user-scoped endpoint that bundles every check required to declare
// the system "PAPER BETA READY":
//   - Bridge connected read-only with fresh heartbeat
//   - Safety envelope intact (liveLocked / readOnlyMode / no execution)
//   - Command queue empty + all live commands force-blocked
//   - Per-user isolation active
//   - Paper-trade lifecycle endpoints mounted
//   - No secret leakage path
//
// Read-only. Records PAPER_BETA_GATE_RUN + PASSED/FAILED audit events. Never
// returns tokens. Never enables execution. Never sends MT5 commands.
import { Router, type Request } from "express";
import { db, mt5CommandsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import { recordSecurityEvent } from "../lib/security/events.js";
import { readRoleFromRequest } from "../lib/security/middleware.js";
import { buildBridgeOpsRollup } from "./mt5.js";

const router = Router();

const HEARTBEAT_THRESHOLD_SECONDS = 15;

async function audit(
  eventType: string,
  severity: "INFO" | "WARNING" | "HIGH",
  status: "ALLOWED" | "TRIGGERED" | "DENIED",
  req: Request,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await recordSecurityEvent({
      eventType,
      severity,
      status,
      actorUserId: (req as Request & { authUser?: { id: number } }).authUser?.id ?? null,
      route: req.path,
      method: req.method,
      ipAddress: null,
      userAgent: null,
      message: `Paper beta gate: ${eventType}`,
      metadata: { ...metadata, readOnlyMode: true, allowOrderExecution: false },
    });
  } catch (err) {
    req.log.warn({ err, eventType }, "Paper beta gate audit write failed (non-fatal)");
  }
}

type CheckResult = {
  id: string;
  label: string;
  // PASS = runtime-verified true. FAIL = runtime-verified false (gate blocks).
  // WARN = runtime-verified non-blocking observation. INFO = architectural
  // invariant covered by CI guards / route definition, surfaced here for
  // visibility but NOT a runtime probe (architect Phase 28-MT5-OPS review).
  status: "PASS" | "FAIL" | "WARN" | "INFO";
  detail: string;
};

router.get("/me/paper-beta-readiness", requireUser, async (req, res) => {
  const userId = req.authUser!.id;

  // 1. Bridge ops rollup — direct in-process call. NO internal HTTP fetch
  // (architect Phase 28-MT5-OPS review: avoids SSRF / cookie-forwarding via
  // attacker-influenced Host/X-Forwarded-Host headers). Caller role is
  // forwarded so gate sees the same redacted view a normal user would.
  const role = readRoleFromRequest(req);
  const bridge = await buildBridgeOpsRollup(role === "OWNER" || role === "ADMIN" ? "admin" : "user");

  const checks: CheckResult[] = [];

  // Bridge stable read-only. Decoupled from the bridgeMode string label
  // (which depends on the legacy MT5_BRIDGE_TOKEN env presence): we trust
  // heartbeat freshness + the safety envelope's commandExecutionAllowed=false
  // (architect feedback: env coupling produced false NOT_READY).
  const bridgeConnected = bridge.bridgeConnected;
  const heartbeatFresh = bridge.heartbeatFresh;
  const ageS = bridge.heartbeatAgeSeconds;
  const dup = bridge.duplicateEaSuspected;
  const bridgePass = bridgeConnected && heartbeatFresh && bridge.commandExecutionAllowed === false;
  checks.push({
    id: "bridge_read_only_stable",
    label: "MT5 bridge connected read-only and fresh",
    status: bridgePass ? (dup ? "WARN" : "PASS") : "FAIL",
    detail: bridgePass
      ? dup
        ? `Connected read-only, heartbeat age ${ageS}s, bridgeMode=${bridge.bridgeMode}. WARN: duplicate-EA suspected (${bridge.duplicateEaReason}) — observation only, gate still PASS.`
        : `Connected read-only, heartbeat age ${ageS}s, bridgeMode=${bridge.bridgeMode}, no duplicate-EA suspicion.`
      : `bridgeConnected=${bridgeConnected} heartbeatFresh=${heartbeatFresh} commandExecutionAllowed=${bridge.commandExecutionAllowed}`,
  });

  // Safety envelope intact (sourced directly from the rollup)
  const envelope = bridge.safetyEnvelope;
  const safetyPass =
    envelope.liveLocked === true &&
    envelope.readOnlyMode === true &&
    envelope.allowOrderExecution === false &&
    envelope.allowModification === false &&
    envelope.allowClose === false &&
    envelope.commandExecutionAllowed === false &&
    envelope.brokerPlacementImplemented === false;
  checks.push({
    id: "safety_envelope_intact",
    label: "Safety envelope intact (live-locked, read-only, no execution)",
    status: safetyPass ? "PASS" : "FAIL",
    detail: safetyPass ? "All safety flags hold." : `envelope=${JSON.stringify(envelope)}`,
  });

  // Command queue empty (this user). queueCommand() server-side hard-forces
  // BLOCKED, so any historical command should be BLOCKED / completed / failed /
  // cancelled / expired. PENDING / DELIVERED / claimed / sent are unexpected.
  const userCmds = await db.select().from(mt5CommandsTable).where(eq(mt5CommandsTable.userId, userId));
  const ACTIVE = new Set(["PENDING", "DELIVERED", "claimed", "sent", "executed"]);
  const pending = userCmds.filter((c) => c.status === "PENDING").length;
  const active = userCmds.filter((c) => ACTIVE.has(c.status)).length;
  const cmdPass = pending === 0 && active === 0;
  checks.push({
    id: "command_queue_force_blocked",
    label: "MT5 command queue empty and live commands force-blocked",
    status: cmdPass ? "PASS" : "FAIL",
    detail: cmdPass
      ? `User has ${userCmds.length} historical commands; 0 pending, 0 in-flight (all live attempts force-BLOCKED by queueCommand).`
      : `pending=${pending} in_flight=${active}`,
  });

  // Per-user isolation — architectural invariant (12/12 CI guards verify it
  // at build time). Surfaced as INFO, not a runtime probe.
  checks.push({
    id: "per_user_isolation",
    label: "Per-user isolation enforced on every user-scoped query",
    status: "INFO",
    detail: "All /me/* routes scope by req.authUser.id; bridge endpoints require per-user token. Verified by 12/12 CI guards at build time, not re-probed here.",
  });

  // Paper-flow endpoints — surfaced as INFO; presence is verified by CI
  // guard `arxRouterRegistrationSanity` at build time.
  const paperFlowEndpoints = [
    "POST /api/me/paper-trades",
    "POST /api/me/paper-trades/:id/open",
    "POST /api/me/paper-trades/:id/close",
    "GET  /api/me/paper-trades",
    "GET  /api/me/trade-journal",
    "GET  /api/me/notifications",
    "POST /api/analytics/snapshot",
  ];
  checks.push({
    id: "paper_flow_available",
    label: "Paper-trade lifecycle, journal, notifications, analytics endpoints mounted",
    status: "INFO",
    detail: `${paperFlowEndpoints.length} endpoints registered (verified by router-registration CI guard). End-to-end behaviour verified separately in Paper Mode Test #1.`,
  });

  // Secret leakage — RUNTIME sniff of the bridge rollup we just built. Fails
  // closed if any known env-secret value, raw bridge-token shape, or hex
  // hash appears in the response we will return.
  const envSecretKeys = ["MT5_BRIDGE_TOKEN", "SESSION_SECRET", "TWELVEDATA_API_KEY", "FINNHUB_API_KEY", "ALPHA_VANTAGE_API_KEY", "POLYGON_API_KEY", "NEWSAPI_API_KEY", "OPENAI_API_KEY"];
  const rollupSerialized = JSON.stringify(bridge);
  const leaks: string[] = [];
  for (const k of envSecretKeys) {
    const v = process.env[k];
    if (v && v.length >= 8 && rollupSerialized.includes(v)) leaks.push(k);
  }
  if (/arx_[a-z]+_[A-Za-z0-9_\-]{20,}/.test(rollupSerialized)) leaks.push("raw_arx_token_shape");
  if (/"apiKeyHash"\s*:\s*"[a-f0-9]{64}"/.test(rollupSerialized)) leaks.push("apiKeyHash_hex");
  const leakPass = leaks.length === 0;
  checks.push({
    id: "no_secret_leakage",
    label: "No secret values returned by diagnostic surfaces",
    status: leakPass ? "PASS" : "FAIL",
    detail: leakPass
      ? "Runtime scan of bridge-ops rollup found no env secret values, raw bridge-token shapes, or apiKeyHash hex values."
      : `Leak detected: ${leaks.join(", ")}`,
  });

  // Live execution lock — RUNTIME assertion against the rollup we just
  // built. The rollup is the same source the bridge-diagnostics route
  // serves, so if any of these become true the whole bridge surface goes
  // hot at the same time.
  const execLocked =
    bridge.allowOrderExecution === false &&
    bridge.allowModification === false &&
    bridge.allowClose === false &&
    bridge.commandExecutionAllowed === false &&
    bridge.safetyEnvelope.brokerPlacementImplemented === false;
  checks.push({
    id: "live_execution_blocked",
    label: "Live execution routes locked (allowOrderExecution / allowClose / allowModification / commandExecutionAllowed all false)",
    status: execLocked ? "PASS" : "FAIL",
    detail: execLocked
      ? "All four execution gates and brokerPlacementImplemented are false in the live bridge rollup."
      : `Execution-lock regression: allowOrderExecution=${bridge.allowOrderExecution} allowModification=${bridge.allowModification} allowClose=${bridge.allowClose} commandExecutionAllowed=${bridge.commandExecutionAllowed} brokerPlacementImplemented=${bridge.safetyEnvelope.brokerPlacementImplemented}`,
  });

  // INFO checks don't block readiness; only FAIL does.
  const failed = checks.filter((c) => c.status === "FAIL");
  const status: "READY" | "NOT_READY" = failed.length === 0 ? "READY" : "NOT_READY";
  const blockers = failed.map((c) => `${c.label}: ${c.detail}`);

  void audit("PAPER_BETA_GATE_RUN", "INFO", "ALLOWED", req, { checkCount: checks.length });
  void audit(
    status === "READY" ? "PAPER_BETA_GATE_PASSED" : "PAPER_BETA_GATE_FAILED",
    status === "READY" ? "INFO" : "WARNING",
    status === "READY" ? "ALLOWED" : "TRIGGERED",
    req,
    { blockers },
  );

  res.json({
    status,
    headline: status === "READY" ? "PAPER BETA READY" : "NOT PAPER BETA READY",
    blockers,
    checks,
    bridgeSummary: bridge
      ? {
          bridgeConnected: bridge["bridgeConnected"],
          heartbeatFresh: bridge["heartbeatFresh"],
          heartbeatAgeSeconds: bridge["heartbeatAgeSeconds"],
          bridgeMode: bridge["bridgeMode"],
          acceptedHeartbeatCount: bridge["acceptedHeartbeatCount"],
          rejectedHeartbeatCount: bridge["rejectedHeartbeatCount"],
          brokerSnapshotStatus: bridge["brokerSnapshotStatus"],
          duplicateEaSuspected: bridge["duplicateEaSuspected"],
        }
      : { error: "bridge-ops-monitor unreachable from gate" },
    safetyEnvelope: {
      liveLocked: true,
      readOnlyMode: true,
      allowOrderExecution: false,
      allowModification: false,
      allowClose: false,
      commandExecutionAllowed: false,
      brokerPlacementImplemented: false,
      safetyMode: "paper_only",
    },
    alertLanguage: {
      readOnlyAlert: "Read-only bridge alert — no trade was executed.",
      liveLocked: "Live execution remains locked.",
      commandsBlocked: "MT5 commands remain blocked.",
    },
    serverTime: new Date().toISOString(),
    note: "Gate is read-only. No execution unlock. No MT5 command was queued. Token values are never returned.",
  });
});

export default router;
