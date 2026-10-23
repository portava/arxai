import { Router } from "express";
import { db, riskSettingsTable, riskLocksTable, tradesTable, vaultEventsTable } from "@workspace/db";
import { and, desc, eq, gte, isNull, or } from "drizzle-orm";
import {
  CreateRiskLockBody,
  ReleaseRiskLockBody,
  EvaluatePermissionBody,
} from "@workspace/api-zod";
import { z } from "zod/v4";
import { evaluatePermission, type ActiveLockSummary } from "@workspace/domain/safety-permission";
import { getStatus } from "../lib/safetyCore.js";
import { explainPermission } from "../lib/aiLearning/permissionCoach.js";
import { selectBrokerKind, userHasActiveBridgeToken } from "../lib/broker/secrets.js";
import { getBrokerProvider } from "../lib/broker/registry.js";
import { getOrCreateUserRiskSettings } from "../lib/risk/userRiskSettings.js";
import { requireUser } from "../lib/auth/middleware.js";

// Build TT — FULL TESTER ACCESS overlay.
// canExecuteRealBrokerOrder STAYS FALSE until placement layer + MT5 are wired.
async function buildTesterAccessOverlay() {
  let mt5Connected = false;
  if (selectBrokerKind() === "mt5") {
    try { mt5Connected = !!(await getBrokerProvider().status()).connected; } catch { mt5Connected = false; }
  }
  return {
    fullTesterAccess: true,
    canViewAllRoutes: true,
    canUsePaper: true,
    canUseDemoSimulator: true,
    canUseLiveTesterWorkflows: true,
    canSubmitLiveIntent: true,
    canExecuteRealBrokerOrder: false, // gated by placeLiveOrderGuarded() — never bypassed
    mt5Connected,
    brokerExecutionAvailable: false,
    reason: mt5Connected
      ? "Live broker execution requires the guarded order router (BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED)."
      : "MT5 bridge not connected yet",
  };
}

const router = Router();

// ── Helpers ─────────────────────────────────────────────────────────────────

function startOfTodayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function durationMinutesForLockType(lockType: string, fallback: number | null | undefined): number | null {
  switch (lockType) {
    case "COOLDOWN_15M":         return 15;
    case "COOLDOWN_30M":         return 30;
    case "COOLDOWN_1H":          return 60;
    case "COOLDOWN_REST_OF_DAY": {
      const now = new Date();
      const eod = new Date(now);
      eod.setUTCHours(23, 59, 59, 999);
      return Math.max(1, Math.ceil((eod.getTime() - now.getTime()) / 60000));
    }
    default:
      return typeof fallback === "number" && fallback > 0 ? fallback : null;
  }
}

function rowToActiveLock(row: typeof riskLocksTable.$inferSelect): ActiveLockSummary {
  const startTimeIso = row.startTime.toISOString();
  const endTimeIso = row.endTime ? row.endTime.toISOString() : null;
  const remainingMs = row.endTime ? Math.max(0, row.endTime.getTime() - Date.now()) : null;
  return {
    lockType: row.lockType,
    reason: row.reason,
    startTimeIso,
    endTimeIso,
    remainingMs,
    overrideAllowed: row.overrideAllowed,
  };
}

function rowToRiskLockResponse(row: typeof riskLocksTable.$inferSelect) {
  return {
    id: row.id,
    lockType: row.lockType,
    reason: row.reason,
    startTimeIso: row.startTime.toISOString(),
    endTimeIso: row.endTime ? row.endTime.toISOString() : null,
    isActive: row.isActive,
    overrideAllowed: row.overrideAllowed,
    relatedTradeId: row.relatedTradeId,
    releasedAtIso: row.releasedAt ? row.releasedAt.toISOString() : null,
    releasedBy: row.releasedBy,
    createdAtIso: row.createdAt ? row.createdAt.toISOString() : null,
  };
}

async function loadActiveLocks() {
  // Filter at SELECT time: a lock is "active" if isActive AND (no end_time OR end_time still in the future).
  const rows = await db.select().from(riskLocksTable)
    .where(and(
      eq(riskLocksTable.isActive, true),
      or(isNull(riskLocksTable.endTime), gte(riskLocksTable.endTime, new Date())),
    ))
    .orderBy(desc(riskLocksTable.startTime));
  return rows;
}

export async function gatherInputsAndEvaluate(userId: number) {
  const [sysStatus, settings, todaysTrades, activeLockRows, brokerCredentialsConfigured] = await Promise.all([
    getStatus(),
    getOrCreateUserRiskSettings(userId),
    db.select().from(tradesTable)
      .where(and(eq(tradesTable.userId, userId), gte(tradesTable.createdAt, startOfTodayUtc())))
      .orderBy(desc(tradesTable.createdAt)),
    loadActiveLocks(),
    // Per-user bridge tokens are the ONLY valid EA auth (the legacy
    // MT5_BRIDGE_TOKEN env value is rejected on every EA endpoint), so
    // "broker credentials configured" = THIS user has an active token.
    userHasActiveBridgeToken(userId),
  ]);

  const activeLocks = activeLockRows.map(rowToActiveLock);

  // Today's loss percent: sum of pnl on closed trades; expressed as % of starting balance proxy.
  // For MVP we report sum of pnl in dollars converted via a balance proxy of $10,000.
  // (riskAudit.ts uses similar convention; keep it consistent here.)
  const closedToday = todaysTrades.filter((t) => t.status === "CLOSED" && typeof t.pnl === "number");
  const sumPnl = closedToday.reduce((acc, t) => acc + (t.pnl ?? 0), 0);
  const balanceProxy = 10_000;
  const todaysLossPct = (sumPnl / balanceProxy) * 100; // negative if losing

  // Consecutive losses: count from most recent closed trades backward while pnl < 0.
  let consecutiveLosses = 0;
  for (const t of closedToday) {
    if ((t.pnl ?? 0) < 0) consecutiveLosses++;
    else break;
  }

  const liveAllowed = sysStatus.allowedModes.includes("LIVE_TRADING") && !settings.liveLocked;

  const verdict = evaluatePermission({
    operationalMode: sysStatus.operationalMode,
    killSwitchEngaged: sysStatus.killSwitchEngaged,
    mt5LinkHealth: sysStatus.mt5LinkHealth,
    liveAllowed,

    maxDailyLossPct: settings.maxDailyLossPct,
    maxTradesPerDay: settings.maxTradesPerDay,
    stopAfterLosingStreak: settings.stopAfterLosingStreak,
    maxLotSize: settings.maxLotSize,
    cooldownAfterLossMinutes: settings.cooldownAfterLossMinutes,
    liveLocked: settings.liveLocked,

    todaysTradesCount: todaysTrades.length,
    todaysLossPct,
    consecutiveLosses,

    activeLocks,
    brokerCredentialsConfigured,
  });

  const explanation = explainPermission(verdict);
  return { verdict, explanation };
}

// ── Routes ──────────────────────────────────────────────────────────────────

router.get("/permission/status", requireUser, async (req, res) => {
  try {
    const [{ verdict, explanation }, testerAccess] = await Promise.all([
      gatherInputsAndEvaluate(req.authUser!.id),
      buildTesterAccessOverlay(),
    ]);
    return res.json({ ...verdict, explanation, testerAccess });
  } catch (err) {
    req.log.error({ err: String(err) }, "permission/status failed");
    return res.status(500).json({ error: "Failed to compute permission status" });
  }
});

router.post("/permission/evaluate", requireUser, async (req, res) => {
  try {
    EvaluatePermissionBody.parse(req.body ?? {});
    const [{ verdict, explanation }, testerAccess] = await Promise.all([
      gatherInputsAndEvaluate(req.authUser!.id),
      buildTesterAccessOverlay(),
    ]);
    return res.json({ ...verdict, explanation, testerAccess });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid body", details: err.issues });
    req.log.error({ err: String(err) }, "permission/evaluate failed");
    return res.status(500).json({ error: "Failed to evaluate permission" });
  }
});

router.get("/risk-locks", async (req, res) => {
  try {
    const rows = await loadActiveLocks();
    return res.json({ locks: rows.map(rowToRiskLockResponse) });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /risk-locks failed");
    return res.status(500).json({ error: "Failed to load risk locks" });
  }
});

router.post("/risk-locks", async (req, res) => {
  try {
    const body = CreateRiskLockBody.parse(req.body);

    // Idempotency / race guard: if an active lock of the same type already
    // exists (and hasn't naturally expired), return it instead of creating a
    // duplicate. Prevents UI double-clicks or concurrent rule triggers from
    // polluting the table.
    const existingActive = await loadActiveLocks();
    const dup = existingActive.find((row) => row.lockType === body.lockType);
    if (dup) {
      return res.json(rowToRiskLockResponse(dup));
    }

    const minutes = durationMinutesForLockType(body.lockType, body.durationMinutes ?? null);
    const startTime = new Date();
    const endTime = minutes !== null ? new Date(startTime.getTime() + minutes * 60_000) : null;

    const [inserted] = await db.insert(riskLocksTable).values({
      lockType: body.lockType,
      reason: body.reason,
      startTime,
      endTime,
      isActive: true,
      overrideAllowed: body.overrideAllowed ?? false,
      relatedTradeId: body.relatedTradeId ?? null,
    }).returning();

    // Append a vault event so /risk-events surfaces it without a separate table.
    await db.insert(vaultEventsTable).values({
      kind: `RISK_LOCK_CREATED`,
      severity: body.lockType === "USER_MANUAL" ? "INFO" : "WARN",
      source: body.lockType === "USER_MANUAL" ? "USER" : "RISK_GOVERNOR",
      truthDomain: "SAFETY",
      summary: `Risk lock created: ${body.lockType} — ${body.reason}`,
      payload: { lockId: inserted!.id, lockType: body.lockType, durationMinutes: minutes },
      reasons: [body.reason],
      blockers: [],
      generatedAtIso: startTime.toISOString(),
    }).catch((err) => {
      req.log.warn({ err: String(err) }, "vault event append failed (non-fatal)");
    });

    return res.json(rowToRiskLockResponse(inserted!));
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid body", details: err.issues });
    req.log.error({ err: String(err) }, "POST /risk-locks failed");
    return res.status(500).json({ error: "Failed to create risk lock" });
  }
});

router.post("/risk-locks/:id/release", async (req, res) => {
  try {
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
    const body = ReleaseRiskLockBody.parse(req.body);

    const [existing] = await db.select().from(riskLocksTable).where(eq(riskLocksTable.id, id)).limit(1);
    if (!existing) return res.status(404).json({ error: "Lock not found" });
    if (!existing.isActive) return res.status(409).json({ error: "Lock is not active" });
    if (!existing.overrideAllowed) {
      return res.status(409).json({ error: "Lock cannot be released — override not allowed by policy." });
    }

    const releasedAt = new Date();
    const [updated] = await db.update(riskLocksTable)
      .set({ isActive: false, releasedAt, releasedBy: body.releasedBy || "USER" })
      .where(eq(riskLocksTable.id, id))
      .returning();

    await db.insert(vaultEventsTable).values({
      kind: "RISK_LOCK_RELEASED",
      severity: "INFO",
      source: "USER",
      truthDomain: "SAFETY",
      summary: `Risk lock released: ${existing.lockType} — ${body.acknowledgement}`,
      payload: { lockId: id, lockType: existing.lockType, acknowledgement: body.acknowledgement },
      reasons: [body.acknowledgement],
      blockers: [],
      generatedAtIso: releasedAt.toISOString(),
    }).catch(() => { /* non-fatal */ });

    return res.json(rowToRiskLockResponse(updated!));
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid body", details: err.issues });
    req.log.error({ err: String(err) }, "POST /risk-locks/:id/release failed");
    return res.status(500).json({ error: "Failed to release risk lock" });
  }
});

router.get("/risk-events", async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query["limit"]) || 50));
    const severity = typeof req.query["severity"] === "string" ? req.query["severity"] : undefined;

    // Risk-relevant vault event kinds
    const RISK_KINDS = [
      "RISK_LOCK_CREATED",
      "RISK_LOCK_RELEASED",
      "TRADE_GATE",
      "BLOCKED_TRADE",
      "REJECTED_TRADE",
      "KILL_SWITCH",
      "MODE_CHANGE",
      "STATE_TRANSITION",
    ];

    const rows = await db.select().from(vaultEventsTable)
      .orderBy(desc(vaultEventsTable.createdAt))
      .limit(limit * 4); // overfetch then filter

    const filtered = rows
      .filter((r) => RISK_KINDS.includes(r.kind))
      .filter((r) => (severity ? r.severity === severity : true))
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        severity: r.severity,
        source: r.source,
        summary: r.summary,
        payload: r.payload as Record<string, unknown>,
        reasons: r.reasons as string[],
        blockers: r.blockers as string[],
        operationalMode: r.operationalMode,
        globalState: r.globalState,
        generatedAtIso: r.generatedAtIso,
        createdAt: r.createdAt ? r.createdAt.toISOString() : null,
      }));

    return res.json({ events: filtered });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /risk-events failed");
    return res.status(500).json({ error: "Failed to load risk events" });
  }
});

export default router;
