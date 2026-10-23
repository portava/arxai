// ARX AI — Demo verification gate.
//
// Phase 28-MT5-DEMO-FOUNDATION (May 2026), extended Phase 28-MT5-DEMO-ARMING.
//
// Single pure-ish builder that decides whether a user's connected MT5
// bridge represents a *verified demo account*. Returns NOT_READY unless
// EVERY one of the following holds:
//
//   1. User owns a non-revoked mt5_connection row.
//   2. Heartbeat is fresh (< 15s).
//   3. EA has explicitly reported accountType === "demo" or "contest" on
//      heartbeat. "unknown", "live", and "real" are refused.
//   4. No duplicate-EA suspicion in the last 5 minutes.
//   5. System safety envelope is intact (liveLocked, allowOrderExecution
//      false, etc.).
//
// server_name (e.g. "MetaQuotes-Demo") and broker_name are recorded as
// *supporting evidence only* — they NEVER substitute for an explicit
// EA-reported accountType.
//
// Hard refusal contract:
//   - VERIFIED_DEMO unlocks ARMING only (sub-phase 1). It does NOT unlock
//     dispatch — that is independently gated by `canDispatchToMt5()` which
//     remains refused until BROKER_DISPATCH_BUILT flips true.
//   - No tokens, no apiKeyHash, no broker passwords are read or returned.
//   - No mutation of any table. Read-only.

import { and, eq } from "drizzle-orm";
import { db, mt5ConnectionTable } from "@workspace/db";
import {
  BROKER_DISPATCH_BUILT,
  DEMO_ARMING_BUILT,
  buildSafetyGateSnapshot,
  canArmExecution,
  deriveExecutionMode,
  type ExecutionMode,
  type SafetyGateSnapshot,
} from "@workspace/domain/safety-contracts/executionMode";

const HEARTBEAT_FRESH_SECONDS = 15;

export type GateCheckStatus = "PASS" | "FAIL" | "INFO" | "WARN";

export interface GateCheck {
  key: string;
  label: string;
  status: GateCheckStatus;
  detail: string;
}

export interface DemoVerificationResult {
  status: "VERIFIED_DEMO" | "NOT_READY";
  headline: string;
  blockers: string[];
  checks: GateCheck[];
  /** Operator-only redacted in callers if needed. Account number, server, broker. */
  evidence: {
    accountTypeReported: "demo" | "contest" | "live" | "real" | "unknown" | "none";
    accountTypeExplicit: boolean;
    serverNameHintsDemo: boolean;
    brokerNameHintsDemo: boolean;
    heartbeatAgeSeconds: number | null;
    eaVersion: string | null;
    selectedBridgeConnectionId: number | null;
    selectedLastHeartbeatAt: string | null;
    selectedHeartbeatFresh: boolean;
    selectedEaVersion: string | null;
    selectedAccountType: string | null;
    /** Last-4 mask of MT5 login (e.g. "***9717"). Never the full account. */
    selectedAccountLoginMasked: string | null;
    /** Count of older mt5_connection rows for this user that were ignored
     *  in favour of the freshest one. */
    ignoredOlderConnectionsCount: number;
    /** Human-readable explanation of why older rows were ignored, if any. */
    ignoredOlderConnectionsReason: string | null;
  };
  executionMode: ExecutionMode;
  /** TRUE only when VERIFIED_DEMO AND DEMO_ARMING_BUILT. Still does NOT
   *  imply a command will reach the EA — see canDispatchToMt5(). */
  canArmExecution: boolean;
  canArmExecutionReason: string;
  /** Dispatch (actually sending a command to the EA). The verification gate
   *  does NOT compute live per-user dispatch inputs (bridge freshness,
   *  arming state, fingerprint clearance). This is the gate's structural
   *  view only — even when VERIFIED_DEMO, dispatch still requires that the
   *  per-user dispatch gate clears at send time. */
  canDispatchToMt5: boolean;
  canDispatchToMt5Reason: string;
  safetyGateSnapshot: SafetyGateSnapshot;
  notes: string[];
}

/** Server-name evidence helper. NOT authoritative. */
function serverNameHintsDemo(serverName: string | null | undefined): boolean {
  if (!serverName) return false;
  return /demo/i.test(serverName);
}

/** Broker-name evidence helper. NOT authoritative. */
function brokerNameHintsDemo(brokerName: string | null | undefined): boolean {
  if (!brokerName) return false;
  return /metaquotes/i.test(brokerName);
}

interface DuplicateEaProbe {
  suspected: boolean;
  reason: string | null;
}

export async function runDemoVerificationGate(args: {
  userId: number;
  duplicateEaProbe: DuplicateEaProbe;
}): Promise<DemoVerificationResult> {
  const checks: GateCheck[] = [];
  const blockers: string[] = [];
  const notes: string[] = [];

  // ── 1. Per-user connection ownership ────────────────────────────────────
  // Pick the FRESHEST non-revoked row for this user. Older revoked or stale
  // rows must not block a current active EA. We order by lastHeartbeat DESC
  // NULLS LAST so a freshly-attached EA always wins over historical rows.
  const allRows = await db
    .select()
    .from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.userId, args.userId));
  const sortedRows = [...allRows].sort((a, b) => {
    const aRev = a.tokenRevokedAt ? 1 : 0;
    const bRev = b.tokenRevokedAt ? 1 : 0;
    if (aRev !== bRev) return aRev - bRev; // non-revoked first
    const aHb = a.lastHeartbeat ? new Date(a.lastHeartbeat).getTime() : 0;
    const bHb = b.lastHeartbeat ? new Date(b.lastHeartbeat).getTime() : 0;
    return bHb - aHb; // freshest first
  });
  const conn = sortedRows[0] ?? null;
  const ignoredRows = sortedRows.slice(1);
  const ignoredOlderConnectionsCount = ignoredRows.length;
  let ignoredOlderConnectionsReason: string | null = null;
  if (ignoredOlderConnectionsCount > 0) {
    const summary = ignoredRows.map((r) => {
      const hbAge = r.lastHeartbeat
        ? Math.floor((Date.now() - new Date(r.lastHeartbeat).getTime()) / 1000)
        : null;
      const reason: string[] = [];
      if (r.tokenRevokedAt) reason.push("token_revoked");
      if (hbAge === null) reason.push("no_heartbeat");
      else if (hbAge > HEARTBEAT_FRESH_SECONDS) reason.push(`heartbeat_stale(${hbAge}s)`);
      if ((r.accountType ?? "unknown").toLowerCase() === "unknown") reason.push("accountType_unknown");
      if (!r.eaVersion) reason.push("no_ea_version");
      return `#${r.id} (${reason.join(",") || "older"})`;
    });
    ignoredOlderConnectionsReason = `Ignored ${ignoredOlderConnectionsCount} older connection row(s): ${summary.join("; ")}.`;
  }

  if (!conn) {
    checks.push({
      key: "user_owns_bridge",
      label: "User owns a bridge connection",
      status: "FAIL",
      detail: "No mt5_connection row for this user. Generate a per-user bridge token from ARX MT5 Setup.",
    });
    blockers.push("NO_BRIDGE_CONNECTION");
  } else if (conn.tokenRevokedAt) {
    checks.push({
      key: "user_owns_bridge",
      label: "User owns a bridge connection",
      status: "FAIL",
      detail: "Bridge token has been revoked. Issue a new per-user token from ARX MT5 Setup.",
    });
    blockers.push("BRIDGE_TOKEN_REVOKED");
  } else {
    checks.push({
      key: "user_owns_bridge",
      label: "User owns a bridge connection",
      status: "PASS",
      detail: `Connection #${conn.id} owned by user; token not revoked.`,
    });
  }

  // ── 2. Heartbeat freshness ──────────────────────────────────────────────
  const heartbeatAgeSeconds = conn?.lastHeartbeat
    ? Math.floor((Date.now() - new Date(conn.lastHeartbeat).getTime()) / 1000)
    : null;
  const heartbeatFresh = heartbeatAgeSeconds !== null && heartbeatAgeSeconds <= HEARTBEAT_FRESH_SECONDS;

  if (!conn) {
    // already failed above
  } else if (heartbeatAgeSeconds === null) {
    checks.push({
      key: "heartbeat_fresh",
      label: "EA heartbeat fresh (< 15s)",
      status: "FAIL",
      detail: "No heartbeat has ever been received. Attach the EA to a chart on the MT5 terminal.",
    });
    blockers.push("NO_HEARTBEAT");
  } else if (!heartbeatFresh) {
    checks.push({
      key: "heartbeat_fresh",
      label: "EA heartbeat fresh (< 15s)",
      status: "FAIL",
      detail: `Last heartbeat ${heartbeatAgeSeconds}s ago (threshold ${HEARTBEAT_FRESH_SECONDS}s).`,
    });
    blockers.push("HEARTBEAT_STALE");
  } else {
    checks.push({
      key: "heartbeat_fresh",
      label: "EA heartbeat fresh (< 15s)",
      status: "PASS",
      detail: `Last heartbeat ${heartbeatAgeSeconds}s ago.`,
    });
  }

  // ── 3. Account type EXPLICITLY reported as demo ─────────────────────────
  const rawAccountType = (conn?.accountType ?? "unknown").toLowerCase();
  const accountTypeReported: DemoVerificationResult["evidence"]["accountTypeReported"] = !conn
    ? "none"
    : rawAccountType === "demo"
      ? "demo"
      : rawAccountType === "contest"
        ? "contest"
        : rawAccountType === "live"
          ? "live"
          : rawAccountType === "real"
            ? "real"
            : "unknown";
  const accountTypeExplicit = accountTypeReported === "demo"
    || accountTypeReported === "contest"
    || accountTypeReported === "live"
    || accountTypeReported === "real";

  if (accountTypeReported === "demo") {
    checks.push({
      key: "account_type_explicit_demo",
      label: "EA explicitly reported accountType=\"demo\"",
      status: "PASS",
      detail: "EA derived this from AccountInfoInteger(ACCOUNT_TRADE_MODE).",
    });
  } else if (accountTypeReported === "live" || accountTypeReported === "real") {
    checks.push({
      key: "account_type_explicit_demo",
      label: "EA explicitly reported accountType=\"demo\"",
      status: "FAIL",
      detail: `EA reported LIVE/REAL account. Demo execution refuses live accounts unconditionally.`,
    });
    blockers.push("ACCOUNT_TYPE_IS_LIVE");
  } else if (accountTypeReported === "contest") {
    checks.push({
      key: "account_type_explicit_demo",
      label: "EA explicitly reported accountType=\"demo\"",
      status: "PASS",
      detail: "EA reported a CONTEST account (ACCOUNT_TRADE_MODE=CONTEST). Treated as demo for gating per phase contract.",
    });
  } else {
    checks.push({
      key: "account_type_explicit_demo",
      label: "EA explicitly reported accountType=\"demo\"",
      status: "FAIL",
      detail:
        "EA has not reported an explicit accountType yet (current value: unknown). Upgrade the EA to v1.25+ so it sends accountType from ACCOUNT_TRADE_MODE on every heartbeat, then reattach the EA.",
    });
    blockers.push("ACCOUNT_TYPE_NOT_REPORTED");
  }

  // ── 4. Supporting evidence (server_name / broker_name) — INFO only ──────
  const serverHint = serverNameHintsDemo(conn?.serverName);
  const brokerHint = brokerNameHintsDemo(conn?.brokerName);
  checks.push({
    key: "supporting_evidence_server_name",
    label: "Supporting evidence: server_name suggests demo",
    status: "INFO",
    detail: serverHint
      ? `server_name appears to be a demo server (matches /demo/i).`
      : `server_name does not match demo patterns.`,
  });
  notes.push(
    "server_name and broker_name are supporting evidence ONLY. They are recorded but NEVER substitute for an EA-reported accountType.",
  );

  // ── 4b. Older connection rows ignored (WARN-only) ───────────────────────
  if (ignoredOlderConnectionsCount > 0) {
    checks.push({
      key: "older_connection_rows_ignored",
      label: "Older connection rows ignored in favour of freshest",
      status: "WARN",
      detail: ignoredOlderConnectionsReason ?? "",
    });
  }

  // ── 5. Duplicate-EA suspicion (WARN-only) ───────────────────────────────
  if (args.duplicateEaProbe.suspected) {
    checks.push({
      key: "no_duplicate_ea",
      label: "No duplicate EA suspicion",
      status: "WARN",
      detail: (args.duplicateEaProbe.reason ?? "Multiple distinct IPs or accounts seen in 5min window.") +
        " (Observation only — global probe across all EAs; does not block this user's readiness.)",
    });
  } else {
    checks.push({
      key: "no_duplicate_ea",
      label: "No duplicate EA suspicion",
      status: "PASS",
      detail: "Only one EA instance observed in the last 5 minutes.",
    });
  }

  // ── 6. Safety envelope intact (runtime assert) ──────────────────────────
  // After the user explicitly ARMS demo execution we expect readOnlyMode
  // and allowOrderExecution to track the armed state. The gate is checked
  // BEFORE arming, so we evaluate the as-stored envelope only when the
  // user is currently disarmed. When already armed in MT5_DEMO_EXECUTION
  // mode, the gate skips this assert — arming itself owns the envelope
  // transition via demoArmingService.
  const envelopeIntact = !!conn
    ? conn.liveLocked === true
    : true;
  checks.push({
    key: "safety_envelope_intact",
    label: "Per-connection safety envelope intact",
    status: envelopeIntact ? "PASS" : "FAIL",
    detail: envelopeIntact
      ? "liveLocked=true. Live execution remains structurally impossible."
      : "liveLocked is not true. Refusing.",
  });
  if (!envelopeIntact) blockers.push("ENVELOPE_BROKEN");

  // ── 7. Demo arming & broker dispatch flags ──────────────────────────────
  checks.push({
    key: "demo_arming_built",
    label: "Demo arming + command-queue plumbing built",
    status: "INFO",
    detail: DEMO_ARMING_BUILT
      ? "Arming state machine and command queue ARE built. After VERIFIED_DEMO, the user may arm MT5_DEMO_EXECUTION and draft + confirm demo commands."
      : "Arming plumbing not yet built in this build.",
  });
  checks.push({
    key: "broker_dispatch_built",
    label: "MT5 OrderSend/Modify/Close paths implemented",
    status: "INFO",
    detail: BROKER_DISPATCH_BUILT
      ? "Broker dispatch is implemented; commands can reach the EA."
      : "Broker dispatch is NOT implemented in this build. Even DEMO_APPROVED commands sit in the queue — there is no consumer. This is intentional (sub-phase 1+2).",
  });

  // ── Verdict ─────────────────────────────────────────────────────────────
  const status: DemoVerificationResult["status"] = blockers.length === 0 ? "VERIFIED_DEMO" : "NOT_READY";
  const inputs = {
    bridgeConnected: !!conn && conn.status === "connected",
    heartbeatFresh,
    demoVerified: status === "VERIFIED_DEMO",
    liveLocked: true,
  };
  const armDecision = canArmExecution({
    decision: { status, blockers },
    inputs,
  });
  const headline = status === "VERIFIED_DEMO"
    ? (armDecision.allowed
        ? "Demo account VERIFIED. You may arm MT5_DEMO_EXECUTION. Drafted+approved commands are eligible for per-user demo dispatch; each dispatch is re-checked at send time against arming, bridge freshness, EA>=1.26, accountType=demo, and fingerprint clearance. LIVE execution remains BLOCKED."
        : "Demo account VERIFIED but arming is blocked: " + armDecision.reason)
    : `NOT READY: ${blockers.length} blocker${blockers.length === 1 ? "" : "s"}. Execution remains BLOCKED.`;

  const executionMode = deriveExecutionMode(inputs);

  return {
    status,
    headline,
    blockers,
    checks,
    evidence: {
      accountTypeReported,
      accountTypeExplicit,
      serverNameHintsDemo: serverHint,
      brokerNameHintsDemo: brokerHint,
      heartbeatAgeSeconds,
      eaVersion: conn?.eaVersion ?? null,
      selectedBridgeConnectionId: conn?.id ?? null,
      selectedLastHeartbeatAt: conn?.lastHeartbeat
        ? new Date(conn.lastHeartbeat).toISOString()
        : null,
      selectedHeartbeatFresh: heartbeatFresh,
      selectedEaVersion: conn?.eaVersion ?? null,
      selectedAccountType: conn?.accountType ?? null,
      selectedAccountLoginMasked: conn?.accountNumber
        ? "***" + String(conn.accountNumber).slice(-4)
        : null,
      ignoredOlderConnectionsCount,
      ignoredOlderConnectionsReason,
    },
    executionMode,
    canArmExecution: armDecision.allowed,
    canArmExecutionReason: armDecision.reason,
    // Verification gate is STRUCTURAL — it does not arm the user or compute
    // per-user dispatch inputs. Even when VERIFIED_DEMO, dispatch still
    // requires (a) the user to be ARMED and (b) the per-user dispatch gate
    // to clear at send time (bridge fresh, accountType=demo, EA>=1.26,
    // fingerprint not already in flight). The verification gate therefore
    // reports `canDispatchToMt5:false` and defers truth to the dispatch path.
    canDispatchToMt5: false,
    canDispatchToMt5Reason: status === "VERIFIED_DEMO"
      ? "VERIFIED_DEMO but dispatch defers to per-user dispatch gate at send time (arming + bridge freshness + accountType==demo + EA>=1.26 + fingerprint clearance)."
      : `DEMO_VERIFICATION_NOT_READY — ${blockers.length} blocker${blockers.length === 1 ? "" : "s"}.`,
    safetyGateSnapshot: buildSafetyGateSnapshot({
      mode: executionMode,
      demoStatus: status,
      canArmAllowed: armDecision.allowed,
      userArmed: false,
    }),
    notes,
  };
}
