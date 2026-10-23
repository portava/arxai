// Phase 28-MT5-DEMO-FOUNDATION — Per-user demo-execution readiness endpoint.
//
// Read-only. Calls `runDemoVerificationGate` in-process (no internal HTTP).
// Records DEMO_VERIFICATION_GATE_RUN and DEMO_VERIFICATION_GATE_PASSED/FAILED
// audit events. NEVER returns tokens, hashes, or secrets. NEVER mutates.
//
// Independent of arming: the response always includes
// `canArmExecution: false` because `EXECUTION_PATHS_BUILT === false` in
// this build.

import { Router, type Request } from "express";
import { requireUser } from "../lib/auth/middleware.js";
import { recordSecurityEvent } from "../lib/security/events.js";
import { runDemoVerificationGate } from "../lib/mt5/demoVerificationGate.js";
import { getDuplicateEaProbe } from "./mt5.js";

const router = Router();

router.get("/me/demo-execution-readiness", requireUser, async (req: Request, res) => {
  const authUser = (req as Request & { authUser?: { id: number } }).authUser;
  const userId = authUser?.id;
  if (!userId) {
    res.status(401).json({ error: "AUTH_REQUIRED" });
    return;
  }
  const probe = getDuplicateEaProbe();
  let result;
  try {
    result = await runDemoVerificationGate({
      userId,
      duplicateEaProbe: { suspected: probe.suspected, reason: probe.reason ?? null },
    });
  } catch (err) {
    req.log.error({ err }, "demo_verification_gate_error");
    res.status(500).json({
      status: "NOT_READY",
      blockers: ["GATE_ERROR"],
      headline: "Demo verification gate failed to execute. Refusing.",
      canArmExecution: false,
    });
    return;
  }

  // Audit — every run. Non-fatal: gate availability must not depend on audit DB health.
  try {
    await recordSecurityEvent({
      eventType: "DEMO_VERIFICATION_GATE_RUN",
      severity: "INFO",
      status: "ALLOWED",
      actorUserId: userId,
      route: "/api/me/demo-execution-readiness",
      method: "GET",
      metadata: {
        status: result.status,
        blockerCount: result.blockers.length,
        accountTypeReported: result.evidence.accountTypeReported,
        heartbeatAgeSeconds: result.evidence.heartbeatAgeSeconds,
      },
    });
    await recordSecurityEvent({
      eventType: result.status === "VERIFIED_DEMO"
        ? "DEMO_VERIFICATION_GATE_PASSED"
        : "DEMO_VERIFICATION_GATE_FAILED",
      severity: result.status === "VERIFIED_DEMO" ? "INFO" : "WARNING",
      status: result.status === "VERIFIED_DEMO" ? "ALLOWED" : "DENIED",
      actorUserId: userId,
      route: "/api/me/demo-execution-readiness",
      method: "GET",
      metadata: {
        blockers: result.blockers,
        executionMode: result.executionMode,
        safetyGateSnapshot: result.safetyGateSnapshot,
      },
    });
  } catch (auditErr) {
    req.log.warn({ err: auditErr }, "demo_verification_gate_audit_write_failed_non_fatal");
  }

  // Defensive runtime assertion: response must NEVER weaken the LIVE-locked
  // safety envelope. (Phase 28-MT5-DEMO-ARMING sub-phase 3B: brokerDispatchBuilt
  // and canDispatchToMt5Allowed may legitimately flip to true for a fully-gated
  // per-user demo flow; live execution, command execution, broker placement,
  // shared routing, and auto-close behaviour MUST remain locked.)
  const s = result.safetyGateSnapshot;
  if (s.liveLocked !== true
    || s.allowOrderExecution !== false
    || s.commandExecutionAllowed !== false
    || s.brokerPlacementImplemented !== false
    || s.autoCloseMode !== "ALERT_ONLY"
    || s.sharedMt5RoutingBlocked !== true) {
    req.log.error({ headline: result.headline }, "demo_gate_invariant_violation_dispatch_must_be_blocked");
    res.status(500).json({
      status: "NOT_READY",
      blockers: ["INVARIANT_VIOLATION"],
      headline: "Refusing — invariant violation detected.",
      canArmExecution: false,
    });
    return;
  }

  res.json(result);
});

export default router;
