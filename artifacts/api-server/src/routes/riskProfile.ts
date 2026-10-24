// Risk profile, budget and prop-firm mode — per trader.
//
// These routes used to drive one in-memory "Risk Governor 2.0" profile shared
// by every user. They now read and configure the signed-in trader's own
// settings, which the one pre-trade Risk Governor enforces. Nothing here
// authorises an order; /risk/pre-trade-check is a preview of the governor.
//
// SAFETY: requireUser on every route; the user is always req.authUser, never
// a client-supplied id. Pausing engages the trader's own kill switch only —
// it can never halt the platform (that is the operator emergency stop).

import { Router } from "express";
import { z } from "zod/v4";
import { engageKillSwitchForUser, releaseKillSwitchForUser } from "../lib/live/liveArming.js";
import { requireUser } from "../lib/auth/middleware.js";
import {
  RISK_PRESETS, applyRiskPreset, configurePropFirm, listRiskEventsView, propFirmStatus, riskOverview, type RiskPreset,
} from "../lib/riskGovernor/riskProfile.js";
import { getOrCreateRiskSettings } from "../lib/riskGovernor/riskEvents.js";
import { previewJournalTicket } from "../lib/riskGovernor/journal.js";
import type { RiskVenue } from "../lib/riskGovernor/preTrade.js";

const router = Router();

const venueOf = (v: unknown): RiskVenue => (v === "DEMO" || v === "LIVE" ? v : "PAPER");

// Profile: the trader's settings, the preset they applied and the effective limits.
router.get("/risk-profile", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const [settings, ov] = await Promise.all([getOrCreateRiskSettings(userId), riskOverview(userId, venueOf(req.query.venue))]);
  res.json({ preset: settings.riskPreset ?? "CUSTOM", settings, effectiveLimits: ov.limits, presets: RISK_PRESETS });
});

router.post("/risk-profile/preset/:preset", requireUser, async (req, res) => {
  const p = z.enum(RISK_PRESETS).safeParse(String(req.params.preset));
  if (!p.success) { res.status(400).json({ error: "bad preset", presets: RISK_PRESETS }); return; }
  const settings = await applyRiskPreset(req.authUser!.id, p.data as RiskPreset);
  res.json({ preset: p.data, settings });
});

// Reads (one venue at a time; ?venue=PAPER|DEMO|LIVE, default PAPER).
router.get("/risk/budget", requireUser, async (req, res) => {
  const ov = await riskOverview(req.authUser!.id, venueOf(req.query.venue));
  res.json({ ...ov.budget, venue: ov.venue });
});

router.get("/risk/dashboard-cards", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const ov = await riskOverview(userId, venueOf(req.query.venue));
  const pf = await propFirmStatus(userId);
  res.json({
    venue: ov.venue,
    riskStatus: ov.budget.riskStatus,
    dailyRiskRemaining: ov.budget.dailyRiskRemaining,
    weeklyRiskRemaining: ov.budget.weeklyRiskRemaining,
    openRisk: ov.budget.openRisk,
    openPositions: ov.budget.openPositions,
    tradesToday: ov.activity?.tradesToday ?? null,
    consecutiveLosses: ov.activity?.consecutiveLosses ?? null,
    overtrading: (ov.activity?.closesInLastHour ?? 0) >= 5 ? "OVERTRADING_RISK"
      : (ov.activity?.reentriesAfterLossInLastHour ?? 0) >= 2 ? "REVENGE_TRADING_RISK" : "NORMAL",
    activeHalts: ov.halt.sources,
    propFirm: pf.config.enabled ? pf : null,
    permissions: ov.permissions,
  });
});

router.get("/risk/events", requireUser, async (req, res) => {
  const events = await listRiskEventsView({ userId: req.authUser!.id, limit: Math.min(Number(req.query.limit) || 200, 500) });
  res.json({ events });
});

router.get("/risk/status", requireUser, async (req, res) => {
  const ov = await riskOverview(req.authUser!.id, venueOf(req.query.venue));
  res.json({ paused: { paused: ov.halt.engaged, reason: ov.halt.reason }, permissions: ov.permissions, venue: ov.venue });
});

// Pre-trade check: a preview of the Risk Governor for a paper ticket.
router.post("/risk/pre-trade-check", requireUser, async (req, res) => {
  const Body = z.object({
    symbol: z.string(), direction: z.enum(["BUY", "SELL"]), lotSize: z.number(),
    entryPrice: z.number().optional(), stopLoss: z.number().optional(), takeProfit: z.number().optional(),
  }).passthrough();
  const p = Body.safeParse(req.body ?? {});
  if (!p.success) { res.status(400).json({ error: "invalid", issues: p.error.issues }); return; }
  const check = await previewJournalTicket(req.authUser!.id, {
    symbol: p.data.symbol, side: p.data.direction, lots: p.data.lotSize, entryPrice: p.data.entryPrice ?? null,
    stopLoss: p.data.stopLoss ?? null, takeProfit: p.data.takeProfit ?? null, process: {},
  });
  res.json({ approved: check.decision === "pass", reason: check.reason, hardBlocks: check.risk.blockedBy, rules: check.risk.rules });
});

// Pause / resume: the trader's own kill switch (halts their orders on every
// venue). Written by its one owner, lib/live/liveArming.ts: engaging also
// disarms live (re-arm required after resume) and both are audited.
router.post("/risk/pause", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const reason = String(req.body?.reason ?? "Paused from the risk command center").slice(0, 300);
  await engageKillSwitchForUser({ userId, reason });
  res.json({ paused: true, reason, scope: "your account" });
});
router.post("/risk/resume", requireUser, async (req, res) => {
  await releaseKillSwitchForUser({ userId: req.authUser!.id });
  res.json({ paused: false, scope: "your account" });
});

// Prop firm
router.get("/prop-firm/status", requireUser, async (req, res) => {
  res.json(await propFirmStatus(req.authUser!.id));
});
const PropFirmBody = z.object({
  enabled: z.boolean().optional(),
  startingBalance: z.number().positive().optional(),
  profitTarget: z.number().nonnegative().optional(),
  maxDailyDrawdownUsd: z.number().positive().optional(),
  maxTotalDrawdownUsd: z.number().positive().optional(),
  minTradingDays: z.number().int().nonnegative().optional(),
  maxLotSize: z.number().positive().optional(),
  maxPositions: z.number().int().positive().optional(),
  newsTradingAllowed: z.boolean().optional(),
  weekendHoldingAllowed: z.boolean().optional(),
  consistencyRulePctOfTotal: z.number().min(0).max(100).optional(),
});
router.post("/prop-firm/configure", requireUser, async (req, res) => {
  const p = PropFirmBody.safeParse(req.body ?? {});
  if (!p.success) { res.status(400).json({ error: "invalid", issues: p.error.issues }); return; }
  const r = await configurePropFirm(req.authUser!.id, p.data);
  res.json(r.config);
});
router.post("/prop-firm/reset", requireUser, async (req, res) => {
  const r = await configurePropFirm(req.authUser!.id, { enabled: true });
  res.json(r.config);
});

export default router;
