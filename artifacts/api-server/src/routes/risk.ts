import { Router } from "express";
import { GetRiskSettingsResponse, UpdateRiskSettingsBody } from "@workspace/api-zod";
import { z } from "zod/v4";
import { computeRiskAudit, riskAuditBasis, riskAuditHaltFrom } from "../lib/riskAudit.js";
import { loadTradingHalt } from "../lib/safety/tradingHalt.js";
import { calculatePositionSize } from "../lib/riskGovernor/positionSizer.js";
import {
  evaluateDrawdownGuard, evaluateExposureGuard, evaluateMaxLossGuard,
  evaluateHardBlockRules,
} from "@workspace/domain/risk-governor";
import { shadowCapture } from "../lib/auditVault.js";
import { requireUser } from "../lib/auth/middleware.js";
import { getOrCreateUserRiskSettings, updateUserRiskSettings } from "../lib/risk/userRiskSettings.js";
import { loadEffectiveLimits } from "../lib/riskGovernor/limitSettings.js";

const router = Router();

// ── Risk mode presets ──────────────────────────────────────────────────────

const RISK_PRESETS = {
  Conservative: {
    riskMode: "Conservative",
    riskPerTradePct: 0.25,
    maxDailyLossPct: 1,
    maxWeeklyLossPct: 3,
    maxTradesPerDay: 3,
    stopAfterLosingStreak: 2,
    minConfidenceScore: 80,
    maxOpenTrades: 1,
    cooldownAfterLossMinutes: 60,
    maxLotSize: 0.05,
  },
  Balanced: {
    riskMode: "Balanced",
    riskPerTradePct: 0.5,
    maxDailyLossPct: 2,
    maxWeeklyLossPct: 5,
    maxTradesPerDay: 5,
    stopAfterLosingStreak: 3,
    minConfidenceScore: 75,
    maxOpenTrades: 2,
    cooldownAfterLossMinutes: 30,
    maxLotSize: 0.1,
  },
  Aggressive: {
    riskMode: "Aggressive",
    riskPerTradePct: 1,
    maxDailyLossPct: 3,
    maxWeeklyLossPct: 7,
    maxTradesPerDay: 8,
    stopAfterLosingStreak: 3,
    minConfidenceScore: 70,
    maxOpenTrades: 3,
    cooldownAfterLossMinutes: 15,
    maxLotSize: 0.2,
  },
} as const;

// ── Store ──────────────────────────────────────────────────────────────────
// Limits read and write user_risk_settings (the Risk Governor's one limit
// store); risk mode, confidence floor, symbol rules and the live lock stay
// in risk_settings. lib/risk/userRiskSettings.ts does the split.

// ── GET /risk/settings ─────────────────────────────────────────────────────

router.get("/risk/settings", requireUser, async (req, res) => {
  try {
    const settings = await getOrCreateUserRiskSettings(req.authUser!.id);
    const data = GetRiskSettingsResponse.parse(settings);
    return res.json(data);
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to get risk settings" });
  }
});

// ── PATCH /risk/settings ───────────────────────────────────────────────────

router.patch("/risk/settings", requireUser, async (req, res) => {
  try {
    const body = UpdateRiskSettingsBody.parse(req.body);
    const updated = await updateUserRiskSettings(req.authUser!.id, { ...body, riskMode: "Custom" }, { riskPreset: null });
    const data = GetRiskSettingsResponse.parse(updated);
    return res.json(data);
  } catch (err) {
    req.log.error(err);
    return res.status(400).json({ error: "Invalid risk settings" });
  }
});

// ── POST /risk/mode ────────────────────────────────────────────────────────

const RiskModeBody = z.object({
  mode: z.enum(["Conservative", "Balanced", "Aggressive"]),
});

router.post("/risk/mode", requireUser, async (req, res) => {
  try {
    const { mode } = RiskModeBody.parse(req.body);
    const preset = RISK_PRESETS[mode];
    const updated = await updateUserRiskSettings(req.authUser!.id, { ...preset }, { riskPreset: null });
    const data = GetRiskSettingsResponse.parse(updated);
    return res.json(data);
  } catch (err) {
    req.log.error(err);
    return res.status(400).json({ error: "Failed to apply risk mode preset" });
  }
});

// ── POST /risk/lock-live ───────────────────────────────────────────────────
// Writes the trader's risk_settings.liveLocked. It is a stored preference:
// the permission evaluator (/permission/status, trade-plan and confirmation
// checklists) lists it as a blocker, but no order path reads it — live
// dispatch is gated by live arming and the Risk Governor, and the legacy
// /mt5 mode is always LIVE_LOCKED. Wiring it into a gate is a product
// decision; the reply says what the toggle does and does not do.

const RiskLockBody = z.object({ locked: z.boolean() });

router.post("/risk/lock-live", requireUser, async (req, res) => {
  try {
    const { locked } = RiskLockBody.parse(req.body);
    await updateUserRiskSettings(req.authUser!.id, { liveLocked: locked });
    return res.json({
      locked,
      message: locked
        ? "Live mode lock saved. It is a preference: your permission status and checklists list it as a blocker, but orders are not checked against it."
        : "Live mode lock removed. This does not enable live trading: live orders still need live arming and must pass the Risk Governor.",
    });
  } catch (err) {
    req.log.error(err);
    return res.status(400).json({ error: "Failed to update live lock" });
  }
});

// ── GET /risk/audit ────────────────────────────────────────────────────────

const RiskAuditQuery = z.object({
  symbol:      z.string().optional(),
  confidence:  z.coerce.number().optional(),
  riskReward:  z.coerce.number().optional(),
});

router.get("/risk/audit", requireUser, async (req, res) => {
  try {
    const query = RiskAuditQuery.parse(req.query);
    const settings = await getOrCreateUserRiskSettings(req.authUser!.id);
    // Placeholder account balance (1000 USD) — no MT5 sync feeds this yet.
    // The response says so (balanceSource, accountBalanceUsed) along with
    // what the audit read (riskAuditBasis), so no consumer can mistake it
    // for the trader's live balance or current book.
    const accountBalance = 1000;
    // The trader's kill switches (platform emergency stop, safety core, their
    // own kill switch), from the same reader the pre-trade Risk Governor uses
    // (fail closed: an unreadable switch counts as engaged). Not read here:
    // the broker's operator controls and a frozen shared-account allocation,
    // which the governor also applies to DEMO / LIVE orders; the page says
    // so. Read only for this view; nothing here changes what any order path
    // blocks.
    const userId = req.authUser!.id;
    const [paperHalt, liveHalt] = await Promise.all([
      loadTradingHalt({ userId, venue: "PAPER" }),
      loadTradingHalt({ userId, venue: "LIVE" }),
    ]);
    const audit = await computeRiskAudit(accountBalance, {
      riskPerTradePct:       settings.riskPerTradePct,
      maxDailyLossPct:       settings.maxDailyLossPct,
      maxWeeklyLossPct:      settings.maxWeeklyLossPct,
      maxTradesPerDay:       settings.maxTradesPerDay,
      maxOpenTrades:         settings.maxOpenTrades,
      stopAfterLosingStreak: settings.stopAfterLosingStreak,
      minConfidenceScore:    settings.minConfidenceScore,
      symbol:      query.symbol,
      confidence:  query.confidence,
      riskReward:  query.riskReward,
      us30BlockNews:       settings.us30BlockNews,
      stocksBlockEarnings: settings.stocksBlockEarnings,
      forexBlockEvents:    settings.forexBlockEvents,
      vol75ExtraConfidence: settings.vol75ExtraConfidence,
    }, { countClosedRows: true, userId, halt: riskAuditHaltFrom(paperHalt, liveHalt) });
    // tradeScope / notMeasured follow what this result says it read (scope,
    // closedTradesMeasured); a result that does not say is unscoped and
    // unmeasured.
    const basis = riskAuditBasis(audit);
    return res.json({
      ...audit,
      balanceSource: "PLACEHOLDER_1000",
      accountBalanceUsed: accountBalance,
      tradeSource: basis.tradeSource,
      tradeScope: basis.tradeScope,
      notMeasured: basis.notMeasured,
      evaluatedAt: new Date().toISOString(),
    });
  } catch (err) {
    req.log.error(err);
    return res.status(500).json({ error: "Failed to compute risk audit" });
  }
});

// ── GET /risk/position-size ────────────────────────────────────────────────

const PositionSizeQuery = z.object({
  symbol:         z.string(),
  accountBalance: z.coerce.number(),
  riskPercent:    z.coerce.number(),
  entry:          z.coerce.number(),
  stopLoss:       z.coerce.number(),
});

router.get("/risk/position-size", requireUser, async (req, res) => {
  try {
    const parsed = PositionSizeQuery.parse(req.query);
    // The calculator's symbol is free text: "eurusd" or " XAUUSD" is sized
    // and described as the market it names (this route serves only the
    // calculator; mission and paper sizing pass their own symbols).
    const query = { ...parsed, symbol: parsed.symbol.trim().toUpperCase() };
    // The lot cap in force, as the Risk Governor applies it: the strictest of
    // the trader's own cap, the operator's account limit and the platform
    // ceiling, then the trader's per-symbol cap. (The trader's saved cap
    // alone could show a lot the governor refuses.) The broker's own maximum
    // volume is not known here.
    const limits = await loadEffectiveLimits(req.authUser!.id);
    const symbolCap = limits.symbolLimits[query.symbol]?.maxLots ?? null;
    const result = calculatePositionSize({
      ...query,
      maxLotSize: symbolCap == null ? limits.maxLotSize : Math.min(limits.maxLotSize, symbolCap),
    });
    // The governor's max_position_size check also refuses some orders
    // outright, whatever the lot (same order as preTrade.ts). The side is
    // read from the stop: below the entry is a BUY, above it a SELL. For
    // such an order there is no allowed lot to show, only the reason.
    const side = query.stopLoss < query.entry ? "BUY" : query.stopLoss > query.entry ? "SELL" : null;
    const refusedReason = limits.allowedSymbols && !limits.allowedSymbols.includes(query.symbol)
      ? `${query.symbol} is not on the instruments your operator allowed for your account, so the Risk Governor refuses every order on it.`
      : limits.allowedDirection && side && side !== limits.allowedDirection
        ? `Your account is restricted to ${limits.allowedDirection} trades only. A stop ${side === "BUY" ? "below" : "above"} the entry is a ${side} trade, so the Risk Governor refuses it.`
        : limits.symbolLimits[query.symbol]?.blocked
          ? `Trading ${query.symbol} is switched off in your risk limits, so the Risk Governor refuses every order on it.`
          : null;
    if (refusedReason) {
      return res.json({ ...result, maxLotAllowed: 0, finalLot: 0, warning: null, refusedReason });
    }
    return res.json({ ...result, refusedReason: null });
  } catch (err) {
    req.log.error(err);
    return res.status(400).json({ error: "Failed to calculate position size" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1 — Risk Governor sub-guards (advisory).
//
// These endpoints run the new pure sub-engines and emit FS_GUARD_* vault
// events. They are advisory: every response carries canPlaceTrades:false and
// the existing master /risk/audit + Control Tower retain final authority.
// ═══════════════════════════════════════════════════════════════════════════

const ADVISORY_MODE = "RISK_GUARD_PIPELINE";

function envelope<T>(payload: T) {
  return { canPlaceTrades: false, mode: ADVISORY_MODE, generatedAtIso: new Date().toISOString(), result: payload };
}

async function logGuardEvent(eventType: string, severity: "INFO" | "WARN" | "DANGER", payload: unknown) {
  await shadowCapture({
    source: "risk-governor",
    eventType: eventType as never,
    severity,
    systemMode: null, globalState: null,
    payload: payload as Record<string, unknown>,
  });
}

router.post("/risk/guards/drawdown", async (req, res) => {
  try {
    const v = evaluateDrawdownGuard(req.body);
    await logGuardEvent("FS_GUARD_DRAWDOWN", v.passed ? "INFO" : "WARN", v);
    return res.json(envelope(v));
  } catch (err) {
    req.log.error(err);
    return res.status(400).json({ error: "Invalid drawdown guard input" });
  }
});

router.post("/risk/guards/exposure", async (req, res) => {
  try {
    const v = evaluateExposureGuard(req.body);
    await logGuardEvent("FS_GUARD_EXPOSURE", v.passed ? "INFO" : "WARN", v);
    return res.json(envelope(v));
  } catch (err) {
    req.log.error(err);
    return res.status(400).json({ error: "Invalid exposure guard input" });
  }
});

router.post("/risk/guards/max-loss", async (req, res) => {
  try {
    const v = evaluateMaxLossGuard(req.body);
    await logGuardEvent("FS_GUARD_MAX_LOSS", v.passed ? "INFO" : "WARN", v);
    return res.json(envelope(v));
  } catch (err) {
    req.log.error(err);
    return res.status(400).json({ error: "Invalid max-loss guard input" });
  }
});

router.post("/risk/guards/hard-block", async (req, res) => {
  try {
    const v = evaluateHardBlockRules(req.body);
    await logGuardEvent(
      "FS_GUARD_HARD_BLOCK",
      v.passed ? "INFO" : v.blockingKinds.length > 1 ? "DANGER" : "WARN",
      { passed: v.passed, blockingKinds: v.blockingKinds, dataMissing: v.dataMissing },
    );
    return res.json(envelope(v));
  } catch (err) {
    req.log.error(err);
    return res.status(400).json({ error: "Invalid hard-block input" });
  }
});

export default router;
