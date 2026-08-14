import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod/v4";
import { db, mt5CommandsTable, mt5StateTable, mt5ConnectionTable, riskSettingsTable, sharedMasterAccountsTable, sharedTradeAttributionTable, arxSymbolSpecsTable } from "@workspace/db";
import { recordUnattributedMasterTrade } from "../lib/mt5/unattributedMasterTrades.js";
import { mapV150Enumeration, type V150EnumEntry } from "../lib/mt5/symbolDirectory.js";
import { ingestEaCapabilities } from "../lib/mt5/eaCapabilityMapping.js";
import { requireUser } from "../lib/auth/middleware.js";
import { hashBridgeToken } from "./meMt5Connections.js";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  Mt5HeartbeatBody,
  QueueMt5CommandBody,
  PostMt5CommandResultBody,
  Mt5SyncAccountBody,
  Mt5SyncPositionsBody,
  Mt5ExecuteBody,
  Mt5CloseBody,
  Mt5ModifyBody,
  Mt5CloseAllBody,
} from "@workspace/api-zod";
import { createAlert } from "../lib/alerts/alertManager.js";
import { computeRiskAudit } from "../lib/riskAudit.js";
import { getOrCreateUserRiskSettings } from "../lib/risk/userRiskSettings.js";
import { normaliseCapabilities, ALL_FALSE_CAPABILITIES } from "../lib/mt5/bridgeCapabilities.js";
import { evaluateClockDrift, normalizeEaEpochToMs } from "@workspace/domain/safety-contracts/clockDrift";
import { recordSecurityEvent } from "../lib/security/events.js";
import { readRoleFromRequest } from "../lib/security/middleware.js";
import { emitLiveAccountChanged } from "../lib/live/liveAccountEventBus.js";

const router = Router();

// In-memory diagnostics for the bridge token handshake. We never store or log
// the token value itself — only whether a request arrived with a valid or
// invalid token, when, and from where (IP + UA only). This is per-process and
// resets on restart, which is fine for an operator-facing diagnostic surface.
type BridgeDiag = {
  lastAcceptedHeartbeatAt: Date | null;
  lastAcceptedAccount: string | null;
  lastAcceptedRemoteIp: string | null;
  lastAcceptedUserAgent: string | null;
  lastRejectedHeartbeatAt: Date | null;
  lastRejectReason: string | null;
  lastRejectRemoteIp: string | null;
  acceptedCount: number;
  rejectedCount: number;
  // Phase 28-MT5-OPS — broker snapshot freshness (read-only)
  lastBrokerSnapshotAt: Date | null;
  brokerSnapshotStatus: "read_only" | "unavailable" | "n/a";
  // Phase 28-MT5-OPS — recent-accept observations (rolling window for
  // duplicate-EA / multi-IP detection). Capped to RECENT_OBS_MAX. Never
  // contains tokens.
  recentAccepted: Array<{ at: Date; ip: string | null; account: string | null }>;
};
const RECENT_OBS_MAX = 25;
const RECENT_OBS_WINDOW_MS = 5 * 60_000;
const bridgeDiag: BridgeDiag = {
  lastAcceptedHeartbeatAt: null,
  lastAcceptedAccount: null,
  lastAcceptedRemoteIp: null,
  lastAcceptedUserAgent: null,
  lastRejectedHeartbeatAt: null,
  lastRejectReason: null,
  lastRejectRemoteIp: null,
  acceptedCount: 0,
  rejectedCount: 0,
  lastBrokerSnapshotAt: null,
  brokerSnapshotStatus: "n/a",
  recentAccepted: [],
};
function pruneRecentAccepted(): void {
  const cutoff = Date.now() - RECENT_OBS_WINDOW_MS;
  bridgeDiag.recentAccepted = bridgeDiag.recentAccepted.filter((r) => r.at.getTime() >= cutoff);
}
// Phase 28-MT5-DEMO-FOUNDATION — exported probe shim. Lets the demo
// verification gate query the duplicate-EA state without taking a hard
// dependency on the internal bridgeDiag mutable state.
export function getDuplicateEaProbe(): { suspected: boolean; reason: string | null } {
  const d = detectDuplicateEa();
  return { suspected: d.suspected, reason: d.reason };
}

function detectDuplicateEa(): { suspected: boolean; distinctIps: string[]; distinctAccounts: string[]; reason: string | null } {
  pruneRecentAccepted();
  const ips = Array.from(new Set(bridgeDiag.recentAccepted.map((r) => r.ip).filter((v): v is string => !!v)));
  const accts = Array.from(new Set(bridgeDiag.recentAccepted.map((r) => r.account).filter((v): v is string => !!v)));
  let reason: string | null = null;
  if (ips.length > 1) reason = `accepted heartbeats from ${ips.length} distinct IPs in last ${RECENT_OBS_WINDOW_MS / 60_000}m`;
  else if (accts.length > 1) reason = `accepted heartbeats from ${accts.length} distinct accounts in last ${RECENT_OBS_WINDOW_MS / 60_000}m`;
  return { suspected: !!reason, distinctIps: ips, distinctAccounts: accts, reason };
}
function shortIp(req: Request): string | null {
  const fwd = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
  return fwd || req.ip || null;
}

// Phase 28-MT5-VPS — Bridge audit helper. Records bridge-relevant security
// events to the audit_events / security_events log. NEVER logs the token
// value; only metadata (reason, account, ip, ua, derived booleans). Always
// fire-and-forget — a DB write failure must not break the bridge handshake.
async function auditBridge(
  eventType: string,
  severity: "INFO" | "WARNING" | "HIGH" | "CRITICAL",
  status: "ALLOWED" | "DENIED" | "ATTEMPTED" | "TRIGGERED",
  req: Request,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await recordSecurityEvent({
      eventType,
      severity,
      status,
      actorUserId: (req as Request & { authUser?: { id: number } }).authUser?.id ?? null,
      route: req.path,
      method: req.method,
      ipAddress: shortIp(req),
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
      message: `MT5 bridge: ${eventType}`,
      metadata: {
        ...metadata,
        bridgeConfigured: !!process.env["MT5_BRIDGE_TOKEN"],
        readOnlyMode: true,
        allowOrderExecution: false,
        allowModification: false,
        allowClose: false,
      },
    });
  } catch (err) {
    req.log.warn({ err, eventType }, "Bridge audit write failed (non-fatal)");
  }
}

// Shared-secret authentication for MT5 EA bridge endpoints. The EA must send
// the configured token in the `X-MT5-Bridge-Token` header. If the env var is
// unset, bridge endpoints reject all requests so the bridge cannot be exploited
// by an unauthenticated caller.
function requireBridgeToken(req: Request, res: Response, next: NextFunction) {
  const expected = process.env["MT5_BRIDGE_TOKEN"];
  if (!expected) {
    bridgeDiag.lastRejectedHeartbeatAt = new Date();
    bridgeDiag.lastRejectReason = "MT5_BRIDGE_TOKEN_NOT_CONFIGURED";
    bridgeDiag.lastRejectRemoteIp = shortIp(req);
    bridgeDiag.rejectedCount += 1;
    void auditBridge("BRIDGE_HEARTBEAT_REJECTED", "WARNING", "DENIED", req, { reason: bridgeDiag.lastRejectReason });
    req.log.warn({ path: req.path, ip: shortIp(req) }, "MT5 bridge request rejected: token not configured");
    res.status(503).json({ error: "MT5 bridge disabled: MT5_BRIDGE_TOKEN not configured." });
    return;
  }
  const provided = req.header("X-MT5-Bridge-Token");
  if (!provided) {
    bridgeDiag.lastRejectedHeartbeatAt = new Date();
    bridgeDiag.lastRejectReason = "MISSING_TOKEN_HEADER";
    bridgeDiag.lastRejectRemoteIp = shortIp(req);
    bridgeDiag.rejectedCount += 1;
    void auditBridge("BRIDGE_HEARTBEAT_REJECTED", "WARNING", "DENIED", req, { reason: bridgeDiag.lastRejectReason });
    req.log.warn({ path: req.path, ip: shortIp(req), ua: req.headers["user-agent"] }, "MT5 bridge request rejected: missing X-MT5-Bridge-Token header");
    res.status(401).json({ error: "Invalid MT5 bridge token." });
    return;
  }
  if (provided !== expected) {
    bridgeDiag.lastRejectedHeartbeatAt = new Date();
    bridgeDiag.lastRejectReason = "TOKEN_MISMATCH";
    bridgeDiag.lastRejectRemoteIp = shortIp(req);
    bridgeDiag.rejectedCount += 1;
    void auditBridge("BRIDGE_HEARTBEAT_REJECTED", "WARNING", "DENIED", req, { reason: bridgeDiag.lastRejectReason });
    req.log.warn({ path: req.path, ip: shortIp(req), ua: req.headers["user-agent"] }, "MT5 bridge request rejected: token mismatch (value not logged)");
    res.status(401).json({ error: "Invalid MT5 bridge token." });
    return;
  }
  next();
}

async function loadOrCreateState() {
  const rows = await db.select().from(mt5StateTable).limit(1);
  if (rows[0]) return rows[0];
  const inserted = await db.insert(mt5StateTable).values({}).returning();
  return inserted[0];
}

// SAFETY GATE: Refuse any command-producing request unless safetyCore reports
// operationalMode === "LIVE_TRADING" AND killSwitch is NOT engaged. This
// closes the previously-open path where /mt5/queue-command, /mt5/execute,
// /mt5/close, /mt5/modify, /mt5/close-all could enqueue rows without any auth
// or invariant check. Even when this gate opens, placeLiveOrderGuarded still
// rejects placement with BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED.
async function refuseWhenNotArmed(_req: Request, res: Response, next: NextFunction) {
  try {
    const { getStatus: getSafetyStatus } = await import("../lib/safetyCore.js");
    const s = await getSafetyStatus();
    const armed = s.operationalMode === "LIVE_TRADING" && !s.killSwitchEngaged;
    if (!armed) {
      res.status(403).json({
        system: "mt5",
        liveTradingStatus: "DISABLED",
        canPlaceLiveTrade: false,
        result: {
          status: "REJECTED",
          reason: "NOT_ARMED_FOR_LIVE",
          operationalMode: s.operationalMode,
          killSwitchEngaged: s.killSwitchEngaged,
          message: "MT5 command-producing endpoints are disabled. The system must be in LIVE_TRADING mode with the kill switch released before commands can be enqueued. Even then, placeLiveOrderGuarded() still rejects placement until a real broker layer ships.",
        },
      });
      return;
    }
    next();
  } catch (err) {
    res.status(503).json({
      system: "mt5",
      liveTradingStatus: "DISABLED",
      result: { status: "REJECTED", reason: "ARM_CHECK_FAILED", detail: String(err).slice(0, 200) },
    });
  }
}

// Phase 4B — Strict per-user bridge auth. Used by /mt5/commands and
// /mt5/command-result so that an EA can only see/affect commands belonging
// to the user whose token it presents. The system MT5_BRIDGE_TOKEN is
// REJECTED here on purpose — system token has no user attribution and must
// not leak personal command queues. Token value is never logged.
export async function bridgeAuthPerUserOnly(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Masked token fingerprint = first 8 hex chars of SHA-256(token). NEVER
  // logs the raw token. Lets the operator correlate per-endpoint auth
  // outcomes (e.g. "fp=a1b2c3d4 accepted on /heartbeat then rejected on
  // /live-commands-poll") without leaking any usable secret material.
  const provided = req.header("X-MT5-Bridge-Token");
  const fp = provided ? hashBridgeToken(provided).slice(0, 8) : null;
  const endpoint = req.path;
  if (!provided) {
    req.log.warn({ event: "mt5_bridge_auth", endpoint, result: "rejected", code: "TOKEN_MISSING", fp: null, ip: shortIp(req) }, "MT5 bridge auth: token header missing");
    res.status(401).json({ error: "Invalid MT5 bridge token.", code: "TOKEN_MISSING" });
    return;
  }
  // Hard-deny the system MT5_BRIDGE_TOKEN on personal endpoints, regardless
  // of any data-level coincidence. The system token has no user attribution
  // and must NEVER pull or mutate per-user command queues.
  const sysToken = process.env.MT5_BRIDGE_TOKEN;
  if (sysToken && provided === sysToken) {
    bridgeDiag.lastRejectedHeartbeatAt = new Date();
    bridgeDiag.lastRejectReason = "SYSTEM_TOKEN_ON_PERSONAL_ENDPOINT";
    bridgeDiag.lastRejectRemoteIp = shortIp(req);
    bridgeDiag.rejectedCount += 1;
    void auditBridge("BRIDGE_HEARTBEAT_REJECTED", "WARNING", "DENIED", req, { reason: bridgeDiag.lastRejectReason });
    req.log.warn({ event: "mt5_bridge_auth", endpoint, result: "rejected", code: "TOKEN_SCOPE_INVALID", fp, ip: shortIp(req) }, "MT5 bridge auth: system token rejected on personal endpoint");
    res.status(401).json({ error: "Invalid MT5 bridge token.", code: "TOKEN_SCOPE_INVALID" });
    return;
  }
  const hash = hashBridgeToken(provided);
  let matched = await db.select().from(mt5ConnectionTable)
    .where(and(eq(mt5ConnectionTable.apiKeyHash, hash), isNull(mt5ConnectionTable.tokenRevokedAt)))
    .limit(1);
  let graceAccepted = false;
  if (!matched[0]) {
    // Task #31 — rotation grace window. After an admin rotates a bridge
    // token, the OLD token's hash is parked in `previousApiKeyHash` with an
    // expiry in `previousTokenExpiresAt`. We accept the previous hash ONLY
    // while now < previousTokenExpiresAt, so an EA on a VPS keeps working
    // until the operator swaps the token. Revoked connections are still
    // rejected (isNull tokenRevokedAt), and the system token was already
    // hard-denied above — neither path is reachable here.
    const graceRows = await db.select().from(mt5ConnectionTable)
      .where(and(
        eq(mt5ConnectionTable.previousApiKeyHash, hash),
        isNull(mt5ConnectionTable.tokenRevokedAt),
      ))
      .limit(1);
    const candidate = graceRows[0];
    if (candidate && candidate.previousTokenExpiresAt && candidate.previousTokenExpiresAt.getTime() > Date.now()) {
      matched = graceRows;
      graceAccepted = true;
    }
  }
  if (!matched[0] || matched[0].userId == null) {
    bridgeDiag.lastRejectedHeartbeatAt = new Date();
    bridgeDiag.lastRejectReason = "TOKEN_NO_USER_MATCH";
    bridgeDiag.lastRejectRemoteIp = shortIp(req);
    bridgeDiag.rejectedCount += 1;
    void auditBridge("BRIDGE_HEARTBEAT_REJECTED", "WARNING", "DENIED", req, { reason: bridgeDiag.lastRejectReason });
    const code = matched[0] ? "BRIDGE_NOT_REGISTERED" : "TOKEN_INVALID";
    req.log.warn({ event: "mt5_bridge_auth", endpoint, result: "rejected", code, fp, ip: shortIp(req) }, "MT5 bridge auth: token rejected (value not logged)");
    res.status(401).json({ error: "Invalid MT5 bridge token.", code });
    return;
  }
  req.log.info({ event: "mt5_bridge_auth", endpoint, result: "accepted", grace: graceAccepted, fp, connectionId: matched[0].id, userId: matched[0].userId, accountType: matched[0].accountType ?? null }, graceAccepted ? "MT5 bridge auth: previous token accepted (rotation grace window)" : "MT5 bridge auth: token accepted");
  (req as Request & { mt5Connection?: typeof matched[0] }).mt5Connection = matched[0];
  next();
}

// Phase 3C — heartbeat handler. Two acceptable token paths:
//   (a) System fallback: header equals process.env.MT5_BRIDGE_TOKEN. Treated
//       as the system/demo bridge — updates global mt5_state only. Never
//       attributed to a personal user connection.
//   (b) Per-user: header hashes to a non-revoked mt5_connection.apiKeyHash.
//       Updates that user's connection row (status -> connected, account
//       fields, lastHeartbeat). Revoked tokens are rejected with 401.
// Phase 28-MT5-VPS-fix: the dual-mode `bridgeAuth` middleware that previously
// accepted EITHER a per-user token OR the system MT5_BRIDGE_TOKEN env value
// has been removed. All EA-facing endpoints now use `bridgeAuthPerUserOnly`
// above, so EA traffic must always present an active per-user bridge token
// from the ARX MT5 Setup page. Do NOT reintroduce a system-token fallback
// here — that would silently re-open the partial-success state where
// heartbeats passed under the system token but command polls failed with
// TOKEN_NO_USER_MATCH.

// Phase 28-MT5-VPS-fix — token contract unification.
// Heartbeat now uses the same per-user-only model as /mt5/commands and
// /mt5/command-result. The EA MUST send a per-user bridge token (issued from
// the MT5 Setup page). The system MT5_BRIDGE_TOKEN env value is REJECTED on
// every EA-facing endpoint, eliminating the partial-success state where
// heartbeats slipped through under the system token but command polls were
// rejected with TOKEN_NO_USER_MATCH.
router.post("/mt5/heartbeat", bridgeAuthPerUserOnly, async (req, res) => {
  // Safe metadata log — token value is NEVER included.
  const ip = shortIp(req);
  const ua = req.headers["user-agent"] ?? null;
  const userConn = (req as Request & { mt5Connection?: typeof mt5ConnectionTable.$inferSelect }).mt5Connection ?? null;
  req.log.info({ event: "mt5_heartbeat_received", ip, ua, hasBody: !!req.body, perUser: !!userConn, connectionId: userConn?.id }, "MT5 heartbeat received (token accepted)");
  try {
    const body = Mt5HeartbeatBody.parse(req.body);
    // Phase TU — capability disclosure. Parsed permissively so a legacy EA
    // (no capabilities/accountType/eaVersion fields) still validates above.
    // Unknown keys are dropped by normaliseCapabilities → never enables.
    const extras = (() => {
      const raw = req.body as Record<string, unknown> | null | undefined;
      const caps = raw && typeof raw === "object" ? normaliseCapabilities(raw["capabilities"]) : ALL_FALSE_CAPABILITIES;
      const eaVersion = raw && typeof raw["eaVersion"] === "string" ? String(raw["eaVersion"]).slice(0, 32) : null;
      // T033 Phase 1 — also run the v1.50 capability mapping layer so the EA's
      // richer vocabulary (openMarket, validateOnly, symbolDiscovery, …) is
      // translated into normalized supportsX keys instead of being dropped by
      // the closed-set normaliseCapabilities above. Raw EA caps + unmapped keys
      // are preserved in the capabilities jsonb for admin diagnostics. This is
      // observability only — it enables no execution; the guard chain is
      // unchanged. Stored under `v150` to avoid a schema migration.
      const v150 = raw && typeof raw === "object"
        ? ingestEaCapabilities(raw["capabilities"], {
            eaName: raw["eaName"], eaVersion: raw["eaVersion"],
            build: raw["build"], protocol: raw["protocol"],
          })
        : null;
      // Phase TV-prep — bridge protocol version (distinct from EA build number).
      // Stored inside the capabilities jsonb under `bridgeVersion` to avoid a
      // schema migration; read by /me/bridge-capabilities.
      const bridgeVersion = raw && typeof raw["bridgeVersion"] === "string" ? String(raw["bridgeVersion"]).slice(0, 32) : null;
      const capsWithVersion = bridgeVersion ? { ...caps, bridgeVersion } : caps;
      // Phase 28-MT5-DEMO-FOUNDATION — accept "contest" explicitly so the
      // demo verification gate can distinguish CONTEST (refused for demo
      // execution) from a true demo account. Server-name patterns are NOT
      // used to derive this value — only the EA's explicit report from
      // AccountInfoInteger(ACCOUNT_TRADE_MODE) is honored.
      const accountType = raw && typeof raw["accountType"] === "string"
        ? (["demo", "contest", "live", "real"].includes(String(raw["accountType"])) ? String(raw["accountType"]) : null)
        : null;
      // v1.26 EA clarity — accept optional EA-side input toggles so the
      // server/UI can show the *actual* EA input state instead of inferring
      // from REJECTED reason codes. These NEVER enable anything server-side:
      // they are observability only. Live execution remains structurally
      // blocked at the safety-contract layer regardless of their values.
      // EA live-input telemetry can arrive in either of two shapes:
      //   • EA ≤ v1.29: FLAT top-level fields (raw.terminalConnected, …)
      //   • EA v1.50+ : NESTED under a top-level `eaInputs` object
      //     (BuildEaInputsJson). Same field names, just one level deeper.
      // Read nested-first, falling back to flat, so both EA generations land
      // their runtime live-readiness flags in capabilities.eaInputs. This is
      // observability only — it NEVER enables execution; the master-live gate
      // and the Phase B 16-gate evaluator remain authoritative and still
      // fail-closed on any missing/false flag.
      const eaSrc: Record<string, unknown> = (() => {
        const flat = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const nested = flat["eaInputs"];
        return nested && typeof nested === "object"
          ? { ...flat, ...(nested as Record<string, unknown>) }
          : flat;
      })();
      const eaBool = (k: string): boolean | null =>
        typeof eaSrc[k] === "boolean" ? Boolean(eaSrc[k]) : null;
      const readOnlyModeReported = eaBool("readOnlyMode");
      const enableDemoExecutionReported = eaBool("enableDemoExecution");
      const allowOrderExecutionReported = eaBool("allowOrderExecution");
      // Phase B (EA v1.27) — live-execution input toggles + runtime EA facts.
      // These are observability only. Live execution remains structurally
      // blocked unless the Phase B 15-gate evaluator passes ALL gates.
      const enableLiveExecutionReported = eaBool("enableLiveExecution");
      const terminalConnectedReported = eaBool("terminalConnected");
      const algoTradingAllowedReported = eaBool("algoTradingAllowed");
      const maxLiveLotReported = typeof eaSrc["maxLiveLot"] === "number" && Number.isFinite(eaSrc["maxLiveLot"] as number)
        ? Number(eaSrc["maxLiveLot"]) : null;
      // Stash EA-input reports inside the capabilities jsonb so they round-trip
      // without a schema migration. Existing `capabilities` shape preserved.
      const eaInputs: Record<string, unknown> = {};
      if (readOnlyModeReported !== null) eaInputs["readOnlyMode"] = readOnlyModeReported;
      if (enableDemoExecutionReported !== null) eaInputs["enableDemoExecution"] = enableDemoExecutionReported;
      if (allowOrderExecutionReported !== null) eaInputs["allowOrderExecution"] = allowOrderExecutionReported;
      if (enableLiveExecutionReported !== null) eaInputs["enableLiveExecution"] = enableLiveExecutionReported;
      if (terminalConnectedReported !== null) eaInputs["terminalConnected"] = terminalConnectedReported;
      if (algoTradingAllowedReported !== null) eaInputs["algoTradingAllowed"] = algoTradingAllowedReported;
      if (maxLiveLotReported !== null) eaInputs["maxLiveLot"] = maxLiveLotReported;
      eaInputs["reportedAt"] = new Date().toISOString();
      const capsWithEaInputs = Object.keys(eaInputs).length > 1
        ? { ...capsWithVersion, eaInputs }
        : capsWithVersion;
      // T033 Phase 1 — attach the v1.50 normalized capability map + raw EA caps
      // + any unmapped keys under `v150`, so /me/bridge-capabilities and the
      // GET_CAPABILITIES disclosure can read translated supportsX keys without
      // a schema migration. Null when the EA sent nothing mappable.
      const capsWithV150 = v150
        ? { ...capsWithEaInputs, v150: {
            normalized: v150.normalizedCapabilities,
            raw: v150.rawEaCapabilities,
            unmapped: v150.unmappedKeys,
            eaName: v150.eaName,
            eaVersion: v150.eaVersion,
            eaBuild: v150.eaBuild,
            eaProtocol: v150.eaProtocol,
            lastCapabilitySeenAt: v150.lastCapabilitySeenAt,
          } }
        : capsWithEaInputs;
      // Task #30 — clock-drift inputs. The EA reports its own GMT clock as
      // epoch ms (`eaTimeGmt`), plus its local + broker server time as display
      // strings (`eaLocalTime`, `brokerTime`). Broker time is NOT used for
      // drift (broker timezone offsets are not clock errors). Compute drift
      // against ARX's own receive time; never trust EA latency when drift is
      // significant. Computation NEVER enables anything — observability + an
      // additive SEVERE-drift Live-Test block downstream.
      // `normalizeEaEpochToMs` defends against MQL5's seconds-scale `TimeGMT()`
      // (older EAs) so a healthy clock is never misread as ~1000x drift.
      const eaTimeGmtMs = raw && typeof raw["eaTimeGmt"] === "number"
        ? normalizeEaEpochToMs(Number(raw["eaTimeGmt"])) : null;
      const eaLocalTime = raw && typeof raw["eaLocalTime"] === "string"
        ? String(raw["eaLocalTime"]).slice(0, 64) : null;
      const brokerTime = raw && typeof raw["brokerTime"] === "string"
        ? String(raw["brokerTime"]).slice(0, 64) : null;
      return {
        capabilities: capsWithV150,
        eaVersion,
        accountType,
        readOnlyModeReported,
        enableDemoExecutionReported,
        eaTimeGmtMs,
        eaLocalTime,
        brokerTime,
      };
    })();
    const heartbeatReceivedAt = new Date();
    const drift = evaluateClockDrift({
      eaGmtMs: extras.eaTimeGmtMs,
      serverReceivedMs: heartbeatReceivedAt.getTime(),
    });
    const state = await loadOrCreateState();
    const wasOffline = !state.lastHeartbeatAt || (Date.now() - new Date(state.lastHeartbeatAt).getTime() > 30_000);
    await db.update(mt5StateTable).set({
      account: body.account,
      broker: body.broker ?? state.broker,
      server: body.server ?? state.server,
      balance: body.balance,
      equity: body.equity,
      liveAllowed: body.liveAllowed ? 1 : 0,
      lastHeartbeatAt: new Date(),
    }).where(eq(mt5StateTable.id, state.id));
    if (userConn) {
      // Phase 3C — also write to the per-user connection record.
      // Phase TU — also persist capability disclosure.
      await db.update(mt5ConnectionTable).set({
        status: "connected",
        accountNumber: body.account ?? userConn.accountNumber,
        brokerName: body.broker ?? userConn.brokerName,
        serverName: body.server ?? userConn.serverName,
        accountBalance: body.balance ?? userConn.accountBalance,
        accountEquity: body.equity ?? userConn.accountEquity,
        // Task #335 — stamp the account-sync marker ONLY when this heartbeat
        // actually carried balance/equity, so the live snapshot can honestly
        // age the figures (a heartbeat without balance keeps the prior value
        // AND its prior age, never falsely refreshing it).
        ...(body.balance != null || body.equity != null
          ? { accountSyncedAt: heartbeatReceivedAt }
          : {}),
        accountType: extras.accountType ?? userConn.accountType,
        capabilities: extras.capabilities,
        capabilitiesReportedAt: new Date(),
        eaVersion: extras.eaVersion ?? userConn.eaVersion,
        // v1.26 EA clarity — mirror EA-reported ReadOnlyMode into the
        // existing read_only_mode column when the EA actually reports it.
        // Live safety flags (allow_order_execution / live_locked) are NEVER
        // mutated from heartbeat input — only ReadOnlyMode (which is a
        // demo-path-only toggle) is mirrored for UI honesty.
        ...(extras.readOnlyModeReported !== null
          ? { readOnlyMode: extras.readOnlyModeReported }
          : {}),
        // Phase B real-EA upgrade: when the EA reports a concrete accountType
        // we lift the connection out of the default MOCK stamp so live
        // readiness checks can distinguish a real MT5 heartbeat from a
        // placeholder row. Live readiness paths filter mode='MOCK' OUT;
        // unreported accountType leaves mode untouched so legacy rows
        // remain unchanged.
        ...(extras.accountType === "live" || extras.accountType === "real"
          ? { mode: "LIVE" as const }
          : extras.accountType === "demo" || extras.accountType === "contest"
          ? { mode: "DEMO" as const }
          : {}),
        // Task #30 — record clock-drift snapshot + display times.
        eaLocalTime: extras.eaLocalTime ?? userConn.eaLocalTime,
        brokerTime: extras.brokerTime ?? userConn.brokerTime,
        heartbeatReceivedAt,
        clockDriftSeconds: drift.driftSeconds,
        clockDriftSeverity: drift.severity,
        lastHeartbeat: new Date(),
        updatedAt: new Date(),
      }).where(eq(mt5ConnectionTable.id, userConn.id));
      if (drift.severity === "SEVERE") {
        req.log.warn({ event: "mt5_clock_drift_severe", connectionId: userConn.id, driftSeconds: drift.driftSeconds, flags: drift.flags }, "EA host clock drift is SEVERE");
      }
    }
    bridgeDiag.lastAcceptedHeartbeatAt = new Date();
    bridgeDiag.lastAcceptedAccount = body.account ?? null;
    bridgeDiag.lastAcceptedRemoteIp = ip;
    bridgeDiag.lastAcceptedUserAgent = typeof ua === "string" ? ua.slice(0, 200) : null;
    bridgeDiag.acceptedCount += 1;
    const snapshotPresent = body.balance != null || body.equity != null;
    // Phase 28-MT5-OPS — track broker snapshot freshness + rolling recent-accept
    // window for duplicate-EA / multi-IP detection. No tokens stored.
    bridgeDiag.brokerSnapshotStatus = snapshotPresent ? "read_only" : "unavailable";
    if (snapshotPresent) bridgeDiag.lastBrokerSnapshotAt = new Date();
    bridgeDiag.recentAccepted.push({ at: new Date(), ip, account: body.account ?? null });
    if (bridgeDiag.recentAccepted.length > RECENT_OBS_MAX) {
      bridgeDiag.recentAccepted = bridgeDiag.recentAccepted.slice(-RECENT_OBS_MAX);
    }
    const dup = detectDuplicateEa();
    if (dup.suspected) {
      void auditBridge("DUPLICATE_EA_SUSPECTED", "WARNING", "TRIGGERED", req, {
        reason: dup.reason,
        distinctIps: dup.distinctIps.length,
        distinctAccounts: dup.distinctAccounts.length,
      });
    }
    void auditBridge("BRIDGE_HEARTBEAT_RECEIVED", "INFO", "ALLOWED", req, {
      account: body.account ?? null,
      perUser: !!userConn,
      hasBalance: body.balance != null,
      hasEquity: body.equity != null,
    });
    void auditBridge(
      snapshotPresent ? "BRIDGE_SNAPSHOT_RECEIVED_READONLY" : "BRIDGE_SNAPSHOT_UNAVAILABLE",
      "INFO",
      snapshotPresent ? "ALLOWED" : "ATTEMPTED",
      req,
      { account: body.account ?? null, perUser: !!userConn },
    );
    if (wasOffline) {
      await createAlert({ type: "MT5_DISCONNECTED", severity: "success", title: "MT5 reconnected", message: `Account ${body.account} is online.` });
    }
    // Task #1 — Shared bridge: MT5 is source of truth. Recompute the
    // master pool snapshot after every heartbeat that wrote a
    // balance/equity/margin update so admin / dispatch / user surfaces
    // see the freshest derived state. Fire-and-forget; never breaks
    // the heartbeat ACK path.
    void (async () => {
      try {
        const { recomputeMasterPool } = await import("../lib/live/masterBridgePool.js");
        await recomputeMasterPool();
        // Auto-reduce settled allocations to the freshest real balance when the
        // master is over-allocated. Open-trade users are always protected.
        const { autoReconcileSettledAllocations } = await import("./adminAllocations.js");
        await autoReconcileSettledAllocations();
      } catch (err) {
        req.log.warn({ err }, "Master bridge pool recompute after heartbeat failed");
      }
    })();
    // Task #333 — instant SSE push. A heartbeat refreshes per-user liveness /
    // equity-balance state that /me/live/account-stream reads, so signal that
    // user's stream to rebuild immediately. Best-effort; never blocks the ACK.
    if (userConn) emitLiveAccountChanged(userConn.userId ?? null);
    res.json({ received: true, perUser: !!userConn, connectionId: userConn?.id ?? null });
  } catch (err) {
    bridgeDiag.lastRejectedHeartbeatAt = new Date();
    bridgeDiag.lastRejectReason = "INVALID_HEARTBEAT_BODY";
    bridgeDiag.lastRejectRemoteIp = ip;
    bridgeDiag.rejectedCount += 1;
    void auditBridge("BRIDGE_HEARTBEAT_REJECTED", "WARNING", "DENIED", req, { reason: bridgeDiag.lastRejectReason });
    req.log.error({ err, ip, ua }, "MT5 heartbeat body validation failed");
    res.status(400).json({ error: "Invalid heartbeat" });
  }
});

// ── Diagnostic surfaces (read-only, no execution effect) ───────────────────

router.get("/mt5/heartbeat/status", async (_req, res) => {
  const tokenConfigured = !!process.env["MT5_BRIDGE_TOKEN"];
  const state = await loadOrCreateState();
  const lastHb = state.lastHeartbeatAt ?? bridgeDiag.lastAcceptedHeartbeatAt;
  const ageSec = lastHb ? Math.floor((Date.now() - new Date(lastHb).getTime()) / 1000) : null;
  const fresh = ageSec !== null && ageSec < HEARTBEAT_THRESHOLD_MS / 1000;
  const eaConnected = fresh;
  const tokenAccepted = bridgeDiag.acceptedCount > 0
    ? "yes"
    : bridgeDiag.rejectedCount > 0
      ? "no"
      : "n/a";
  res.json({
    connected: eaConnected,
    eaConnected,
    lastHeartbeatAt: lastHb ? new Date(lastHb).toISOString() : null,
    heartbeatAgeSeconds: ageSec,
    bridgeTokenConfigured: tokenConfigured,
    tokenAccepted,
    acceptedHeartbeatCount: bridgeDiag.acceptedCount,
    rejectedHeartbeatCount: bridgeDiag.rejectedCount,
    lastRejectedHeartbeatAt: bridgeDiag.lastRejectedHeartbeatAt?.toISOString() ?? null,
    lastRejectReason: bridgeDiag.lastRejectReason,
    lastRejectRemoteIp: bridgeDiag.lastRejectRemoteIp,
    lastAcceptedAccount: bridgeDiag.lastAcceptedAccount,
    lastAcceptedRemoteIp: bridgeDiag.lastAcceptedRemoteIp,
    lastAcceptedUserAgent: bridgeDiag.lastAcceptedUserAgent,
    expectedPostEndpoint: "/api/mt5/heartbeat",
    expectedHeader: "X-MT5-Bridge-Token",
    freshnessThresholdSeconds: HEARTBEAT_THRESHOLD_MS / 1000,
    serverTime: new Date().toISOString(),
    note: "Diagnostic only. Does not unlock execution. Token values are never returned.",
  });
});

router.get("/mt5/bridge-diagnostics", async (req, res) => {
  const tokenConfigured = !!process.env["MT5_BRIDGE_TOKEN"];
  const state = await loadOrCreateState();
  const lastHb = state.lastHeartbeatAt ?? bridgeDiag.lastAcceptedHeartbeatAt;
  const ageSec = lastHb ? Math.floor((Date.now() - new Date(lastHb).getTime()) / 1000) : null;
  const fresh = ageSec !== null && ageSec < HEARTBEAT_THRESHOLD_MS / 1000;

  // Endpoint mount probe — derived from this very router's stack so the truth
  // matches whatever is actually wired up at runtime, not a hand-maintained list.
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack;
  const mounted = (path: string, method: "get" | "post") =>
    stack.some((l) => l.route?.path === path && !!l.route?.methods?.[method]);

  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const expectedServerBaseUrl = `${proto}://${host}`;

  void auditBridge("BRIDGE_DIAGNOSTICS_VIEWED", "INFO", "ALLOWED", req, {});
  if (lastHb && !fresh) {
    void auditBridge("BRIDGE_HEARTBEAT_STALE", "WARNING", "TRIGGERED", req, {
      lastHeartbeatAt: new Date(lastHb).toISOString(),
      ageSeconds: ageSec,
    });
  }
  // Phase 28-MT5-OPS — duplicate-EA observation + broker snapshot freshness.
  const dup = detectDuplicateEa();
  const snapshotAgeMs = bridgeDiag.lastBrokerSnapshotAt
    ? Date.now() - bridgeDiag.lastBrokerSnapshotAt.getTime()
    : null;
  const brokerSnapshotFresh = snapshotAgeMs !== null && snapshotAgeMs < 60_000;
  const now = new Date().toISOString();
  res.json({
    // Phase 28-MT5-VPS spec-named fields (canonical, never breaking).
    bridgeConfigured: tokenConfigured,
    tokenConfigured,
    bridgeConnected: fresh,
    lastHeartbeatAt: lastHb ? new Date(lastHb).toISOString() : null,
    heartbeatFresh: fresh,
    bridgeMode: tokenConfigured ? (fresh ? "READ_ONLY_CONNECTED" : "READ_ONLY_WAITING_HEARTBEAT") : "READ_ONLY_NOT_CONFIGURED",
    readOnlyMode: true,
    allowOrderExecution: false,
    allowModification: false,
    allowClose: false,
    commandExecutionAllowed: false,
    lastError: bridgeDiag.lastRejectReason,
    updatedAt: now,
    // Phase 28-MT5-OPS — broker snapshot + duplicate-EA observation.
    brokerSnapshotStatus: bridgeDiag.brokerSnapshotStatus,
    lastBrokerSnapshotAt: bridgeDiag.lastBrokerSnapshotAt?.toISOString() ?? null,
    brokerSnapshotFresh,
    duplicateEaSuspected: dup.suspected,
    duplicateEaReason: dup.reason,
    distinctAcceptedIpsLast5m: dup.distinctIps.length,
    distinctAcceptedAccountsLast5m: dup.distinctAccounts.length,
    // Legacy / extended diagnostic fields (preserved verbatim).
    expectedServerBaseUrl,
    expectedHeartbeatEndpoint: `${expectedServerBaseUrl}/api/mt5/heartbeat`,
    expectedHeader: "X-MT5-Bridge-Token",
    endpoints: {
      heartbeatReceiverMounted: mounted("/mt5/heartbeat", "post"),
      heartbeatStatusMounted: mounted("/mt5/heartbeat/status", "get"),
      mt5StatusMounted: mounted("/mt5/status", "get"),
      commandsPollMounted: mounted("/mt5/commands", "get"),
      commandResultMounted: mounted("/mt5/command-result", "post"),
      syncAccountMounted: mounted("/mt5/sync-account", "post"),
      syncPositionsMounted: mounted("/mt5/sync-positions", "post"),
      bridgeDiagnosticsMounted: mounted("/mt5/bridge-diagnostics", "get"),
      setupChecklistMounted: mounted("/mt5/setup-checklist", "get"),
    },
    heartbeatAgeSeconds: ageSec,
    lastRejectedHeartbeatAt: bridgeDiag.lastRejectedHeartbeatAt?.toISOString() ?? null,
    lastRejectReason: bridgeDiag.lastRejectReason,
    acceptedHeartbeatCount: bridgeDiag.acceptedCount,
    rejectedHeartbeatCount: bridgeDiag.rejectedCount,
    appState: {
      mt5Connected: fresh,
      mt5Deferred: !fresh,
      brokerExecutionAvailable: false,
      executionMode: "READ_ONLY",
      placementLayer: "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED",
    },
    troubleshooting: {
      webRequestChecklist: [
        `In MT5: Tools → Options → Expert Advisors → Allow WebRequest for listed URL.`,
        `Add: ${expectedServerBaseUrl}`,
        `Then check 'Allow WebRequest for listed URL'.`,
      ],
      algoTradingChecklist: [
        "AutoTrading button in MT5 toolbar must be ON (green).",
        "EA must be attached to a chart with the smiley face icon enabled.",
        "EA inputs: ServerBaseUrl set to the URL above; BridgeToken set to the PER-USER bridge token issued from your MT5 setup page (NOT the server MT5_BRIDGE_TOKEN env value — that one is rejected on per-user endpoints like /api/mt5/commands).",
      ],
      commonRejectReasons: {
        TOKEN_MISMATCH: "EA's BridgeToken input does not match any active per-user token (and does not match the system MT5_BRIDGE_TOKEN env). Re-copy your per-user token from the MT5 setup page.",
        SYSTEM_TOKEN_ON_PERSONAL_ENDPOINT: "EA is sending the server-wide MT5_BRIDGE_TOKEN env value to a per-user endpoint (/api/mt5/commands or /api/mt5/command-result). Replace it with your PER-USER bridge token.",
        TOKEN_NO_USER_MATCH: "EA token does not hash to any active mt5_connection row. Issue a new per-user token from the MT5 setup page.",
        MISSING_TOKEN_HEADER: "EA is reaching the server but not sending X-MT5-Bridge-Token header. Update the EA build.",
        MT5_BRIDGE_TOKEN_NOT_CONFIGURED: "Server-side env var is missing. Add it in Replit Secrets.",
        INVALID_HEARTBEAT_BODY: "EA is reaching the server with a valid token but the JSON body is malformed.",
      },
    },
    serverTime: new Date().toISOString(),
    note: "Diagnostic only. No execution unlock. Token values are never returned.",
  });
});

// ── Phase 28-MT5-OPS — Bridge Operations Monitor ───────────────────────────
// Single rollup of all bridge-ops fields specified by the Operations
// Hardening contract. Read-only. Never returns tokens. Records a
// BRIDGE_OPS_MONITOR_VIEWED audit event on every fetch. Stale heartbeat
// triggers BRIDGE_HEARTBEAT_STALE audit; multi-IP/account observation
// surfaces duplicateEaSuspected (also audited at heartbeat time).
// Pure in-process builder so other routes (e.g. the paper-beta readiness
// gate) can consume the same rollup WITHOUT making an internal HTTP fetch
// (avoids SSRF + cookie-forwarding risk via Host/X-Forwarded-Host headers).
// `requesterRole` controls field-level redaction of operator-only telemetry.
export async function buildBridgeOpsRollup(requesterRole: "admin" | "user") {
  const tokenConfigured = !!process.env["MT5_BRIDGE_TOKEN"];
  const state = await loadOrCreateState();
  const lastHb = state.lastHeartbeatAt ?? bridgeDiag.lastAcceptedHeartbeatAt;
  const ageSec = lastHb ? Math.floor((Date.now() - new Date(lastHb).getTime()) / 1000) : null;
  const fresh = ageSec !== null && ageSec < HEARTBEAT_THRESHOLD_MS / 1000;
  const dup = detectDuplicateEa();
  const snapshotAgeMs = bridgeDiag.lastBrokerSnapshotAt
    ? Date.now() - bridgeDiag.lastBrokerSnapshotAt.getTime()
    : null;
  const brokerSnapshotFresh = snapshotAgeMs !== null && snapshotAgeMs < 60_000;
  // Operator-only identifiers (server-wide). Non-admin users see "REDACTED".
  const isAdmin = requesterRole === "admin";
  return {
    bridgeConnected: fresh,
    eaConnected: fresh,
    heartbeatFresh: fresh,
    heartbeatAgeSeconds: ageSec,
    lastHeartbeatAt: lastHb ? new Date(lastHb).toISOString() : null,
    acceptedHeartbeatCount: bridgeDiag.acceptedCount,
    rejectedHeartbeatCount: bridgeDiag.rejectedCount,
    lastAcceptedRemoteIp: isAdmin ? bridgeDiag.lastAcceptedRemoteIp : "REDACTED",
    lastAcceptedAccount: isAdmin ? bridgeDiag.lastAcceptedAccount : "REDACTED",
    lastError: bridgeDiag.lastRejectReason,
    lastRejectedHeartbeatAt: bridgeDiag.lastRejectedHeartbeatAt?.toISOString() ?? null,
    readOnlyMode: true,
    allowOrderExecution: false,
    allowModification: false,
    allowClose: false,
    commandExecutionAllowed: false,
    brokerSnapshotStatus: bridgeDiag.brokerSnapshotStatus,
    lastBrokerSnapshotAt: bridgeDiag.lastBrokerSnapshotAt?.toISOString() ?? null,
    brokerSnapshotFresh,
    bridgeMode: tokenConfigured ? (fresh ? "READ_ONLY_CONNECTED" : "READ_ONLY_WAITING_HEARTBEAT") : "READ_ONLY_NOT_CONFIGURED",
    duplicateEaSuspected: dup.suspected,
    duplicateEaReason: dup.reason,
    distinctAcceptedIpsLast5m: dup.distinctIps.length,
    distinctAcceptedAccountsLast5m: dup.distinctAccounts.length,
    freshnessThresholdSeconds: HEARTBEAT_THRESHOLD_MS / 1000,
    requesterScope: isAdmin ? "admin" : "user_redacted",
    safetyEnvelope: {
      liveLocked: true,
      readOnlyMode: true,
      allowOrderExecution: false,
      allowModification: false,
      allowClose: false,
      commandExecutionAllowed: false,
      brokerPlacementImplemented: false,
    },
    serverTime: new Date().toISOString(),
    note: isAdmin
      ? "Read-only operations monitor (admin view). No execution unlock. Token values are never returned."
      : "Read-only operations monitor (user view; operator-only identifiers redacted). No execution unlock. Token values are never returned.",
  };
}

router.get("/mt5/bridge-ops-monitor", requireUser, async (req, res) => {
  const role = readRoleFromRequest(req);
  const rollup = await buildBridgeOpsRollup(role === "OWNER" || role === "ADMIN" ? "admin" : "user");
  void auditBridge("BRIDGE_OPS_MONITOR_VIEWED", "INFO", "ALLOWED", req, { requesterScope: rollup.requesterScope });
  if (rollup.lastHeartbeatAt && !rollup.heartbeatFresh) {
    void auditBridge("BRIDGE_HEARTBEAT_STALE", "WARNING", "TRIGGERED", req, {
      lastHeartbeatAt: rollup.lastHeartbeatAt,
      ageSeconds: rollup.heartbeatAgeSeconds,
    });
  }
  res.json(rollup);
});

// Phase 28-MT5-VPS — Operator setup checklist. Read-only. Returns the 14
// onboarding items (manual + derived live state). Never returns secrets;
// only the BOOLEAN of whether MT5_BRIDGE_TOKEN is configured. Records a
// BRIDGE_CHECKLIST_VIEWED audit event on every fetch.
router.get("/mt5/setup-checklist", async (req, res) => {
  const tokenConfigured = !!process.env["MT5_BRIDGE_TOKEN"];
  const state = await loadOrCreateState();
  const lastHb = state.lastHeartbeatAt ?? bridgeDiag.lastAcceptedHeartbeatAt;
  const ageSec = lastHb ? Math.floor((Date.now() - new Date(lastHb).getTime()) / 1000) : null;
  const fresh = ageSec !== null && ageSec < HEARTBEAT_THRESHOLD_MS / 1000;
  const hasSnapshot = state.balance != null || state.equity != null;

  type ItemState = "ok" | "missing" | "waiting" | "stale" | "manual";
  type ChecklistItem = { id: string; label: string; derivable: boolean; state: ItemState; detail?: string };
  const items: ChecklistItem[] = [
    { id: "vps_created", label: "VPS created", derivable: false, state: "manual", detail: "Operator must confirm. ARX cannot detect VPS provisioning." },
    { id: "rdp_connected", label: "Windows Server connected via Remote Desktop", derivable: false, state: "manual" },
    { id: "mt5_installed", label: "MT5 installed on VPS", derivable: false, state: "manual" },
    { id: "mt5_demo_logged_in", label: "Demo MT5 account logged in", derivable: false, state: "manual" },
    { id: "ea_file_installed", label: "ARX bridge EA file installed (MQL5/Experts)", derivable: false, state: "manual" },
    { id: "ea_compiled", label: "EA compiled in MetaEditor with 0 errors", derivable: false, state: "manual" },
    { id: "ea_attached", label: "EA attached to a chart", derivable: false, state: "manual" },
    { id: "algo_trading_on", label: "Algo Trading ON in MT5 toolbar", derivable: false, state: "manual" },
    { id: "webrequest_allowed", label: "WebRequest URL allowed (Tools → Options → Expert Advisors)", derivable: false, state: "manual" },
    {
      id: "bridge_token_configured",
      label: "Bridge token configured in Replit Secrets",
      derivable: true,
      state: tokenConfigured ? "ok" : "missing",
      detail: tokenConfigured ? "MT5_BRIDGE_TOKEN is set." : "Add MT5_BRIDGE_TOKEN in Replit Secrets.",
    },
    { id: "read_only_mode", label: "ReadOnlyMode = true", derivable: true, state: "ok", detail: "Enforced server-side; cannot be disabled from the EA." },
    { id: "allow_order_execution_false", label: "AllowOrderExecution = false", derivable: true, state: "ok", detail: "Broker placement layer not implemented; all commands forced to BLOCKED." },
    {
      id: "heartbeat_received",
      label: "Heartbeat received from EA",
      derivable: true,
      state: fresh ? "ok" : (lastHb ? "stale" : "waiting"),
      detail: fresh
        ? `Last heartbeat ${ageSec}s ago.`
        : (lastHb ? `Stale — last heartbeat ${ageSec}s ago (threshold ${HEARTBEAT_THRESHOLD_MS / 1000}s).` : "Waiting for first heartbeat."),
    },
    {
      id: "broker_snapshot_read_only",
      label: "Broker snapshot received (read-only)",
      derivable: true,
      state: hasSnapshot ? "ok" : "waiting",
      detail: hasSnapshot ? "Balance/equity received from EA heartbeat." : "No broker snapshot yet — waiting for EA to send balance/equity.",
    },
  ];

  const derived = {
    tokenConfigured,
    bridgeConfigured: tokenConfigured,
    bridgeConnected: fresh,
    heartbeatFresh: fresh,
    lastHeartbeatAt: lastHb ? new Date(lastHb).toISOString() : null,
    heartbeatAgeSeconds: ageSec,
    readOnlyMode: true,
    allowOrderExecution: false,
    allowModification: false,
    allowClose: false,
    bridgeMode: tokenConfigured ? (fresh ? "READ_ONLY_CONNECTED" : "READ_ONLY_WAITING_HEARTBEAT") : "READ_ONLY_NOT_CONFIGURED",
    placementLayer: "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED",
  };

  const totals = {
    manual: items.filter((i) => i.state === "manual").length,
    ok: items.filter((i) => i.state === "ok").length,
    missing: items.filter((i) => i.state === "missing").length,
    waiting: items.filter((i) => i.state === "waiting").length,
    stale: items.filter((i) => i.state === "stale").length,
  };

  void auditBridge("BRIDGE_CHECKLIST_VIEWED", "INFO", "ALLOWED", req, { itemCount: items.length, totals });
  if (lastHb && !fresh) {
    void auditBridge("BRIDGE_HEARTBEAT_STALE", "WARNING", "TRIGGERED", req, {
      lastHeartbeatAt: new Date(lastHb).toISOString(),
      ageSeconds: ageSec,
    });
  }

  res.json({
    items,
    derived,
    totals,
    note: "Operator checklist. Manual items must be confirmed by the operator. Derived items reflect live server state. Tokens are never returned.",
    updatedAt: new Date().toISOString(),
  });
});

// Phase 4B — Per-user/per-connection command poll.
// Requires X-MT5-Bridge-Token. Returns ONLY commands matching the matched
// connection's userId AND mt5ConnectionId. System bridge token is REJECTED
// (per-user auth only). No global commands ever returned.
// Claim is atomic: a single UPDATE ... WHERE status='PENDING' RETURNING
// flips PENDING→DELIVERED, so a concurrent cancel/poll cannot double-claim
// or resurrect a cancelled row.
router.get("/mt5/commands", bridgeAuthPerUserOnly, async (req, res) => {
  const conn = (req as Request & { mt5Connection: typeof mt5ConnectionTable.$inferSelect }).mt5Connection;
  const candidateIds = (await db.select({ id: mt5CommandsTable.id }).from(mt5CommandsTable)
    .where(and(
      eq(mt5CommandsTable.status, "PENDING"),
      eq(mt5CommandsTable.userId, conn.userId!),
      eq(mt5CommandsTable.mt5ConnectionId, conn.id),
    ))
    .orderBy(asc(mt5CommandsTable.createdAt))
    .limit(50)).map((r) => r.id);
  if (candidateIds.length === 0) { res.json({ commands: [] }); return; }
  const now = new Date();
  const claimed = await db.update(mt5CommandsTable)
    .set({ status: "DELIVERED", deliveredAt: now, claimedAt: now, updatedAt: now })
    .where(and(
      inArray(mt5CommandsTable.id, candidateIds),
      eq(mt5CommandsTable.status, "PENDING"),                    // atomic guard
      eq(mt5CommandsTable.userId, conn.userId!),                 // re-check ownership
      eq(mt5CommandsTable.mt5ConnectionId, conn.id),
    ))
    .returning();
  if (claimed.length) {
    req.log.info({ count: claimed.length, userId: conn.userId, connectionId: conn.id }, "MT5 commands delivered (per-user, atomic)");
  }
  // T033 Phase 9 — stamp server-time expiry fields on every command the EA
  // polls. createdAtEpoch (seconds) is what the v1.50 EA's expiry check reads;
  // expiresAt/expirySeconds make the TTL explicit. Derived from the row's
  // server-set createdAt — never client/browser time. Command IDs unchanged.
  const COMMAND_EXPIRY_SECONDS = 120;
  res.json({
    commands: claimed.map((r) => {
      const created = r.createdAt ?? now;
      const createdAtEpoch = Math.floor(created.getTime() / 1000);
      const expiresAtDate = new Date(created.getTime() + COMMAND_EXPIRY_SECONDS * 1000);
      return {
        ...r,
        createdAt: created.toISOString(),
        createdAtEpoch,
        expiresAt: expiresAtDate.toISOString(),
        expiresAtEpoch: Math.floor(expiresAtDate.getTime() / 1000),
        expirySeconds: COMMAND_EXPIRY_SECONDS,
        deliveredAt: r.deliveredAt?.toISOString() ?? null,
        completedAt: r.completedAt?.toISOString() ?? null,
      };
    }),
  });
});

router.post("/mt5/queue-command", requireUser, refuseWhenNotArmed, async (req, res) => {
  try {
    const body = QueueMt5CommandBody.parse(req.body);
    // SAFETY: Route through queueMt5CommandWithGate so the canonical
    // single-source guard inside queueCommand applies (legacy mode + safetyCore).
    // Never insert directly — direct inserts default to status='PENDING' and
    // bypass the legacy bridge-mode and live-lock semantics.
    const { command: r } = await queueMt5CommandWithGate(body.action, {
      symbol: body.symbol ?? null,
      side: body.side ?? null,
      lot: body.lot ?? null,
      sl: body.sl ?? null,
      tp: body.tp ?? null,
      ticket: body.ticket ?? null,
    }, req.authUser!.id);
    res.json({
      ...r,
      createdAt: r.createdAt?.toISOString() ?? new Date().toISOString(),
      deliveredAt: r.deliveredAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
    });
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid command" });
  }
});

// Phase 4C — Per-user/per-connection command result submission.
// EA may only complete commands that belong to the matched connection's
// userId AND mt5ConnectionId. Cross-user attempts return 404.
router.post("/mt5/command-result", bridgeAuthPerUserOnly, async (req, res): Promise<void> => {
  try {
    const conn = (req as Request & { mt5Connection: typeof mt5ConnectionTable.$inferSelect }).mt5Connection;
    const body = PostMt5CommandResultBody.parse(req.body);
    const isFailed = /fail|error|reject/i.test(body.status);
    const now = new Date();
    // Preserve the FULL raw EA result body for admin/debug (requirement 4).
    // The EA sends a flat body, not a resultPayload wrapper, so capture the
    // whole thing rather than a (nonexistent) nested object.
    const resultPayload = (body as unknown as { resultPayload?: Record<string, unknown> }).resultPayload
      ?? ((req.body && typeof req.body === "object") ? (req.body as Record<string, unknown>) : null);
    // T033 Phase 8 — the EA (v1.50 PostResultStruct) sends execution detail as
    // TOP-LEVEL fields on the command-result body: mt5Retcode, mt5Ticket,
    // mt5Comment, resolvedBrokerSymbol, bid/ask, etc. But PostMt5CommandResultBody
    // (zod) only whitelists {commandId,status,detail,timestamp} and STRIPS the
    // rest — so we must read them from the RAW req.body, not the parsed object.
    // (Same reason the heartbeat handler reads raw body for its extra fields.)
    // Field names match the EA exactly: mt5Ticket (not mt5OrderTicket),
    // mt5Comment (not brokerMessage).
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v
      : (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
    const str = (v: unknown): string | null =>
      typeof v === "string" && v.trim() !== "" ? v : null;
    // Prefer raw top-level (what the EA actually sends); fall back to a
    // resultPayload wrapper if some other caller uses that shape.
    const rp = resultPayload ?? {};
    const mt5Retcode = num(raw["mt5Retcode"] ?? rp["mt5Retcode"] ?? rp["retcode"]);
    const brokerMessage = str(raw["mt5Comment"] ?? raw["brokerMessage"] ?? rp["brokerMessage"] ?? rp["comment"]);
    const fillPrice = num(raw["fillPrice"] ?? raw["price"] ?? rp["fillPrice"]);
    const filledLotSize = num(raw["filledLotSize"] ?? raw["requestedVolume"] ?? rp["filledLotSize"]);
    const rawTicket = raw["mt5Ticket"] ?? raw["mt5OrderTicket"] ?? rp["mt5OrderTicket"] ?? rp["orderTicket"];
    // mt5Ticket=0 from the EA means "no ticket" (rejections) — treat 0 as null.
    const mt5OrderTicket = (rawTicket != null && String(rawTicket) !== "0") ? String(rawTicket) : null;
    const rawPosTicket = raw["mt5PositionTicket"] ?? rp["mt5PositionTicket"] ?? rp["positionTicket"];
    const mt5PositionTicket = (rawPosTicket != null && String(rawPosTicket) !== "0") ? String(rawPosTicket) : null;
    const updated = await db.update(mt5CommandsTable).set({
      status: body.status,
      detail: body.detail ?? null,
      errorMessage: isFailed ? (body.detail ?? null) : null,
      resultPayload,
      mt5Retcode,
      brokerMessage,
      fillPrice,
      filledLotSize,
      mt5OrderTicket,
      mt5PositionTicket,
      completedAt: isFailed ? null : now,
      failedAt: isFailed ? now : null,
      updatedAt: now,
    }).where(and(
      eq(mt5CommandsTable.id, body.commandId),
      eq(mt5CommandsTable.userId, conn.userId!),
      eq(mt5CommandsTable.mt5ConnectionId, conn.id),
    )).returning();
    if (!updated[0]) {
      req.log.warn({ commandId: body.commandId, userId: conn.userId, connectionId: conn.id }, "MT5 command-result rejected: not owner");
      res.status(404).json({ error: "Command not found for this connection." });
      return;
    }

    // Phase TV — write back to the linked pending-order draft when the
    // command was one of the new pending-order types. Per-user scoped on
    // BOTH sides (mt5_commands.userId AND trade_action_requests.userId).
    const cmd = updated[0];
    const action = cmd.action as Mt5GatedAction;
    if (
      action === "PLACE_PENDING_ORDER" ||
      action === "MODIFY_PENDING_ORDER" ||
      action === "CANCEL_PENDING_ORDER" ||
      action === "MODIFY_POSITION_PROTECTION"
    ) {
      const { tradeActionRequestsTable } = await import("@workspace/db/schema");
      let nextPendingStatus: string | null = null;
      let setMt5OrderTicket: string | null = null;
      if (isFailed) {
        nextPendingStatus = "REJECTED";
      } else if (action === "PLACE_PENDING_ORDER") {
        nextPendingStatus = "PLACED";
        setMt5OrderTicket = mt5OrderTicket != null ? String(mt5OrderTicket) : null;
      } else if (action === "CANCEL_PENDING_ORDER") {
        nextPendingStatus = "CANCELLED";
      } else if (action === "MODIFY_PENDING_ORDER" || action === "MODIFY_POSITION_PROTECTION") {
        nextPendingStatus = "MODIFIED";
      }
      if (nextPendingStatus) {
        await db.update(tradeActionRequestsTable).set({
          pendingStatus: nextPendingStatus,
          ...(setMt5OrderTicket ? { mt5OrderTicket: setMt5OrderTicket } : {}),
          reason: isFailed ? (body.detail ?? "MT5 rejected") : `MT5 ${nextPendingStatus.toLowerCase()}`,
          updatedAt: now,
        }).where(and(
          eq(tradeActionRequestsTable.tradeCommandId, cmd.id),
          eq(tradeActionRequestsTable.userId, conn.userId!),
        ));
      }
    }

    // T033 Phase 6 — EA v1.50 ENUMERATE_SYMBOLS result ingestion.
    // The EA returns enumeration as a command-result with the symbol array in
    // `data.symbols` (PostResultRaw envelope). The generated result schema does
    // not model `data`, so we read it from the raw req.body and translate via
    // the v1.50 mapper into the arx_symbol_specs directory. Per-user scoped on
    // the connection. Malformed payloads are logged precisely, never crash.
    if (String(cmd.action) === "ENUMERATE_SYMBOLS" && !isFailed) {
      try {
        const rawData = (req.body as { data?: { symbols?: unknown[] } } | undefined)?.data ?? null;
        const specItems = mapV150Enumeration(rawData as { symbols?: V150EnumEntry[] } | null);
        if (specItems.length === 0) {
          req.log.warn(
            { commandId: body.commandId, userId: conn.userId, connectionId: conn.id, gotData: rawData != null },
            "ENUMERATE_SYMBOLS result had no usable symbols",
          );
        } else {
          const seenNow = new Date();
          let upserted = 0;
          for (const s of specItems) {
            const sym = String((s as { symbol?: unknown }).symbol ?? "");
            if (!sym) continue; // never persist an empty key; never default-fill
            const v = s as Record<string, unknown>;
            const common = {
              bridgeConnectionId: conn.id,
              accountType: conn.accountType ?? null,
              brokerSymbol: (v["brokerSymbol"] as string | null) ?? null,
              visible: (v["visible"] as boolean | null) ?? null,
              tradeAllowed: (v["tradeAllowed"] as boolean | null) ?? null,
              tradeMode: (v["tradeMode"] as "FULL" | "LONGONLY" | "SHORTONLY" | "CLOSEONLY" | "DISABLED" | null) ?? null,
              marketOpen: (v["marketOpen"] as boolean | null) ?? null,
              digits: (v["digits"] as number | null) ?? null,
              point: (v["point"] as number | null) ?? null,
              minVolume: (v["minVolume"] as number | null) ?? null,
              maxVolume: (v["maxVolume"] as number | null) ?? null,
              volumeStep: (v["volumeStep"] as number | null) ?? null,
              contractSize: (v["contractSize"] as number | null) ?? null,
              tickSize: (v["tickSize"] as number | null) ?? null,
              tickValue: (v["tickValue"] as number | null) ?? null,
              stopsLevelPoints: (v["stopsLevelPoints"] as number | null) ?? null,
              freezeLevelPoints: (v["freezeLevelPoints"] as number | null) ?? null,
              bid: (v["bid"] as number | null) ?? null,
              ask: (v["ask"] as number | null) ?? null,
              marginCurrency: (v["marginCurrency"] as string | null) ?? null,
              profitCurrency: (v["profitCurrency"] as string | null) ?? null,
              displaySymbol: (v["displaySymbol"] as string | null) ?? null,
              reasonNotTradable: (v["reasonNotTradable"] as string | null) ?? null,
              raw: (v["raw"] as Record<string, unknown> | null) ?? null,
              snapshotAt: seenNow,
              lastSeenAt: seenNow,
              reportedAt: seenNow,
              updatedAt: seenNow,
            };
            await db.insert(arxSymbolSpecsTable).values({
              userId: conn.userId!, symbol: sym, spreadPoints: null, ...common,
            }).onConflictDoUpdate({
              target: [arxSymbolSpecsTable.userId, arxSymbolSpecsTable.symbol],
              set: common,
            });
            upserted++;
          }
          req.log.info(
            { event: "enumerate_symbols_ingested", commandId: body.commandId, userId: conn.userId, connectionId: conn.id, upserted },
            "EA v1.50 ENUMERATE_SYMBOLS ingested into symbol directory",
          );
        }
      } catch (mapErr) {
        req.log.error(
          { err: String(mapErr), commandId: body.commandId, userId: conn.userId, connectionId: conn.id, stage: "enumerate_symbols_ingest" },
          "ENUMERATE_SYMBOLS ingestion failed",
        );
      }
    }

    // ── ARX live transport bridge — forward the EA terminal result back into
    // the authoritative arx_live_commands record. The v1.50 EA only polls and
    // answers the legacy mt5_commands mailbox, so a bridged Phase B live command
    // would otherwise sit in SENT_TO_MT5_LIVE forever even though the broker has
    // already filled or rejected it (the mirror row above already carries the
    // real mt5Retcode + brokerMessage). The mirror payload carries
    // {bridged:"LIVE_PHASE_B", liveCommandId, liveCommandOwnerUserId}.
    // recordLiveCommandResult re-applies the bridge-binding + exactly-once CAS
    // guards, so this NEVER weakens a safety surface — it only propagates broker
    // truth onto the user-facing record.
    const bridgePayload = (cmd.payload ?? {}) as Record<string, unknown>;
    if (bridgePayload["bridged"] === "LIVE_PHASE_B" && typeof bridgePayload["liveCommandId"] === "string") {
      const liveCommandId = bridgePayload["liveCommandId"] as string;
      const liveOwnerUserId =
        num(bridgePayload["liveCommandOwnerUserId"]) ?? cmd.requestedByUserId ?? conn.userId!;
      const eaReason = str(raw["reason"] ?? rp["reason"]);
      const liveBrokerTicket = mt5PositionTicket ?? mt5OrderTicket;
      try {
        const { recordLiveCommandResult, mapBridgedLiveOutcome } = await import(
          "../lib/live/liveCommandPipeline.js"
        );
        // Map the EA/broker outcome honestly: LIVE_FILLED requires a confirmed
        // broker ticket (no ticket => never reported as a fill), so a false fill
        // can never fulfil an exposure reservation. See mapBridgedLiveOutcome.
        const liveOutcome = mapBridgedLiveOutcome({
          status: body.status,
          reason: eaReason,
          hasBrokerTicket: liveBrokerTicket != null,
        });
        const fwd = await recordLiveCommandResult({
          userId: liveOwnerUserId,
          commandId: liveCommandId,
          outcome: liveOutcome,
          reportingBridgeConnectionId: conn.id,
          brokerTicket: liveBrokerTicket,
          fillPrice,
          executedVolume: filledLotSize,
          mt5Retcode,
          brokerMessage,
          eaReason,
        });
        req.log.info(
          {
            event: "live_bridge_result_forwarded",
            liveCommandId,
            mt5CommandId: cmd.id,
            outcome: liveOutcome,
            ok: fwd.ok,
            forwardReason: fwd.reason ?? null,
            userId: liveOwnerUserId,
            connectionId: conn.id,
          },
          "Phase B live result forwarded from mt5_commands mirror to arx_live_commands",
        );
      } catch (fwdErr) {
        req.log.error(
          {
            err: String(fwdErr),
            liveCommandId,
            mt5CommandId: cmd.id,
            stage: "live_bridge_result_forward",
          },
          "Failed to forward Phase B live result into arx_live_commands",
        );
      }
    }

    res.json({ received: true });
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid command result" });
  }
});

// Phase 28-MT5-VPS-fix — per-user-only on all EA-facing endpoints.
// MT5 balance sync fix: `/mt5/sync-account` previously wrote ONLY to the
// legacy `mt5_state` singleton, so margin / freeMargin / currency arrived
// from the EA every 5s but never landed on the per-user `mt5_connection`
// row. Result: the dashboard/my-mt5 cards showed balance + equity (which
// the heartbeat does persist per-user) but margin = 0, freeMargin = 0,
// currency = NULL forever. We now mirror the same snapshot into the per-
// user row keyed by the authenticated bridge token (`req.mt5Connection`).
// We DO NOT touch `lastHeartbeat` here — that remains the heartbeat's
// freshness signal so a heartbeat outage stays observable even if
// sync-account keeps succeeding.
router.post("/mt5/sync-account", bridgeAuthPerUserOnly, async (req, res) => {
  try {
    const body = Mt5SyncAccountBody.parse(req.body);
    const state = await loadOrCreateState();
    await db.update(mt5StateTable).set({
      account: body.account,
      balance: body.balance,
      equity: body.equity,
      margin: body.margin ?? null,
      freeMargin: body.freeMargin ?? null,
      marginLevel: body.marginLevel ?? null,
      currency: body.currency,
      lastSyncAt: new Date(),
    }).where(eq(mt5StateTable.id, state.id));

    const userConn = (req as Request & { mt5Connection?: typeof mt5ConnectionTable.$inferSelect }).mt5Connection ?? null;
    let accountChangedUserId: number | null = null;
    if (userConn) {
      // Per-user mirror. Only set fields the EA actually reported (nullish
      // → leave the existing column value alone) so a partial snapshot can
      // never overwrite known-good data with NULL. accountType / mode are
      // managed exclusively by the heartbeat path.
      const patch: Partial<typeof mt5ConnectionTable.$inferInsert> = {
        accountBalance: body.balance,
        accountEquity: body.equity,
        accountCurrency: body.currency,
        // Task #335 — this route always writes balance/equity from the EA, so
        // mark the figures freshly synced now (drives the >60s stale note).
        accountSyncedAt: new Date(),
        updatedAt: new Date(),
      };
      if (body.margin != null) patch.margin = body.margin;
      if (body.freeMargin != null) patch.freeMargin = body.freeMargin;
      // body.account is the broker account number — only fill if the per-
      // user row hasn't captured it yet.
      if (!userConn.accountNumber && body.account) patch.accountNumber = body.account;
      await db.update(mt5ConnectionTable).set(patch)
        .where(eq(mt5ConnectionTable.id, userConn.id));
      accountChangedUserId = userConn.userId ?? null;
    }
    // Task #1 — pool snapshot must follow every balance/equity write.
    // Fire-and-forget; never blocks the EA ACK.
    void (async () => {
      try {
        const { recomputeMasterPool } = await import("../lib/live/masterBridgePool.js");
        await recomputeMasterPool();
        // Auto-reduce settled allocations to the new real balance if the
        // master is now over-allocated. Never touches users with open trades.
        const { autoReconcileSettledAllocations } = await import("./adminAllocations.js");
        await autoReconcileSettledAllocations();
      } catch (err) {
        req.log.warn({ err }, "Master pool recompute after sync-account failed");
      }
    })();
    // Task #333 — instant SSE push. The per-user equity/balance write above is
    // exactly what /me/live/account-stream reads, so signal that user's stream
    // to rebuild now instead of waiting on its 3s fallback tick. Best-effort.
    if (accountChangedUserId != null) emitLiveAccountChanged(accountChangedUserId);
    res.json({ received: true, perUser: !!userConn, connectionId: userConn?.id ?? null });
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid account sync" });
  }
});

// Phase 28-MT5-VPS-fix — per-user-only on all EA-facing endpoints.
router.post("/mt5/sync-positions", bridgeAuthPerUserOnly, async (req, res) => {
  try {
    const body = Mt5SyncPositionsBody.parse(req.body);
    const state = await loadOrCreateState();
    await db.update(mt5StateTable).set({
      positions: body.positions,
      lastSyncAt: new Date(),
    }).where(eq(mt5StateTable.id, state.id));
    // Task #1 — positions affect totalUserUnrealizedPnl; refresh pool.
    void (async () => {
      try {
        const { recomputeMasterPool } = await import("../lib/live/masterBridgePool.js");
        await recomputeMasterPool();
        // A position close is the "settle" moment — re-attempt the settled-only
        // auto-reduce now that this user may no longer hold open exposure.
        const { autoReconcileSettledAllocations } = await import("./adminAllocations.js");
        await autoReconcileSettledAllocations();
      } catch (err) {
        req.log.warn({ err }, "Master pool recompute after sync-positions failed");
      }
    })();
    res.json({ received: true });
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid positions sync" });
  }
});

// ── Phase 7 additions ──────────────────────────────────────────────────────

const HEARTBEAT_THRESHOLD_MS = 15_000;

// Phase 12 hardening: ARX AI is paper-only by construction. Broker placement
// is not implemented; no live execution path is reachable. `liveLocked` is
// therefore *always* true at the system level, regardless of any per-row
// risk_settings toggle. This makes the lock state unambiguous and
// independent of any unscoped row read.
async function getLiveLocked(): Promise<boolean> {
  return true;
}

function determineMode(state: { lastHeartbeatAt: Date | null; liveAllowed: number | null }, liveLocked: boolean): "MOCK" | "DEMO" | "LIVE_LOCKED" | "LIVE" {
  const connected = !!state.lastHeartbeatAt && Date.now() - new Date(state.lastHeartbeatAt).getTime() < HEARTBEAT_THRESHOLD_MS;
  if (!connected) return "MOCK";
  if (liveLocked) return "LIVE_LOCKED";
  if (state.liveAllowed) return "LIVE";
  return "DEMO";
}

/**
 * Build H — shared queue helper. Other routes (e.g. live position management)
 * MUST go through this so mode (MOCK/DEMO/LIVE_LOCKED/LIVE) and `liveLocked`
 * gates are honoured uniformly. Returns the queued command + the resolved mode
 * + blockedReason so callers can surface them.
 */
// Phase TV — extended action union to include pending-order / modify-protection
// / modify-pending / cancel-pending. Existing OPEN|CLOSE|MODIFY|CLOSE_ALL
// callers remain type-compatible. The same BLOCKED hardcode applies; this
// only makes the queue forward-wire-able. Live execution remains off.
export type Mt5GatedAction =
  | "OPEN" | "CLOSE" | "MODIFY" | "CLOSE_ALL"
  | "PLACE_PENDING_ORDER" | "MODIFY_POSITION_PROTECTION"
  | "MODIFY_PENDING_ORDER" | "CANCEL_PENDING_ORDER";

export async function queueMt5CommandWithGate(
  action: Mt5GatedAction,
  payload: {
    symbol?: string | null; side?: string | null; lot?: number | null;
    sl?: number | null; tp?: number | null; ticket?: number | null;
    /** Phase TV — full pending-order / modify payload (jsonb). */
    pendingPayload?: Record<string, unknown> | null;
  },
  userId: number | null = null,
) {
  const state = await loadOrCreateState();
  const liveLocked = await getLiveLocked();
  const mode = determineMode(state, liveLocked);
  const blockedReason = mode === "MOCK" ? "MT5 bridge not connected. Command stored as mock." : null;
  const cmd = await queueCommand(action, payload, mode, blockedReason, userId);
  return { command: cmd, mode, blockedReason };
}

async function queueCommand(action: Mt5GatedAction, payload: {
  symbol?: string | null;
  side?: string | null;
  lot?: number | null;
  sl?: number | null;
  tp?: number | null;
  ticket?: number | null;
  pendingPayload?: Record<string, unknown> | null;
}, mode: string, blockedReason: string | null, userId: number | null = null) {
  // SAFETY (single-source hard stop): Only deliver as PENDING when BOTH
  //  (a) the legacy mode helper says LIVE (heartbeat + liveAllowed + !liveLocked), AND
  //  (b) safetyCore reports operationalMode === LIVE_TRADING && !killSwitchEngaged.
  // Anything else MUST be BLOCKED so the EA poll (/mt5/commands filters
  // status='PENDING') cannot pick it up. This is the canonical guard that
  // covers every caller — direct /mt5/* routes, /positions/:id/* mutators
  // via queueMt5CommandWithGate, and any future enqueue paths.
  // Phase 12 hardening — production paper-only lock.
  // No matter what the legacy mode/liveLocked/safetyCore flags say, every
  // command enqueued by this helper is forced to status=BLOCKED so the EA
  // poll (/mt5/commands filters status='PENDING') CANNOT pick it up. This
  // closes the reachable live-command path identified in the Phase 12
  // production audit. The legacy + safetyCore checks remain as
  // belt-and-braces context but no longer drive deliverability.
  const { getStatus: getSafetyStatus } = await import("../lib/safetyCore.js");
  const safety = await getSafetyStatus();
  const safetyArmed = safety.operationalMode === "LIVE_TRADING" && !safety.killSwitchEngaged;
  void safetyArmed; // retained for future audit; no longer gates delivery
  const status = "BLOCKED" as const;
  const effectiveBlockedReason = blockedReason
    ?? "ARX AI is paper-only by construction. Broker placement is not implemented; command stored as BLOCKED.";
  const detail = effectiveBlockedReason;
  const inserted = await db.insert(mt5CommandsTable).values({
    userId,
    action,
    symbol: payload.symbol ?? null,
    side: payload.side ?? null,
    lot: payload.lot ?? null,
    sl: payload.sl ?? null,
    tp: payload.tp ?? null,
    ticket: payload.ticket ?? null,
    payload: payload.pendingPayload ?? null,
    status,
    detail,
  }).returning();
  return inserted[0]!;
}

function serializeCommand(r: typeof mt5CommandsTable.$inferSelect) {
  return {
    ...r,
    createdAt: r.createdAt?.toISOString() ?? new Date().toISOString(),
    deliveredAt: r.deliveredAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
  };
}

router.get("/mt5/status", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  // ── Canonical safety posture ─────────────────────────────────────────
  // ARX AI is paper-only by construction. Broker placement is not
  // implemented; no live route can issue an order. The dashboard-facing
  // `liveLocked` field is therefore *always* true regardless of any
  // risk_settings toggle — it represents the system-level lock, not the
  // user preference. This prevents `liveLocked=false` from ever leaking
  // into UI/QA and being misread as "live execution available".
  const liveLocked = true;

  // Phase 17A — per-user reality. Prefer the user's own mt5_connection row
  // (multi-tenant). If the user has no connection, return clean
  // "not connected" instead of falling back to the singleton mt5_state
  // (which represents the legacy global owner bridge and would otherwise
  // leak that account's balance/equity into another user's UI).
  const userConns = await db.select().from(mt5ConnectionTable)
    .where(and(eq(mt5ConnectionTable.userId, userId), isNull(mt5ConnectionTable.tokenRevokedAt)))
    .orderBy(desc(mt5ConnectionTable.lastHeartbeat))
    .limit(1);
  const userConn = userConns[0];

  const counts = await db.select({
    status: mt5CommandsTable.status,
    n: sql<number>`count(*)::int`,
  }).from(mt5CommandsTable)
    .where(eq(mt5CommandsTable.userId, userId))
    .groupBy(mt5CommandsTable.status);

  const pendingCommands = counts.find((c) => c.status === "PENDING")?.n ?? 0;
  const completedCommands = counts.filter((c) => ["executed", "completed"].includes(c.status)).reduce((s, c) => s + c.n, 0);
  const failedCommands = counts.filter((c) => ["failed", "rejected", "blocked_demo_mode"].includes(c.status)).reduce((s, c) => s + c.n, 0);

  // Canonical safety flags identical regardless of connection state.
  const safetyEnvelope = {
    liveLocked,
    executionMode: "READ_ONLY" as const,
    placementLayer: "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED" as const,
    liveExecutionEnabled: false,
    liveBrokerExecutionAvailable: false,
    readOnlyGuardActive: true,
    paperTradingEnabled: true,
    brokerPlacementImplemented: false,
    demoExecutionEnabled: process.env["ARX_ALLOW_DEMO_EXECUTION"] === "true",
    maxDemoLot: 0.01,
    pendingCommands,
    completedCommands,
    failedCommands,
  };

  if (!userConn) {
    res.json({
      ...safetyEnvelope,
      connected: false,
      mode: "NOT_CONNECTED",
      lastHeartbeatAt: null,
      secondsSinceHeartbeat: null,
      accountType: "NONE",
      openPositions: [],
      accountSnapshot: null,
      userSafeMessage: "MT5 bridge not connected for this user. Set up an MT5 connection in MT5 Bridge settings.",
    });
    return;
  }

  const lastHb = userConn.lastHeartbeat ? new Date(userConn.lastHeartbeat) : null;
  const ageMs = lastHb ? Date.now() - lastHb.getTime() : null;
  const fresh = ageMs !== null && ageMs < HEARTBEAT_THRESHOLD_MS;
  const secondsSinceHeartbeat = ageMs !== null ? Math.floor(ageMs / 1000) : null;
  const connected = fresh;
  const mode: "NOT_CONNECTED" | "STALE" | "DEMO" | "LIVE_LOCKED" =
    !lastHb ? "NOT_CONNECTED" : !fresh ? "STALE" : "LIVE_LOCKED";
  const accountType =
    !lastHb ? "UNKNOWN"
    : userConn.mode === "LIVE" || userConn.mode === "LIVE_LOCKED" ? "REAL"
    : "DEMO";

  res.json({
    ...safetyEnvelope,
    connected,
    mode,
    lastHeartbeatAt: lastHb?.toISOString() ?? null,
    secondsSinceHeartbeat,
    accountType,
    openPositions: [],
    accountSnapshot: lastHb ? {
      account: userConn.accountNumber,
      broker: userConn.brokerName,
      server: userConn.serverName,
      balance: userConn.accountBalance,
      equity: userConn.accountEquity,
      margin: userConn.margin,
      freeMargin: userConn.freeMargin,
      marginLevel: null,
      currency: userConn.accountCurrency,
    } : null,
    userSafeMessage: !lastHb
      ? "Bridge connection registered but no heartbeat received yet. Start the EA in MetaTrader."
      : !fresh
      ? `Bridge heartbeat is stale (${secondsSinceHeartbeat}s old). Check that the EA is running.`
      : null,
  });
});

// UX9 P1 hardening: this endpoint previously returned a token-derived mask
// (leaking token length + first/last 4 chars) AND a GLOBAL slice of every
// user's recent mt5_commands. Both are tenant/secret leaks. Now: requireUser
// + admin role check, NO token-derived data of any kind, recent commands
// scoped to the requesting admin's user_id only.
router.get("/mt5/bridge-info", requireUser, async (req, res) => {
  const role = req.authUser?.role;
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ error: "admin_required" });
    return;
  }
  const configured = !!process.env["MT5_BRIDGE_TOKEN"];

  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const webhookUrl = `${proto}://${host}/api/mt5`;

  const recent = await db.select().from(mt5CommandsTable)
    .where(eq(mt5CommandsTable.userId, req.authUser!.id))
    .orderBy(desc(mt5CommandsTable.createdAt))
    .limit(20);

  res.json({
    configured,
    webhookUrl,
    headerName: "X-MT5-Bridge-Token",
    tokenSetupHint: "EA auth is per-user only. Generate a per-user bridge token from the ARX MT5 Setup page (POST /api/me/mt5-connections) and configure the EA to send it as X-MT5-Bridge-Token. The server-wide MT5_BRIDGE_TOKEN env value is rejected on every EA endpoint.",
    recentCommands: recent.map(serializeCommand),
  });
});

router.post("/mt5/execute", requireUser, refuseWhenNotArmed, async (req, res) => {
  try {
    const body = Mt5ExecuteBody.parse(req.body);
    const userId = req.authUser!.id;
    const state = await loadOrCreateState();
    const liveLocked = await getLiveLocked();
    const mode = determineMode(state, liveLocked);

    // ── Risk approval check (per Phase 7 spec) ────────────────────────────
    const settings = await getOrCreateUserRiskSettings(userId);
    let auditFailureReason: string | null = null;
    if (settings) {
      const balance = state.balance ?? 1000;
      const audit = await computeRiskAudit(balance, {
        riskPerTradePct: settings.riskPerTradePct,
        maxDailyLossPct: settings.maxDailyLossPct,
        maxWeeklyLossPct: settings.maxWeeklyLossPct,
        maxTradesPerDay: settings.maxTradesPerDay,
        maxOpenTrades: settings.maxOpenTrades,
        stopAfterLosingStreak: settings.stopAfterLosingStreak,
        minConfidenceScore: settings.minConfidenceScore,
        confidence: body.confidence ?? undefined,
        symbol: body.symbol,
        us30BlockNews: settings.us30BlockNews,
        stocksBlockEarnings: settings.stocksBlockEarnings,
        forexBlockEvents: settings.forexBlockEvents,
        vol75ExtraConfidence: settings.vol75ExtraConfidence,
      });
      if (!audit.passed) {
        auditFailureReason = `Risk check failed: ${audit.reasonsBlocked.join("; ")}`;
      }
    }

    const blockedReason = auditFailureReason
      ?? (mode === "LIVE_LOCKED"
        ? "Live trading is locked. Unlock in Risk Control Center to enable."
        : mode === "MOCK"
          ? "MT5 bridge not connected. Command stored as mock."
          : null);
    const cmd = await queueCommand("OPEN", body, mode, blockedReason, userId);
    if (blockedReason) req.log.warn({ mode, blockedReason, body }, "MT5 execute blocked");
    res.json({
      queued: true,
      status: cmd.status,
      mode,
      blockedReason,
      command: serializeCommand(cmd),
    });
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid execute payload" });
  }
});

router.post("/mt5/close", requireUser, refuseWhenNotArmed, async (req, res) => {
  try {
    const body = Mt5CloseBody.parse(req.body);
    const state = await loadOrCreateState();
    const liveLocked = await getLiveLocked();
    const mode = determineMode(state, liveLocked);
    const blockedReason = mode === "MOCK" ? "MT5 bridge not connected. Command stored as mock." : null;
    const cmd = await queueCommand("CLOSE", { ticket: body.ticket }, mode, blockedReason, req.authUser!.id);
    res.json({ queued: true, status: cmd.status, mode, blockedReason, command: serializeCommand(cmd) });
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid close payload" });
  }
});

router.post("/mt5/modify", requireUser, refuseWhenNotArmed, async (req, res) => {
  try {
    const body = Mt5ModifyBody.parse(req.body);
    const state = await loadOrCreateState();
    const liveLocked = await getLiveLocked();
    const mode = determineMode(state, liveLocked);
    const blockedReason = mode === "MOCK" ? "MT5 bridge not connected. Command stored as mock." : null;
    const cmd = await queueCommand("MODIFY", body, mode, blockedReason, req.authUser!.id);
    res.json({ queued: true, status: cmd.status, mode, blockedReason, command: serializeCommand(cmd) });
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid modify payload" });
  }
});

router.post("/mt5/close-all", requireUser, refuseWhenNotArmed, async (req, res) => {
  try {
    const body = Mt5CloseAllBody.parse(req.body);
    if (!body.confirm) {
      res.status(400).json({ error: "Confirmation required for CLOSE_ALL." });
      return;
    }
    const state = await loadOrCreateState();
    const liveLocked = await getLiveLocked();
    const mode = determineMode(state, liveLocked);
    const blockedReason = mode === "MOCK" ? "MT5 bridge not connected. Command stored as mock." : null;
    const cmd = await queueCommand("CLOSE_ALL", {}, mode, blockedReason, req.authUser!.id);
    req.log.warn({ mode }, "CLOSE_ALL emergency triggered");
    res.json({ queued: true, status: cmd.status, mode, blockedReason, command: serializeCommand(cmd) });
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid close-all payload" });
  }
});

// ── Phase UX9 — Structured execution-result callback ────────────────────────
//
// SAFETY:
//   * Per-user bridge token only (system token explicitly rejected).
//   * The command MUST belong to the matched connection — cross-user is 404.
//   * Idempotent on (commandId, terminal status).
//   * Never reads or returns any secret. Never queues a new trade.
//   * Reconciliation (action_request lifecycle, live_positions,
//     shared_trade_attribution, timeline, notifications) is delegated to
//     `reconcileExecutionResult` so this route stays a thin transport.
const Mt5ExecutionResultBody = z.object({
  commandId: z.number().int().positive(),
  actionRequestId: z.number().int().positive().nullish(),
  status: z.enum(["executed", "rejected", "failed", "partial", "pending"]),
  mt5OrderTicket: z.string().max(64).nullish(),
  mt5PositionTicket: z.string().max(64).nullish(),
  symbol: z.string().max(32).nullish(),
  side: z.enum(["BUY", "SELL"]).nullish(),
  lotSizeRequested: z.number().nullish(),
  lotSizeFilled: z.number().nullish(),
  requestedPrice: z.number().nullish(),
  fillPrice: z.number().nullish(),
  slippage: z.number().nullish(),
  stopLoss: z.number().nullish(),
  takeProfit: z.number().nullish(),
  brokerMessage: z.string().max(2000).nullish(),
  errorCode: z.string().max(128).nullish(),
  errorMessage: z.string().max(2000).nullish(),
  executedAt: z.string().datetime().nullish(),
});

router.post("/mt5/execution-result", bridgeAuthPerUserOnly, async (req, res): Promise<void> => {
  try {
    const conn = (req as Request & { mt5Connection: typeof mt5ConnectionTable.$inferSelect }).mt5Connection;
    const parsed = Mt5ExecutionResultBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_body" });
      return;
    }
    const body = parsed.data;

    // Validate command belongs to this connection's user + connection.
    const [command] = await db.select().from(mt5CommandsTable)
      .where(and(
        eq(mt5CommandsTable.id, body.commandId),
        eq(mt5CommandsTable.userId, conn.userId!),
        eq(mt5CommandsTable.mt5ConnectionId, conn.id),
      )).limit(1);

    if (!command) {
      req.log.warn(
        { commandId: body.commandId, connectionId: conn.id },
        "MT5 execution-result rejected: unknown command for this connection",
      );
      res.status(404).json({ ok: false, error: "command_not_found" });
      return;
    }

    const { reconcileExecutionResult } = await import("../lib/mt5/executionReconciler.js");
    const outcome = await reconcileExecutionResult({
      command,
      result: {
        commandId: body.commandId,
        actionRequestId: body.actionRequestId ?? null,
        status: body.status,
        mt5OrderTicket: body.mt5OrderTicket ?? null,
        mt5PositionTicket: body.mt5PositionTicket ?? null,
        symbol: body.symbol ?? null,
        side: body.side ?? null,
        lotSizeRequested: body.lotSizeRequested ?? null,
        lotSizeFilled: body.lotSizeFilled ?? null,
        requestedPrice: body.requestedPrice ?? null,
        fillPrice: body.fillPrice ?? null,
        slippage: body.slippage ?? null,
        stopLoss: body.stopLoss ?? null,
        takeProfit: body.takeProfit ?? null,
        brokerMessage: body.brokerMessage ?? null,
        errorCode: body.errorCode ?? null,
        errorMessage: body.errorMessage ?? null,
        executedAt: body.executedAt ? new Date(body.executedAt) : null,
      },
    });

    res.json({
      ok: true,
      reconciled: outcome.reconciled,
      duplicate: outcome.duplicate ?? false,
      commandStatus: outcome.commandStatus,
      actionStatus: outcome.actionStatus ?? null,
      safety: { safetyMode: "paper_only", liveLocked: true, readOnlyMode: true, allowOrderExecution: false },
    });
  } catch (err) {
    req.log.error({ err }, "execution_result_failed");
    res.status(400).json({ ok: false, error: "execution_result_failed" });
  }
});

router.get("/mt5/state", async (_req, res) => {
  const state = await loadOrCreateState();
  const connected = !!state.lastHeartbeatAt && Date.now() - new Date(state.lastHeartbeatAt).getTime() < 30_000;
  res.json({
    connected,
    account: state.account,
    broker: state.broker,
    server: state.server,
    balance: state.balance,
    equity: state.equity,
    margin: state.margin,
    freeMargin: state.freeMargin,
    marginLevel: state.marginLevel,
    currency: state.currency,
    liveAllowed: !!state.liveAllowed,
    positions: Array.isArray(state.positions) ? state.positions : [],
    lastHeartbeatAt: state.lastHeartbeatAt?.toISOString() ?? null,
    lastSyncAt: state.lastSyncAt?.toISOString() ?? null,
  });
});

// ── Shared-Master Mode — per-user sync-positions with unattributed detection
//
// Why this exists (P1 cleanup, post-P0):
//   When a registered shared-master account's EA pushes its open positions
//   via this endpoint, ARX needs to detect positions that have NO matching
//   shared_trade_attribution row — i.e. trades opened directly on the master
//   account by a human, bypassing ARX entirely. These would otherwise vanish
//   into the singleton mt5_state.positions blob with no audit trail.
//
// Why it is a NEW route (not a change to /mt5/sync-positions):
//   The legacy /mt5/sync-positions also uses bridgeAuthPerUserOnly (as of
//   Phase 28-MT5-VPS-fix) but writes into the singleton mt5_state.positions
//   blob with no per-connection attribution. The new endpoint uses
//   bridgeAuthPerUserOnly AND attributes each row to `req.mt5Connection`, so
//   positions from many users coexist with full audit context.
//
// SAFETY:
//   * Read + record only. NEVER opens, closes, or modifies any trade.
//   * Unattributed recording is idempotent on
//     (masterConnectionId, mt5PositionTicket, tradeCommandId IS NULL) — the
//     EA reports the same open positions every sync tick.
//   * Skips entirely if the connection is NOT a registered shared master
//     (a user_owned MT5 reporting its own positions is normal, not an alert).
//   * Returns no secrets. The body schema is the same Mt5SyncPositionsBody
//     used by the legacy route.
router.post("/mt5/sync-positions-per-user", bridgeAuthPerUserOnly, async (req, res) => {
  try {
    const body = Mt5SyncPositionsBody.parse(req.body);
    const conn = (req as Request & { mt5Connection: typeof mt5ConnectionTable.$inferSelect }).mt5Connection;

    // Per-connection state: persist this EA's snapshot so future routes can
    // surface it. We reuse the singleton mt5_state for the legacy global view
    // but do NOT overwrite it when this connection is a registered master —
    // master positions belong to a master, not to "the system".
    const isMaster = await (async () => {
      try {
        const [sma] = await db.select({ id: sharedMasterAccountsTable.id })
          .from(sharedMasterAccountsTable)
          .where(eq(sharedMasterAccountsTable.connectionId, conn.id))
          .limit(1);
        return !!sma;
      } catch (e) {
        req.log.warn({ err: e }, "sync_positions_per_user_master_lookup_failed");
        return false;
      }
    })();

    if (!isMaster) {
      // User-owned MT5 — nothing to detect. Just acknowledge so the EA can
      // continue. We deliberately do NOT touch mt5_state here either, since
      // that table is the legacy global singleton owned by the system bridge.
      res.json({ received: true, isMaster: false, unattributedRecorded: 0, unattributedSkipped: 0 });
      return;
    }

    // Master path. For each reported position, check if a
    // shared_trade_attribution row exists by mt5PositionTicket. If not, the
    // trade is unattributed — record it (idempotent per tick).
    let recorded = 0;
    let skipped = 0;
    let attributed = 0;
    for (const pos of body.positions) {
      const ticket = String(pos.ticket);
      if (!ticket || ticket === "0") {
        skipped += 1;
        continue;
      }
      try {
        const [att] = await db.select({ id: sharedTradeAttributionTable.id })
          .from(sharedTradeAttributionTable)
          .where(and(
            eq(sharedTradeAttributionTable.masterConnectionId, conn.id),
            eq(sharedTradeAttributionTable.mt5PositionTicket, ticket),
          ))
          .limit(1);
        if (att) {
          attributed += 1;
          continue;
        }
      } catch (e) {
        req.log.warn({ err: e, ticket }, "sync_positions_per_user_attribution_lookup_failed");
        skipped += 1;
        continue;
      }

      // Normalize side. Mt5SyncPositionsBody uses `side: string`. EA convention
      // is "buy"/"sell" or 0/1; map defensively, default null when unknown.
      const sideLower = (pos.side ?? "").toLowerCase();
      const side: "BUY" | "SELL" | null =
        sideLower === "buy" || sideLower === "0" ? "BUY" :
        sideLower === "sell" || sideLower === "1" ? "SELL" : null;

      const result = await recordUnattributedMasterTrade({
        masterConnectionId: conn.id,
        tradeCommandId: null,            // sync_positions path has no ARX command
        mt5PositionTicket: ticket,
        mt5OrderTicket: null,            // EA snapshot doesn't include order ticket
        symbol: pos.symbol,
        side,
        lotSize: pos.lot,
        fillPrice: pos.entry,
        slippage: null,
        brokerMessage: null,
        source: "sync_positions",
        executedAt: null,                // unknown from snapshot
      });
      if (result.recorded) recorded += 1;
      else skipped += 1;
    }

    res.json({
      received: true,
      isMaster: true,
      attributed,
      unattributedRecorded: recorded,
      unattributedSkipped: skipped,
    });
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid positions sync" });
  }
});

// ── Task #30 — EA reports real per-symbol broker rules ──────────────────────
// The EA pushes the broker's own SymbolInfo* facts for each Market-Watch
// symbol so ARX validates against broker truth instead of a static guess.
// bridgeAuthPerUserOnly + per-user attribution. This NEVER enables execution;
// it only lets ARX refuse unsafe trades earlier (off-step lot, SL inside stops
// level, symbol not tradable, etc).
const SymbolSpecItem = z.object({
  symbol: z.string().min(1).max(32),
  brokerSymbol: z.string().max(64).optional().nullable(),
  visible: z.boolean().optional().nullable(),
  tradeAllowed: z.boolean().optional().nullable(),
  tradeMode: z.enum(["FULL", "LONGONLY", "SHORTONLY", "CLOSEONLY", "DISABLED"]).optional().nullable(),
  marketOpen: z.boolean().optional().nullable(),
  digits: z.number().int().optional().nullable(),
  point: z.number().optional().nullable(),
  minVolume: z.number().optional().nullable(),
  maxVolume: z.number().optional().nullable(),
  volumeStep: z.number().optional().nullable(),
  contractSize: z.number().optional().nullable(),
  tickSize: z.number().optional().nullable(),
  tickValue: z.number().optional().nullable(),
  stopsLevelPoints: z.number().int().optional().nullable(),
  freezeLevelPoints: z.number().int().optional().nullable(),
  spreadPoints: z.number().int().optional().nullable(),
});
const SyncSymbolSpecsBody = z.object({ symbols: z.array(SymbolSpecItem).max(500) });

router.post("/mt5/sync-symbol-specs", bridgeAuthPerUserOnly, async (req, res) => {
  const userConn = (req as Request & { mt5Connection?: typeof mt5ConnectionTable.$inferSelect }).mt5Connection ?? null;
  if (!userConn || userConn.userId == null) { res.status(401).json({ error: "Per-user bridge required" }); return; }
  const connUserId = userConn.userId;
  const parsed = SyncSymbolSpecsBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid symbol specs", details: parsed.error.issues }); return; }
  const now = new Date();
  let upserted = 0;
  for (const s of parsed.data.symbols) {
    await db.insert(arxSymbolSpecsTable).values({
      userId: connUserId,
      bridgeConnectionId: userConn.id,
      accountType: userConn.accountType ?? null,
      symbol: s.symbol,
      brokerSymbol: s.brokerSymbol ?? null,
      visible: s.visible ?? null,
      tradeAllowed: s.tradeAllowed ?? null,
      tradeMode: s.tradeMode ?? null,
      marketOpen: s.marketOpen ?? null,
      digits: s.digits ?? null,
      point: s.point ?? null,
      minVolume: s.minVolume ?? null,
      maxVolume: s.maxVolume ?? null,
      volumeStep: s.volumeStep ?? null,
      contractSize: s.contractSize ?? null,
      tickSize: s.tickSize ?? null,
      tickValue: s.tickValue ?? null,
      stopsLevelPoints: s.stopsLevelPoints ?? null,
      freezeLevelPoints: s.freezeLevelPoints ?? null,
      spreadPoints: s.spreadPoints ?? null,
      reportedAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [arxSymbolSpecsTable.userId, arxSymbolSpecsTable.symbol],
      set: {
        bridgeConnectionId: userConn.id,
        accountType: userConn.accountType ?? null,
        brokerSymbol: s.brokerSymbol ?? null,
        visible: s.visible ?? null,
        tradeAllowed: s.tradeAllowed ?? null,
        tradeMode: s.tradeMode ?? null,
        marketOpen: s.marketOpen ?? null,
        digits: s.digits ?? null,
        point: s.point ?? null,
        minVolume: s.minVolume ?? null,
        maxVolume: s.maxVolume ?? null,
        volumeStep: s.volumeStep ?? null,
        contractSize: s.contractSize ?? null,
        tickSize: s.tickSize ?? null,
        tickValue: s.tickValue ?? null,
        stopsLevelPoints: s.stopsLevelPoints ?? null,
        freezeLevelPoints: s.freezeLevelPoints ?? null,
        spreadPoints: s.spreadPoints ?? null,
        reportedAt: now,
        updatedAt: now,
      },
    });
    upserted += 1;
  }
  req.log.info({ event: "mt5_symbol_specs_synced", connectionId: userConn.id, upserted }, "MT5 symbol specs synced");
  res.json({ received: true, upserted });
});

// ── EA CopyRates candle ingestion (Phase 4) ──────────────────────────────────
//
// CONTRACT — the per-user EA (planned CopyRates push) POSTs the latest window of
// closed bars for ONE symbol+timeframe per call:
//
//   POST /api/mt5/sync-candles   (X-MT5-Bridge-Token: <per-user token>)
//   {
//     "symbol": "EURUSD",          // ARX/display symbol the chart queries by
//     "brokerSymbol": "EURUSD.r",  // optional broker Market-Watch name (audit only)
//     "timeframe": "M5",           // M1|M5|M15|M30|H1|H4|D1 (or 1m/5m/...; normalized)
//     "priceBasis": "bid",         // bid|ask|mid|last (audit only)
//     "bars": [
//       { "time": "2026-06-07T08:00:00Z", "open": 1.09, "high": 1.092,
//         "low": 1.089, "close": 1.091, "tickVolume": 312, "spread": 0.6 }
//     ],
//     "lastBarIsFinal": true,      // false => last bar still forming
//     "eaVersion": "1.50",
//     "sentAt": "2026-06-07T08:05:01Z"
//   }
//
// SAFETY: in-memory push into mt5Provider keyed by symbol+timeframe (M5 can never
// be served under H1). Invalid OHLC bars are rejected. No DB write, no execution,
// no gate involvement — this is market-data only. Until the EA actually sends
// this payload, the endpoint exists but is never called and MT5 stays a
// non-contributing provider (honest: no fabricated candles).
const SyncCandlesBody = z.object({
  symbol: z.string().min(1),
  brokerSymbol: z.string().optional(),
  timeframe: z.string().min(1),
  priceBasis: z.enum(["bid", "ask", "mid", "last"]).optional(),
  bars: z.array(z.object({
    time: z.union([z.string(), z.number()]),
    open: z.number(),
    high: z.number(),
    low: z.number(),
    close: z.number(),
    tickVolume: z.number().optional(),
    volume: z.number().optional(),
    spread: z.number().optional(),
  })).max(5000),
  lastBarIsFinal: z.boolean().optional(),
  eaVersion: z.string().optional(),
  sentAt: z.union([z.string(), z.number()]).optional(),
});

// A bar is valid only when OHLC are finite, strictly positive, and satisfy
// high>=max(o,c) and low<=min(o,c) and high>=low. Anything else is a
// malformed/garbage bar and is dropped (never stored) so a bad bar cannot
// contaminate Chart Truth.
// Negative or zero prices are impossible for any real broker instrument and
// must be rejected — they indicate a corrupt payload or initialised-to-zero
// buffer from the EA, never real market data.
function isValidOhlc(b: { open: number; high: number; low: number; close: number }): boolean {
  const { open, high, low, close } = b;
  if (![open, high, low, close].every((n) => Number.isFinite(n))) return false;
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0) return false;
  if (high < low) return false;
  if (high < Math.max(open, close)) return false;
  if (low > Math.min(open, close)) return false;
  return true;
}

router.post("/mt5/sync-candles", bridgeAuthPerUserOnly, async (req, res) => {
  const userConn = (req as Request & { mt5Connection?: typeof mt5ConnectionTable.$inferSelect }).mt5Connection ?? null;
  if (!userConn || userConn.userId == null) { res.status(401).json({ error: "Per-user bridge required" }); return; }
  const parsed = SyncCandlesBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid candle payload", details: parsed.error.issues }); return; }
  const { symbol, timeframe, bars, brokerSymbol, priceBasis, lastBarIsFinal, eaVersion, sentAt } = parsed.data;

  // Pull provider freshness threshold so the push-staleness guard and the
  // response summary use the SAME source of truth the provider serves from.
  // (Centralizing all freshness constants into one shared module is Task #407;
  // for now we import the canonical CANDLE_TTL_MS from the provider.)
  const { updateCandlesFromMT5, getMt5SeriesFreshness, CANDLE_TTL_MS } =
    await import("../lib/data/providers/mt5Provider.js");
  const STALE_PUSH_MAX_PAST_MS = CANDLE_TTL_MS; // 5 min — older payloads are stale on the wire
  const STALE_PUSH_MAX_FUTURE_MS = 2 * 60_000;  // tolerate ≤2 min EA clock skew ahead

  // Reject a STALE PUSH by its transport timestamp (`sentAt`) — NOT by per-bar
  // age (a 300–1000 bar CopyRates backfill legitimately contains old bars and
  // must be accepted). A `sentAt` far in the past means a delayed/replayed
  // payload; far in the future means a skewed clock. Either way we refuse it so
  // stale broker bars never masquerade as fresh. No existing good series is
  // cleared. Only enforced when the EA actually provides `sentAt`.
  if (sentAt != null) {
    const sentMs = new Date(sentAt).getTime();
    if (Number.isNaN(sentMs)) {
      // Unparsable transport timestamp — fail CLOSED. We cannot prove the push is
      // fresh, so we refuse it rather than silently ignoring the guard. Any
      // existing good series is left untouched.
      req.log.warn(
        { event: "mt5_candles_invalid_push_timestamp", connectionId: userConn.id, symbol, timeframe, sentAt: String(sentAt) },
        "MT5 candle push rejected — invalid sentAt",
      );
      res.json({ received: true, stored: 0, accepted: 0, rejected: bars.length, note: "invalid_push_timestamp" });
      return;
    }
    const skew = Date.now() - sentMs;
    if (skew > STALE_PUSH_MAX_PAST_MS || skew < -STALE_PUSH_MAX_FUTURE_MS) {
      req.log.warn(
        { event: "mt5_candles_stale_push", connectionId: userConn.id, symbol, timeframe, sentAt: String(sentAt), skewMs: skew },
        "MT5 candle push rejected — stale/skewed sentAt",
      );
      res.json({ received: true, stored: 0, accepted: 0, rejected: bars.length, note: "stale_push_timestamp" });
      return;
    }
  }

  // Normalize → validate → de-dupe by timestamp (last write wins) → sort ascending.
  const byTime = new Map<string, { time: string; open: number; high: number; low: number; close: number; volume?: number }>();
  let rejected = 0;
  for (const b of bars) {
    if (!isValidOhlc(b)) { rejected += 1; continue; }
    const parsedTime = new Date(b.time);
    if (Number.isNaN(parsedTime.getTime())) { rejected += 1; continue; }
    const time = parsedTime.toISOString();
    byTime.set(time, {
      time, open: b.open, high: b.high, low: b.low, close: b.close,
      volume: b.tickVolume ?? b.volume,
    });
  }
  const candles = [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time));

  // Provenance fields are accepted for audit traceability and forward-compat.
  // They are NOT persisted into the in-memory candle store (which holds OHLC+
  // volume only) — they are logged so an operator can trace which EA build /
  // price basis / broker symbol produced a given push. The store is keyed by
  // the ARX `symbol` verbatim; `brokerSymbol` is informational (symbol
  // resolution to the broker happens at chart READ time, not at ingest).
  const provenance = {
    brokerSymbol: brokerSymbol ?? null,
    priceBasis: priceBasis ?? null,
    lastBarIsFinal: lastBarIsFinal ?? null,
    eaVersion: eaVersion ?? null,
    sentAt: sentAt != null ? String(sentAt) : null,
  };

  if (candles.length === 0) {
    // Nothing storable — do NOT clear an existing good series; just report.
    req.log.info(
      { event: "mt5_candles_synced", connectionId: userConn.id, symbol, timeframe, stored: 0, rejected, ...provenance },
      "MT5 candle push had no valid bars",
    );
    res.json({ received: true, stored: 0, accepted: 0, rejected, note: "no_valid_bars" });
    return;
  }

  updateCandlesFromMT5(symbol, candles, timeframe);

  // Honest freshness summary so the EA (and operators) can see exactly how the
  // server will treat this series: newest bar time, the serving TTL, and
  // whether the series counts as fresh right now (it just got pushed, so it is).
  const freshness = getMt5SeriesFreshness(symbol, timeframe);
  const newestBarTime = candles[candles.length - 1].time;

  req.log.info(
    { event: "mt5_candles_synced", connectionId: userConn.id, symbol, timeframe, stored: candles.length, rejected, newestBarTime, ...provenance },
    "MT5 candles ingested",
  );
  res.json({
    received: true,
    stored: candles.length,
    accepted: candles.length,
    rejected,
    freshness: {
      newestBarTime,
      fresh: freshness.fresh,
      ageMs: freshness.ageMs,
      barCount: freshness.barCount,
      ttlMs: CANDLE_TTL_MS,
    },
  });
});

// ── EA quote ingestion (Phase 4, future-ready) ───────────────────────────────
// POST /api/mt5/sync-quotes — { symbol, bid, ask, spread?, last?, timestamp? }
const SyncQuoteBody = z.object({
  symbol: z.string().min(1),
  bid: z.number().optional(),
  ask: z.number().optional(),
  spread: z.number().optional(),
  last: z.number().optional(),
  timestamp: z.union([z.string(), z.number()]).optional(),
});

router.post("/mt5/sync-quotes", bridgeAuthPerUserOnly, async (req, res) => {
  const userConn = (req as Request & { mt5Connection?: typeof mt5ConnectionTable.$inferSelect }).mt5Connection ?? null;
  if (!userConn || userConn.userId == null) { res.status(401).json({ error: "Per-user bridge required" }); return; }
  const parsed = SyncQuoteBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid quote payload", details: parsed.error.issues }); return; }
  const { symbol, bid, ask, spread, last } = parsed.data;
  if (bid != null && !Number.isFinite(bid)) { res.status(400).json({ error: "Invalid bid" }); return; }
  if (ask != null && !Number.isFinite(ask)) { res.status(400).json({ error: "Invalid ask" }); return; }

  const { updateQuoteFromMT5, CANDLE_TTL_MS } = await import("../lib/data/providers/mt5Provider.js");
  const STALE_QUOTE_MAX_PAST_MS = CANDLE_TTL_MS; // 5 min — older quotes are stale market data
  const STALE_QUOTE_MAX_FUTURE_MS = 2 * 60_000;  // tolerate ≤2 min EA clock skew ahead

  // A usable quote needs at least one positive price leg. A quote with no
  // usable price is dropped (not stored) so the router never serves a priceless
  // broker quote as if it were live truth.
  const hasUsablePrice =
    (bid != null && bid > 0) || (ask != null && ask > 0) || (last != null && last > 0);
  if (!hasUsablePrice) {
    res.json({ received: true, accepted: 0, rejected: 1, note: "no_usable_price" });
    return;
  }

  // Reject a STALE quote by its own timestamp — a quote is point-in-time market
  // data, so unlike a candle backfill it must be fresh. Far-past = delayed/
  // replayed; far-future = skewed clock. Only enforced when a timestamp is
  // supplied (otherwise we stamp receive-time).
  const tsRaw = parsed.data.timestamp;
  if (tsRaw != null) {
    const tsMs = new Date(tsRaw).getTime();
    if (Number.isNaN(tsMs)) {
      // An unparsable timestamp is suspect EA output — fail CLOSED with an
      // explicit reject rather than crashing on the later toISOString(). We must
      // never stamp receive-time over a malformed value (that would launder a
      // bad timestamp into "fresh").
      req.log.warn(
        { event: "mt5_quote_invalid_timestamp", connectionId: userConn.id, symbol, timestamp: String(tsRaw) },
        "MT5 quote rejected — invalid timestamp",
      );
      res.json({ received: true, accepted: 0, rejected: 1, note: "invalid_quote_timestamp" });
      return;
    }
    const skew = Date.now() - tsMs;
    if (skew > STALE_QUOTE_MAX_PAST_MS || skew < -STALE_QUOTE_MAX_FUTURE_MS) {
      req.log.warn(
        { event: "mt5_quote_stale", connectionId: userConn.id, symbol, timestamp: String(tsRaw), skewMs: skew },
        "MT5 quote rejected — stale/skewed timestamp",
      );
      res.json({ received: true, accepted: 0, rejected: 1, note: "stale_quote_timestamp" });
      return;
    }
  }

  // Safe: if tsRaw was present it parsed successfully above (NaN already returned).
  const timestamp = tsRaw != null ? new Date(tsRaw).toISOString() : new Date().toISOString();
  updateQuoteFromMT5(symbol, { symbol, bid, ask, spread, last, timestamp });

  req.log.info({ event: "mt5_quote_synced", connectionId: userConn.id, symbol }, "MT5 quote ingested");
  res.json({
    received: true,
    accepted: 1,
    rejected: 0,
    freshness: { timestamp, fresh: true, ttlMs: CANDLE_TTL_MS },
  });
});

// ── EA candle-HISTORY ingestion (Task #432) ──────────────────────────────────
//   POST /api/mt5/sync-candle-history   (X-MT5-Bridge-Token: <per-user token>)
//
// The EA's reply to a CANDLE_HISTORY_REQUEST command: a CopyRates backfill
// window for one symbol+timeframe. Validated + fed into the persisted candle
// cache (source "mt5_broker", deep durable storage) AND the in-memory provider
// series. Same payload shape as /sync-candles; the difference is INTENT — this
// is a deep history backfill, so it accumulates into the durable cache.
//
// SAFETY: market-data telemetry ONLY. No DB execution write, no order, no gate
// involvement. A STALE/replayed transport (by `sentAt`) is refused; invalid
// bars are dropped; an empty payload never clears an existing good series. The
// EA producer is untestable here — the server path is validated by crafted,
// real-shaped payloads in scripts/src/mt5CandleHistoryIngestTest.ts.
router.post("/mt5/sync-candle-history", bridgeAuthPerUserOnly, async (req, res) => {
  const userConn = (req as Request & { mt5Connection?: typeof mt5ConnectionTable.$inferSelect }).mt5Connection ?? null;
  if (!userConn || userConn.userId == null) { res.status(401).json({ error: "Per-user bridge required" }); return; }
  const { Mt5CandleHistoryIngestSchema, ingestMt5CandleHistory } =
    await import("../lib/data/mt5History.js");
  const parsed = Mt5CandleHistoryIngestSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid candle-history payload", details: parsed.error.issues }); return; }

  const result = await ingestMt5CandleHistory(parsed.data);
  req.log.info(
    {
      event: "mt5_candle_history_ingested",
      connectionId: userConn.id,
      symbol: parsed.data.symbol,
      timeframe: parsed.data.timeframe,
      accepted: result.accepted,
      rejected: result.rejected,
      stored: result.stored,
      note: result.note ?? null,
      newestBarTime: result.newestBarTime,
      oldestBarTime: result.oldestBarTime,
    },
    "MT5 candle history ingested",
  );
  res.json(result);
});

// ── EA broker-candle BATCH ingest (Task #469, Phase A) ───────────────────────
//   POST /api/mt5/candles/ingest   (X-MT5-Bridge-Token: <per-user token>)
//
// The canonical broker-native candle ingest: the EA streams CopyRates bars for
// one symbol+timeframe into the durable, bridge-scoped `broker_candles` store
// (full provenance + closed-bar finalization), maintains the per-series backfill
// state machine, and mirrors accepted CLOSED bars into the existing read-path
// cache + in-memory provider. This EXTENDS the candle ingestion foundation; it
// does NOT change source priority or any execution path.
//
// SAFETY: market-data telemetry ONLY. No DB execution write, no order, no gate
// involvement. A STALE/replayed transport (by `sentAt`) is refused; invalid
// bars are dropped; a CONFLICTING finalized bar is rejected, never overwritten;
// a FORMING bar is never mirrored into the live read path. The EA producer is
// untestable here — the server path is validated by crafted, real-shaped
// payloads in scripts/src/brokerCandleIngestTest.ts.
router.post("/mt5/candles/ingest", bridgeAuthPerUserOnly, async (req, res) => {
  const userConn = (req as Request & { mt5Connection?: typeof mt5ConnectionTable.$inferSelect }).mt5Connection ?? null;
  if (!userConn || userConn.userId == null) { res.status(401).json({ error: "Per-user bridge required" }); return; }
  const { BrokerCandleIngestSchema, ingestBrokerCandles } =
    await import("../lib/data/brokerCandleStore.js");
  const parsed = BrokerCandleIngestSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid broker-candle payload", details: parsed.error.issues }); return; }

  const result = await ingestBrokerCandles(parsed.data, {
    userId: userConn.userId,
    bridgeConnectionId: userConn.id,
    accountNumber: userConn.accountNumber ?? null,
  });
  req.log.info(
    {
      event: "mt5_broker_candles_ingested",
      connectionId: userConn.id,
      symbol: parsed.data.symbol,
      timeframe: parsed.data.timeframe,
      acceptedBars: result.acceptedBars,
      rejectedBars: result.rejectedBars,
      note: result.note ?? null,
    },
    "MT5 broker candles ingested",
  );
  res.json(result);
});

export default router;
