// Master Bridge LIVE — Current Connected Bridge Detector
//
// Selects the **freshest REAL-mode** MT5 bridge that satisfies every
// readiness criterion required to act as the platform master live bridge.
//
// Selection priority (in order — all are AND-ed):
//   1. mode = 'LIVE' (i.e. real EA heartbeat — not 'MOCK', not 'DEMO')
//   2. lastHeartbeat present
//   3. heartbeat age ≤ LIVE_HEARTBEAT_MAX_AGE_SEC
//   4. eaVersion ≥ MIN_LIVE_EA_VERSION (1.27)
//   5. accountType ∈ {live, real}
//   6. capabilities.eaInputs.terminalConnected = true
//   7. capabilities.eaInputs.algoTradingAllowed = true
//   8. capabilities.eaInputs.readOnlyMode = false
//   9. capabilities.eaInputs.enableLiveExecution = true
//  10. tokenRevokedAt IS NULL  (token still accepted)
//  11. brokerName present     (broker/server present)
//  12. accountNumber present  (MT5 account number present)
//  13. mode != 'MOCK'          (already covered by #1; assertive)
//
// If a candidate matches every criterion → returns OK with the bridge
// row (caller may persist its id as platform_master_bridge_connection_id).
//
// If no candidate matches → returns BLOCKED with a single primary reason
// describing the first failing gate against the freshest non-revoked
// real-mode row (so the operator UI can show a concrete "what's missing"
// message). The block reasons map 1:1 to the user-spec strings:
//   - MASTER_LIVE_REQUIRES_REAL_BRIDGE
//   - MASTER_BRIDGE_HEARTBEAT_STALE
//   - MASTER_BRIDGE_REAL_HEARTBEAT_REQUIRED  (latest heartbeat is MOCK)
//   - MASTER_BRIDGE_EA_VERSION_TOO_OLD
//   - MASTER_BRIDGE_NOT_LIVE_CAPABLE         (eaInputs / accountType bad)
//   - NO_BRIDGE_REGISTERED
//
// SECURITY: helper never returns raw bridge tokens, apiKeyHash, or full
// account numbers in its `evidence` payload. The caller (route layer) is
// responsible for further masking. Account number is included raw here
// because OPERATOR/ADMIN-scoped callers need it; the route layer masks
// it before serving.
import { and, desc, isNull, sql } from "drizzle-orm";
import { db, mt5ConnectionTable } from "@workspace/db";
import {
  MIN_LIVE_EA_VERSION,
  LIVE_HEARTBEAT_MAX_AGE_SEC,
} from "@workspace/domain/safety-contracts/livePhaseBDispatchGate";

export type CurrentConnectedBridgeBlockReason =
  | "MASTER_LIVE_REQUIRES_REAL_BRIDGE"
  | "MASTER_BRIDGE_HEARTBEAT_STALE"
  | "MASTER_BRIDGE_REAL_HEARTBEAT_REQUIRED"
  | "MASTER_BRIDGE_EA_VERSION_TOO_OLD"
  | "MASTER_BRIDGE_NOT_LIVE_CAPABLE"
  | "NO_BRIDGE_REGISTERED";

export interface DetectedBridgeEvidence {
  bridgeId: number;
  userId: number | null;
  mode: string;
  accountType: string;
  eaVersion: string | null;
  brokerName: string | null;
  serverName: string | null;
  accountNumber: string | null;
  lastHeartbeat: Date | null;
  heartbeatAgeSec: number | null;
  eaInputs: {
    terminalConnected: boolean | null;
    algoTradingAllowed: boolean | null;
    readOnlyMode: boolean | null;
    enableLiveExecution: boolean | null;
    enableDemoExecution: boolean | null;
    maxLiveLot: number | null;
    // EA v1.50 diagnostic subfields — name WHICH MT5 flag / ARM is off.
    // Optional so existing evidence literals (tests/QA) keep compiling; the
    // master-live gate still decides on the four core fields above only.
    terminalTradeAllowed?: boolean | null;
    mqlTradeAllowed?: boolean | null;
    expertTradeAllowed?: boolean | null;
    accountTradeAllowed?: boolean | null;
    arm1?: boolean | null;
    arm2OrderSend?: boolean | null;
    arm3?: boolean | null;
    arm4?: boolean | null;
    arm5?: boolean | null;
    arm6?: boolean | null;
    arm7?: boolean | null;
    arm8?: boolean | null;
  };
  tokenRevokedAt: Date | null;
}

export type DetectorResult =
  | { ok: true; bridge: DetectedBridgeEvidence }
  | {
      ok: false;
      primaryReason: CurrentConnectedBridgeBlockReason;
      // Best-effort hint of what we DID see (may be null when nothing
      // is registered). Always safe to render to operators — no secrets.
      latestHint: DetectedBridgeEvidence | null;
    };

function compareEaVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db_ = pb[i] ?? 0;
    if (da !== db_) return da - db_;
  }
  return 0;
}

function extractEaInputs(capabilities: unknown): DetectedBridgeEvidence["eaInputs"] {
  const caps = (capabilities ?? {}) as { eaInputs?: Record<string, unknown> };
  const ea = (caps.eaInputs ?? {}) as Record<string, unknown>;
  const b = (k: string): boolean | null =>
    typeof ea[k] === "boolean" ? (ea[k] as boolean) : null;
  const n = (k: string): number | null => {
    const v = ea[k];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  return {
    terminalConnected: b("terminalConnected"),
    algoTradingAllowed: b("algoTradingAllowed"),
    readOnlyMode: b("readOnlyMode"),
    enableLiveExecution: b("enableLiveExecution"),
    enableDemoExecution: b("enableDemoExecution"),
    maxLiveLot: n("maxLiveLot"),
    terminalTradeAllowed: b("terminalTradeAllowed"),
    mqlTradeAllowed: b("mqlTradeAllowed"),
    expertTradeAllowed: b("expertTradeAllowed"),
    accountTradeAllowed: b("accountTradeAllowed"),
    arm1: b("arm1"),
    arm2OrderSend: b("arm2OrderSend"),
    arm3: b("arm3"),
    arm4: b("arm4"),
    arm5: b("arm5"),
    arm6: b("arm6"),
    arm7: b("arm7"),
    arm8: b("arm8"),
  };
}

function toEvidence(row: typeof mt5ConnectionTable.$inferSelect, nowMs: number): DetectedBridgeEvidence {
  const hb = row.lastHeartbeat ? new Date(row.lastHeartbeat) : null;
  const ageSec = hb ? Math.max(0, Math.floor((nowMs - hb.getTime()) / 1000)) : null;
  return {
    bridgeId: row.id,
    userId: row.userId ?? null,
    mode: row.mode,
    accountType: row.accountType,
    eaVersion: row.eaVersion,
    brokerName: row.brokerName,
    serverName: row.serverName,
    accountNumber: row.accountNumber,
    lastHeartbeat: hb,
    heartbeatAgeSec: ageSec,
    eaInputs: extractEaInputs(row.capabilities),
    tokenRevokedAt: row.tokenRevokedAt ? new Date(row.tokenRevokedAt) : null,
  };
}

/**
 * Pure evaluator — given a single bridge evidence object, decide whether
 * it qualifies as the current connected master live bridge. Returns the
 * first failing gate (or null on PASS). Exported for tests and the QA
 * script — never imports anything async.
 */
export function evaluateBridgeAsMasterLive(e: DetectedBridgeEvidence):
  | { ok: true }
  | { ok: false; reason: CurrentConnectedBridgeBlockReason } {
  if (e.mode === "MOCK") return { ok: false, reason: "MASTER_BRIDGE_REAL_HEARTBEAT_REQUIRED" };
  if (e.mode !== "LIVE") return { ok: false, reason: "MASTER_LIVE_REQUIRES_REAL_BRIDGE" };
  if (e.tokenRevokedAt) return { ok: false, reason: "MASTER_LIVE_REQUIRES_REAL_BRIDGE" };
  if (!e.lastHeartbeat || e.heartbeatAgeSec == null) {
    return { ok: false, reason: "MASTER_BRIDGE_HEARTBEAT_STALE" };
  }
  if (e.heartbeatAgeSec > LIVE_HEARTBEAT_MAX_AGE_SEC) {
    return { ok: false, reason: "MASTER_BRIDGE_HEARTBEAT_STALE" };
  }
  if (!e.eaVersion || compareEaVersion(e.eaVersion, MIN_LIVE_EA_VERSION) < 0) {
    return { ok: false, reason: "MASTER_BRIDGE_EA_VERSION_TOO_OLD" };
  }
  const acct = (e.accountType ?? "").toLowerCase();
  if (acct !== "live" && acct !== "real") {
    return { ok: false, reason: "MASTER_LIVE_REQUIRES_REAL_BRIDGE" };
  }
  const ea = e.eaInputs;
  if (ea.terminalConnected !== true) return { ok: false, reason: "MASTER_BRIDGE_NOT_LIVE_CAPABLE" };
  if (ea.algoTradingAllowed !== true) return { ok: false, reason: "MASTER_BRIDGE_NOT_LIVE_CAPABLE" };
  if (ea.readOnlyMode !== false) return { ok: false, reason: "MASTER_BRIDGE_NOT_LIVE_CAPABLE" };
  if (ea.enableLiveExecution !== true) return { ok: false, reason: "MASTER_BRIDGE_NOT_LIVE_CAPABLE" };
  if (!e.brokerName) return { ok: false, reason: "MASTER_BRIDGE_NOT_LIVE_CAPABLE" };
  if (!e.accountNumber) return { ok: false, reason: "MASTER_BRIDGE_NOT_LIVE_CAPABLE" };
  return { ok: true };
}

/**
 * Detect the current connected bridge. Reads the freshest non-revoked
 * mt5_connection row of mode='LIVE'; if that row passes
 * `evaluateBridgeAsMasterLive`, returns OK; otherwise returns BLOCKED
 * with the first failing gate. Falls back to the freshest non-revoked
 * row of ANY mode so the operator UI can surface a useful hint when no
 * real EA has ever connected.
 */
export async function detectCurrentConnectedBridge(): Promise<DetectorResult> {
  const now = Date.now();
  // Walk LIVE-mode candidates by freshness; return the FIRST that
  // satisfies every gate of `evaluateBridgeAsMasterLive`. This is the
  // "freshest qualifying" selection — a slightly older LIVE row that
  // passes all gates is preferred over a fresher LIVE row that fails
  // (e.g., ReadOnlyMode=true). Bounded at 16 candidates so a misbehaving
  // EA cluster can never widen the scan.
  const liveRows = await db.select().from(mt5ConnectionTable).where(and(
    sql`${mt5ConnectionTable.mode} = 'LIVE'`,
    isNull(mt5ConnectionTable.tokenRevokedAt),
  )).orderBy(desc(mt5ConnectionTable.lastHeartbeat)).limit(16);

  if (liveRows.length > 0) {
    let freshestFailHint: DetectedBridgeEvidence | null = null;
    let freshestFailReason: CurrentConnectedBridgeBlockReason | null = null;
    for (const row of liveRows) {
      const ev = toEvidence(row, now);
      const v = evaluateBridgeAsMasterLive(ev);
      if (v.ok) return { ok: true, bridge: ev };
      if (freshestFailHint == null) {
        freshestFailHint = ev;
        freshestFailReason = v.reason;
      }
    }
    return {
      ok: false,
      primaryReason: freshestFailReason ?? "MASTER_LIVE_REQUIRES_REAL_BRIDGE",
      latestHint: freshestFailHint,
    };
  }

  // No LIVE-mode row at all → look at the freshest non-revoked row of
  // any mode so the operator sees what IS connected.
  const anyRows = await db.select().from(mt5ConnectionTable).where(
    isNull(mt5ConnectionTable.tokenRevokedAt),
  ).orderBy(desc(mt5ConnectionTable.lastHeartbeat)).limit(1);

  if (anyRows.length === 0) {
    return { ok: false, primaryReason: "NO_BRIDGE_REGISTERED", latestHint: null };
  }
  const ev = toEvidence(anyRows[0]!, now);
  // If the freshest is MOCK, surface the explicit "real heartbeat required"
  // reason the spec calls out; otherwise treat it as needing a real bridge.
  const reason: CurrentConnectedBridgeBlockReason =
    ev.mode === "MOCK"
      ? "MASTER_BRIDGE_REAL_HEARTBEAT_REQUIRED"
      : "MASTER_LIVE_REQUIRES_REAL_BRIDGE";
  return { ok: false, primaryReason: reason, latestHint: ev };
}

/**
 * Mask helper for routes that may render evidence to non-OWNER operators
 * or to authenticated users. Keeps brokerName + accountNumber masked +
 * EA version + heartbeat age + the boolean readiness flags. Never returns
 * userId, accountNumber raw, or serverName.
 */
export function maskBridgeEvidenceForUser(ev: DetectedBridgeEvidence): {
  bridgeId: number;
  brokerName: string | null;
  accountNumberMasked: string | null;
  eaVersion: string | null;
  heartbeatAgeSec: number | null;
  accountType: string;
  mode: string;
  readOnlyMode: boolean | null;
  enableLiveExecution: boolean | null;
  enableDemoExecution: boolean | null;
  terminalConnected: boolean | null;
  algoTradingAllowed: boolean | null;
  maxLiveLot: number | null;
} {
  const acc = ev.accountNumber ?? null;
  const masked = acc && acc.length > 2 ? `••••${acc.slice(-2)}` : acc;
  return {
    bridgeId: ev.bridgeId,
    brokerName: ev.brokerName,
    accountNumberMasked: masked,
    eaVersion: ev.eaVersion,
    heartbeatAgeSec: ev.heartbeatAgeSec,
    accountType: ev.accountType,
    mode: ev.mode,
    readOnlyMode: ev.eaInputs.readOnlyMode,
    enableLiveExecution: ev.eaInputs.enableLiveExecution,
    enableDemoExecution: ev.eaInputs.enableDemoExecution,
    terminalConnected: ev.eaInputs.terminalConnected,
    algoTradingAllowed: ev.eaInputs.algoTradingAllowed,
    maxLiveLot: ev.eaInputs.maxLiveLot,
  };
}
