import { Router, type Request } from "express";
import { z } from "zod/v4";
import {
  getStatus, setOperationalMode,
  engageKillSwitch, resetKillSwitch, listVaultEvents, listStateTransitions,
  driveGlobalState,
} from "../lib/safetyCore.js";
import { logUserOverride } from "../lib/vaultLogger.js";
import { secretsMatch } from "../lib/secretsMatch.js";
import { requirePermission, requireStopAuthority, readRoleFromRequest } from "../lib/security/middleware.js";
import { checkPermission } from "../lib/security/permissions.js";

import { scanVaultIntegrity } from "../lib/vaultIntegrity.js";
import { selectBrokerKind, describeRequiredSecrets, missingRequiredSecrets } from "../lib/broker/secrets.js";
import { getBrokerProvider } from "../lib/broker/registry.js";

// ═══════════════════════════════════════════════════════════════════════════
// /api/system/* — Phase 1 Safety Core + Phase 2 Vault endpoints
// ═══════════════════════════════════════════════════════════════════════════

const router = Router();

// ── Authority + actor identity for the three platform-wide mutating endpoints ─
//
// The audit found these three endpoints — POST /system/mode,
// /system/kill-switch/engage, /system/kill-switch/reset — mounted BARE:
// routes/index.ts:274 `router.use(systemRouter)` with no requireUser, no
// requireAdmin, no router.use, no checkPermission anywhere in this file. The
// only check on reset was the literal acknowledgement phrase, which the
// /emergency dialog prints on screen. The global gate denies anonymous /api/*,
// so any signed-in trader could release the platform emergency stop for every
// user or flip the global mode to LIVE_TRADING. Worse, the vault actor came
// from caller-supplied body fields (`changedBy` / `triggeredBy` / `resetBy`,
// hardcoded to "operator" by the UI), so the audit trail answering "who
// stopped trading and who restarted it" was caller-controlled fiction.
//
// Authority now follows the direction of the change — the same rule the rest of
// this codebase uses: a stop may be pulled widely, a release may not.
//   ENGAGE  → requireStopAuthority       (ANY signed-in user may pull a stop —
//                                        see the note on the route below; the
//                                        first version of this fix used
//                                        requirePermission here and 403'd every
//                                        ordinary user, who maps to VIEWER)
//   RESET   → live_trading:reset        (ADMIN/OWNER/SYSTEM only)
//   MODE ↓  → live_trading:kill_switch  (OBSERVE_ONLY / SUGGEST_ONLY do not execute)
//   MODE ↑  → live_trading:reset        (PAPER_TRADING / LIVE_TRADING do)
// These are the existing seeded permission keys (lib/security/seed.ts) used by
// routes/liveTrading.ts; no new key is introduced, so nothing depends on a
// re-seed to be enforced.

// Modes that can EXECUTE. Selecting one widens platform authority and needs
// the admin-level permission; the two observation modes only ever narrow it.
const EXECUTION_CAPABLE_MODES = new Set(["PAPER_TRADING", "LIVE_TRADING"]);

/**
 * The actor recorded in the vault — resolved from the session, NEVER from the
 * request body. Returns a stable, non-forgeable descriptor. When no per-user
 * session is attached (service/dev caller) it says so rather than inventing a
 * person: an unknown actor is recorded as unknown.
 */
function resolveActor(req: Request): string {
  const role = readRoleFromRequest(req);
  const user = req.authUser;
  return user
    ? `user:${user.id}(${role})`
    : `role:${role}(no user session)`;
}

const SetModeBody = z.object({
  mode: z.enum(["OBSERVE_ONLY", "SUGGEST_ONLY", "PAPER_TRADING", "LIVE_TRADING"]),
  // `changedBy` is accepted for wire compatibility and DELIBERATELY IGNORED —
  // the recorded actor comes from resolveActor(req). A caller cannot name
  // itself in the audit trail.
  changedBy: z.string().min(1).optional(),
});

const EngageKillBody = z.object({
  reason: z.string().min(1),
  // Ignored — see SetModeBody.changedBy.
  triggeredBy: z.string().min(1).optional(),
});

const ResetKillBody = z.object({
  // Ignored — see SetModeBody.changedBy.
  resetBy: z.string().min(1).optional(),
  acknowledgement: z.string().min(1),
});

// Rich vault filter — every dimension the spec requires (date, symbol, mode,
// source, type, severity), plus truthDomain + linkedTradeId for replay work.
const VaultListQuery = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100),
  sinceIso: z.string().optional(),
  untilIso: z.string().optional(),
  kind: z.string().optional(),
  source: z.string().optional(),
  severity: z.string().optional(),
  truthDomain: z.string().optional(),
  symbol: z.string().optional(),
  linkedTradeId: z.string().optional(),
  operationalMode: z.string().optional(),
});
const StateListQuery = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100),
});
const IntegrityQuery = z.object({
  limit: z.coerce.number().int().positive().max(2000).default(500),
  sinceIso: z.string().optional(),
});

const UserOverrideBody = z.object({
  user: z.string().min(1),
  action: z.string().min(1),
  targetTradeId: z.string().optional(),
  targetDecisionId: z.string().optional(),
  reasons: z.array(z.string()).optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// MT5-Deferred status — derived honesty layer.
//
// The user can use the entire app (paper trading, demo simulator, AI assist
// in simulator mode, risk governor, kill switch, journal, calendar, learning
// loop, audit) WITHOUT finishing the MT5 desktop/VPS bridge setup.
//
// This endpoint is *informational only*. It never mutates state, never marks
// the bridge as connected, and never unlocks live execution. Live execution
// remains gated by placeLiveOrderGuarded() and the safety core invariants
// (canPlaceTrades=false, kill switch, etc.) — those are not touched here.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/system/mt5-deferred-status", async (_req, res) => {
  try {
    const brokerKind = selectBrokerKind();
    const missing = missingRequiredSecrets(describeRequiredSecrets(brokerKind))
      .filter(s => s.required && !s.set)
      .map(s => s.key);
    let bridgeConnected = false;
    let accountReadable = false;
    try {
      const provider = getBrokerProvider();
      const status = await provider.status();
      bridgeConnected = !!status.connected;
      if (status.connected) {
        try { const acct = await provider.account(); accountReadable = !!acct; } catch { /* not readable */ }
      }
    } catch { /* fail closed: deferred */ }

    const deferred = brokerKind !== "mt5" || !bridgeConnected || !accountReadable;

    const reason = deferred
      ? (brokerKind !== "mt5"
          ? "BROKER_PROVIDER not set to mt5 — running with internal simulator."
          : !bridgeConnected
            ? "MT5 EA bridge has not sent a heartbeat. App continues in paper/demo simulator mode."
            : "MT5 connected but account snapshot not yet readable. App continues in paper/demo simulator mode.")
      : "MT5 bridge connected and account readable. Read-only mode active.";

    const availableModes = [
      { mode: "OFF",                  label: "Off",                                   available: true },
      { mode: "READ_ONLY",            label: "Read-Only Observation",                 available: true },
      { mode: "PAPER_ONLY",           label: "Paper Trading",                         available: true },
      { mode: "DEMO_MANUAL_SIM",      label: "Demo Manual Simulator",                 available: true },
      { mode: "DEMO_AI_ASSIST_SIM",   label: "Demo AI Assist Simulator",              available: true },
      { mode: "DEMO_AI_AUTO_SIM",     label: "Demo AI Auto Simulator",                available: true },
    ];
    const lockedReason = "MT5 bridge setup required before real broker execution.";
    const lockedModes = [
      { mode: "LIVE_MANUAL",          label: "Live Manual",                           lockedReason },
      { mode: "LIVE_AI_ASSIST",       label: "Live AI Assist",                        lockedReason },
      { mode: "LIVE_AI_AUTO_TEST",    label: "Live AI Auto-Test",                     lockedReason },
    ];

    res.json({
      deferred,
      reason,
      systemState: deferred ? "MT5_DEFERRED_SIMULATOR_MODE" : "MT5_READ_ONLY",
      brokerProvider: brokerKind,
      bridgeConnected,
      accountReadable,
      missingSecrets: missing,
      availableModes,
      lockedModes,
      // Inviolable invariants — surface them so the UI can prove they're true.
      liveExecutionLocked: true,
      liveLockReason: "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED",
      simulator: {
        mutatesLivePositions: false,
        mutatesMt5Commands: false,
        sendsRealOrders: false,
        enforcesRiskGovernor: true,
        enforcesKillSwitch: true,
        updatesJournal: true,
        updatesCalendar: true,
        updatesLearningLoop: true,
        writesAuditVault: true,
      },
      bannerText: deferred
        ? "MT5 setup deferred — using paper/demo simulator. Live broker execution requires MT5 desktop/VPS bridge setup. You can finish MT5 setup later."
        : "MT5 bridge connected (read-only). Live broker execution still requires placement-layer build.",
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    (res.req as { log?: { error: (e: unknown) => void } }).log?.error(err);
    res.status(500).json({ error: "Failed to compute mt5-deferred status" });
  }
});

router.get("/system/status", async (_req, res) => {
  try {
    await driveGlobalState();
    const status = await getStatus();
    res.json(status);
  } catch (err) {
    (res.req as { log?: { error: (e: unknown) => void } }).log?.error(err);
    res.status(500).json({ error: "Failed to load safety core status" });
  }
});

// POST /system/mode — platform-wide operational mode.
// Floor permission (live_trading:kill_switch) is enforced by the middleware;
// selecting an EXECUTION-CAPABLE mode additionally requires the admin-level
// live_trading:reset, because that direction WIDENS what the platform may do.
router.post("/system/mode", requirePermission("live_trading:kill_switch"), async (req, res) => {
  try {
    const body = SetModeBody.parse(req.body);
    if (EXECUTION_CAPABLE_MODES.has(body.mode)) {
      const role = readRoleFromRequest(req);
      const decision = await checkPermission(role, "live_trading:reset");
      if (!decision.allowed) {
        res.status(403).json({
          error: "FORBIDDEN",
          message: `Switching the platform to ${body.mode} requires the live_trading:reset permission (ADMIN/OWNER). Your role is ${role}.`,
          requiredPermission: "live_trading:reset",
          role,
        });
        return;
      }
    }
    const result = await setOperationalMode({ mode: body.mode, changedBy: resolveActor(req) });
    res.status(result.ok ? 200 : 409).json(result);
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid mode change request" });
  }
});

// POST /system/kill-switch/engage — pulling the stop is a REDUCE-only action.
//
// REVIEW CORRECTION to the first rank-7 fix. That fix wrapped this route in
// requirePermission("live_trading:kill_switch"), which reads correctly but was
// wrong in production: routes/auth.ts:562-567 mirrors every regular DB `USER`
// onto the AuthRole VIEWER, lib/security/session.ts:94 defaults production to
// VIEWER, and lib/security/seed.ts does not grant VIEWER that permission. So
// the ordinary trader on /emergency — "the one safety item in every user's
// nav" — got a 403, the switch never engaged, and live dispatch was NOT halted.
// Before that fix the same user could engage it and it genuinely halted the
// Deriv guided path and the trade gate: the gate was a net loss of a working
// safety control for the majority of users.
//
// It also protected nothing. POST /bot/emergency-stop (routes/bot.ts,
// requireUser only) calls the SAME engageKillSwitch() for any signed-in user.
//
// So this route now requires AUTHENTICATION, not elevation — see
// requireStopAuthority(). Anonymous is still refused. RESET below keeps its
// ADMIN/OWNER permission gate, because releasing a stop WIDENS authority.
router.post("/system/kill-switch/engage", requireStopAuthority("live_trading:kill_switch"), async (req, res) => {
  try {
    const body = EngageKillBody.parse(req.body);
    await engageKillSwitch({ reason: body.reason, triggeredBy: resolveActor(req) });
    const status = await getStatus();
    res.json({ ok: true, status });
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid kill switch request" });
  }
});

// POST /system/kill-switch/reset — RELEASING the platform emergency stop for
// every user. Admin/owner only (live_trading:reset). The acknowledgement phrase
// stays, but it was never authority: it is printed on screen in the /emergency
// dialog, so it proves intent, not permission.
router.post("/system/kill-switch/reset", requirePermission("live_trading:reset"), async (req, res) => {
  try {
    const body = ResetKillBody.parse(req.body);
    const result = await resetKillSwitch({
      resetBy: resolveActor(req),
      acknowledgement: body.acknowledgement,
    });
    const status = await getStatus();
    res.status(result.ok ? 200 : 409).json({ ...result, status });
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid kill switch reset request" });
  }
});

// GET /system/vault — query vault events by date / symbol / mode / source /
// type / severity / truthDomain / linkedTradeId.
router.get("/system/vault", async (req, res) => {
  try {
    const q = VaultListQuery.parse({
      limit:           req.query["limit"],
      sinceIso:        req.query["sinceIso"],
      untilIso:        req.query["untilIso"],
      kind:            req.query["kind"],
      source:          req.query["source"],
      severity:        req.query["severity"],
      truthDomain:     req.query["truthDomain"],
      symbol:          req.query["symbol"],
      linkedTradeId:   req.query["linkedTradeId"],
      operationalMode: req.query["operationalMode"],
    });
    const events = await listVaultEvents(q);
    res.json({
      filters: q,
      count: events.length,
      events: events.map((e) => ({
        id: e.id, kind: e.kind, severity: e.severity, source: e.source,
        truthDomain: e.truthDomain,
        summary: e.summary, payload: e.payload, reasons: e.reasons, blockers: e.blockers,
        operationalMode: e.operationalMode, globalState: e.globalState,
        symbol: e.symbol,
        linkedTradeId: e.linkedTradeId,
        linkedSignalId: e.linkedSignalId,
        linkedDecisionId: e.linkedDecisionId,
        generatedAtIso: e.generatedAtIso,
        createdAt: e.createdAt?.toISOString() ?? null,
      })),
    });
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid vault query" });
  }
});

router.get("/system/state-transitions", async (req, res) => {
  try {
    const q = StateListQuery.parse({ limit: req.query["limit"] });
    const rows = await listStateTransitions(q.limit);
    res.json({
      transitions: rows.map((r) => ({
        id: r.id, fromState: r.fromState, toState: r.toState,
        fromSubstates: r.fromSubstates, toSubstates: r.toSubstates,
        changed: r.changed,
        acceptedSources: r.acceptedSources, rejectedSources: r.rejectedSources,
        reasons: r.reasons, blockers: r.blockers,
        generatedAtIso: r.generatedAtIso,
        createdAt: r.createdAt?.toISOString() ?? null,
      })),
    });
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid state transitions query" });
  }
});

// GET /system/vault/integrity — scan vault rows for missing / malformed /
// suspicious records. The result is an audit summary, not a side-effect.
router.get("/system/vault/integrity", async (req, res) => {
  try {
    const q = IntegrityQuery.parse({ limit: req.query["limit"], sinceIso: req.query["sinceIso"] });
    const report = await scanVaultIntegrity(q);
    res.json(report);
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid integrity scan request" });
  }
});

// POST /system/override — explicit human override is logged as a behaviour
// record so Trader DNA / lessons can attribute it later. Fail-closed auth:
// requires VAULT_OVERRIDE_TOKEN env var present AND matching header to keep
// adversaries from poisoning the behaviour log of the AI's memory.
router.post("/system/override", async (req, res) => {
  try {
    const expected = process.env["VAULT_OVERRIDE_TOKEN"];
    if (!expected) {
      res.status(503).json({ error: "Override endpoint disabled (VAULT_OVERRIDE_TOKEN unset)" });
      return;
    }
    const provided = req.header("X-Vault-Override-Token");
    if (!secretsMatch(provided, expected)) {
      res.status(401).json({ error: "Invalid or missing override token" });
      return;
    }
    const body = UserOverrideBody.parse(req.body);
    const status = await getStatus();
    await logUserOverride({
      user: body.user,
      action: body.action,
      targetTradeId: body.targetTradeId,
      targetDecisionId: body.targetDecisionId,
      reasons: body.reasons,
      operationalMode: status.operationalMode,
      globalState: status.globalState,
      generatedAtIso: new Date().toISOString(),
    });
    res.json({ ok: true });
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid override request" });
  }
});

export default router;
