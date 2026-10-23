// Build FF — Safe Paper Autopilot routes.
//
// SAFETY (strict freeze): NONE of these endpoints place real trades, call MT5,
// touch executeTrade / setCanPlaceTrades, or write to live_positions. Every
// response carries `simulated: true` and the FF disclaimer.

import { Router, type Response } from "express";
import { z } from "zod/v4";
import {
  db,
  autopilotCyclesTable,
  autopilotCycleLogsTable,
  autopilotSymbolCooldownsTable,
} from "@workspace/db";
import { desc } from "drizzle-orm";
import { runOneCycle } from "../lib/paperAutopilot/autopilotService.js";
import { paperAutopilotLoop } from "../lib/paperAutopilot/loopController.js";
import { loadSettings, saveSettings, DEFAULT_SETTINGS, assertSafe } from "../lib/paperAutopilot/settings.js";
import { runSniperFilter } from "../lib/paperAutopilot/sniperFilter.js";
import { orchestrate, persistDecision } from "./tradeDecision.js";
import { requireUser } from "../lib/auth/middleware.js";

const router = Router();
const FF_TAG = "Safe Paper Autopilot — PAPER_ONLY. Build FF never places live trades, never calls MT5, never enables canPlaceTrades.";

function ok(res: Response, body: Record<string, unknown>) {
  return res.json({ ...body, system: "paperAutopilot", simulated: true, mode: "PAPER_ONLY", liveTradingAllowed: false, disclaimer: FF_TAG });
}
function fail(res: Response, status: number, error: string, extra?: Record<string, unknown>) {
  return res.status(status).json({ error, ...(extra ?? {}), system: "paperAutopilot", simulated: true, mode: "PAPER_ONLY", liveTradingAllowed: false, disclaimer: FF_TAG });
}

// ── POST /paper-autopilot/run-once ────────────────────────────────────────
router.post("/paper-autopilot/run-once", async (req, res): Promise<void> => {
  try {
    const summary = await runOneCycle();
    ok(res, { cycle: summary });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "POST /paper-autopilot/run-once failed");
    fail(res, 500, "run-once failed", { detail: String(err).slice(0, 300) });
  }
});

// ── POST /paper-autopilot/demo ────────────────────────────────────────────
// Runs ONE cycle with overridden symbols (for smoke tests).
const DemoBody = z.object({
  symbol: z.string().min(1).optional(),
  symbols: z.array(z.string().min(1)).optional(),
  minSniperEntryScore: z.number().min(0).max(100).optional(),
  minConfidence: z.number().min(0).max(100).optional(),
  maxRiskScore: z.number().min(0).max(100).optional(),
});
router.post("/paper-autopilot/demo", async (req, res): Promise<void> => {
  const parse = DemoBody.safeParse(req.body ?? {});
  if (!parse.success) { fail(res, 400, "Invalid body", { issues: parse.error.issues }); return; }
  const symbols = parse.data.symbols ?? (parse.data.symbol ? [parse.data.symbol] : ["Volatility 75 Index"]);
  try {
    const summary = await runOneCycle({
      settingsOverride: {
        symbols,
        minSniperEntryScore: parse.data.minSniperEntryScore ?? 0,
        minConfidence: parse.data.minConfidence ?? 0,
        maxRiskScore: parse.data.maxRiskScore ?? 100,
      },
    });
    ok(res, { demo: true, cycle: summary });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "POST /paper-autopilot/demo failed");
    fail(res, 500, "demo failed", { detail: String(err).slice(0, 300) });
  }
});

// ── POST /paper-autopilot/start ───────────────────────────────────────────
router.post("/paper-autopilot/start", async (req, res): Promise<void> => {
  try {
    const r = await paperAutopilotLoop.start("api");
    if (!r.ok) { fail(res, 409, r.reason ?? "start refused", { status: r.status }); return; }
    ok(res, { started: true, status: r.status });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "POST /paper-autopilot/start failed");
    fail(res, 500, "start failed", { detail: String(err).slice(0, 300) });
  }
});

// ── POST /paper-autopilot/stop ────────────────────────────────────────────
router.post("/paper-autopilot/stop", async (req, res): Promise<void> => {
  try {
    const reason = typeof req.body?.reason === "string" ? req.body.reason : "manual stop";
    const r = paperAutopilotLoop.stop(reason);
    ok(res, { stopped: true, status: r.status });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "POST /paper-autopilot/stop failed");
    fail(res, 500, "stop failed", { detail: String(err).slice(0, 300) });
  }
});

// ── GET /paper-autopilot/status ───────────────────────────────────────────
router.get("/paper-autopilot/status", async (req, res): Promise<void> => {
  try {
    const settings = await loadSettings();
    assertSafe(settings);
    const lastCycle = (await db.select().from(autopilotCyclesTable)
      .orderBy(desc(autopilotCyclesTable.id)).limit(1))[0] ?? null;
    ok(res, {
      loop: paperAutopilotLoop.status(),
      settings,
      lastCycle,
      safety: {
        paperOnly: true,
        liveTradingAllowed: false,
        neverCallsMt5: true,
        neverCallsExecuteTrade: true,
        neverEnablesCanPlaceTrades: true,
      },
    });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "GET /paper-autopilot/status failed");
    fail(res, 500, "status failed", { detail: String(err).slice(0, 300) });
  }
});

// ── GET /paper-autopilot/settings ─────────────────────────────────────────
router.get("/paper-autopilot/settings", async (req, res): Promise<void> => {
  try {
    const settings = await loadSettings();
    assertSafe(settings);
    ok(res, { settings, defaults: DEFAULT_SETTINGS });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "GET /paper-autopilot/settings failed");
    fail(res, 500, "settings load failed", { detail: String(err).slice(0, 300) });
  }
});

// ── POST /paper-autopilot/settings ────────────────────────────────────────
const SettingsBody = z.object({
  enabled: z.boolean().optional(),
  symbols: z.array(z.string().min(1)).optional(),
  timeframes: z.array(z.string().min(1)).optional(),
  intervalSeconds: z.number().int().min(5).max(3600).optional(),
  maxCyclesPerStart: z.number().int().min(1).max(500).optional(),
  maxOpenPaperTrades: z.number().int().min(1).max(20).optional(),
  maxSameSymbolTrades: z.number().int().min(1).max(10).optional(),
  maxDailyPaperLoss: z.number().min(0).max(100000).optional(),
  minConfidence: z.number().min(0).max(100).optional(),
  maxRiskScore: z.number().min(0).max(100).optional(),
  minSniperEntryScore: z.number().min(0).max(100).optional(),
  cooldownMinutesAfterTrade: z.number().min(0).max(1440).optional(),
  cooldownMinutesAfterLoss: z.number().min(0).max(1440).optional(),
}).strict();
router.post("/paper-autopilot/settings", async (req, res): Promise<void> => {
  const parse = SettingsBody.safeParse(req.body ?? {});
  if (!parse.success) { fail(res, 400, "Invalid body", { issues: parse.error.issues }); return; }
  try {
    const merged = await saveSettings(parse.data);
    assertSafe(merged);
    ok(res, { settings: merged });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "POST /paper-autopilot/settings failed");
    fail(res, 500, "settings save failed", { detail: String(err).slice(0, 300) });
  }
});

// ── GET /paper-autopilot/cycles?limit=20 ──────────────────────────────────
router.get("/paper-autopilot/cycles", async (req, res): Promise<void> => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query["limit"] ?? 20) || 20));
    const rows = await db.select().from(autopilotCyclesTable)
      .orderBy(desc(autopilotCyclesTable.id)).limit(limit);
    ok(res, { cycles: rows, count: rows.length });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "GET /paper-autopilot/cycles failed");
    fail(res, 500, "cycles fetch failed", { detail: String(err).slice(0, 300) });
  }
});

// ── GET /paper-autopilot/logs?limit=50&cycleId= ───────────────────────────
router.get("/paper-autopilot/logs", async (req, res): Promise<void> => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query["limit"] ?? 50) || 50));
    const cycleId = typeof req.query["cycleId"] === "string" ? req.query["cycleId"] : null;
    const q = db.select().from(autopilotCycleLogsTable)
      .orderBy(desc(autopilotCycleLogsTable.id)).limit(limit);
    const rows = cycleId
      ? (await db.select().from(autopilotCycleLogsTable)
          .orderBy(desc(autopilotCycleLogsTable.id)).limit(limit))
          .filter((r) => r.autopilotCycleId === cycleId)
      : await q;
    ok(res, { logs: rows, count: rows.length });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "GET /paper-autopilot/logs failed");
    fail(res, 500, "logs fetch failed", { detail: String(err).slice(0, 300) });
  }
});

// ── POST /paper-autopilot/sniper-check ────────────────────────────────────
// Run AA + sniper filter for a symbol WITHOUT executing through EE. Useful
// for inspecting why a trade would be PASS/WAIT/REJECT.
const SniperBody = z.object({
  symbol: z.string().min(1).default("Volatility 75 Index"),
  persistDecision: z.boolean().optional().default(false),
  minSniperEntryScore: z.number().min(0).max(100).optional(),
});
router.post("/paper-autopilot/sniper-check", requireUser, async (req, res): Promise<void> => {
  const parse = SniperBody.safeParse(req.body ?? {});
  if (!parse.success) { fail(res, 400, "Invalid body", { issues: parse.error.issues }); return; }
  try {
    const settings = await loadSettings();
    assertSafe(settings);
    const decision = await orchestrate({ symbol: parse.data.symbol, proposedAction: "AUTO", injectMarketIssue: "NONE" }, req.authUser!.id);
    let decisionId: number | null = null;
    if (parse.data.persistDecision) decisionId = await persistDecision(decision, req.authUser!.id);

    const sniper = runSniperFilter({
      decision,
      minSniperEntryScore: parse.data.minSniperEntryScore ?? settings.minSniperEntryScore,
      conflict: { sameSymbolDirOpen: 0, totalOpen: 0, maxOpen: settings.maxOpenPaperTrades, maxSameSym: settings.maxSameSymbolTrades },
      cooldown: { active: false, reason: null, until: null },
      recentMistakeWarnings: decision.knownMistakeWarnings ?? [],
    });
    ok(res, { decisionId, decision, sniper });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "POST /paper-autopilot/sniper-check failed");
    fail(res, 500, "sniper-check failed", { detail: String(err).slice(0, 300) });
  }
});

// ── GET /paper-autopilot/cooldowns ────────────────────────────────────────
router.get("/paper-autopilot/cooldowns", async (req, res): Promise<void> => {
  try {
    const rows = await db.select().from(autopilotSymbolCooldownsTable)
      .orderBy(desc(autopilotSymbolCooldownsTable.id)).limit(50);
    ok(res, { cooldowns: rows, count: rows.length });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "GET /paper-autopilot/cooldowns failed");
    fail(res, 500, "cooldowns fetch failed", { detail: String(err).slice(0, 300) });
  }
});

export default router;
