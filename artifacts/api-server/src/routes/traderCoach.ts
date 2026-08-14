// Build II — Trader Coach + Playbook routes.
//
// SAFETY: All endpoints are coaching/playbook/review/planning only. They
// NEVER place trades, NEVER call MT5, NEVER modify canPlaceTrades.
// liveTradingStatus is hardcoded "DISABLED" in every response envelope.

import { Router } from "express";
import {
  db,
  traderCoachReportsTable,
  traderCoachLogsTable,
  tradingPlaybookEntriesTable,
} from "@workspace/db";
import { desc } from "drizzle-orm";
import { generateCoachReport } from "../lib/traderCoach/coach.js";
import { generatePlaybook, listPlaybookEntries, getPlaybookEntry } from "../lib/traderCoach/playbook.js";
import { generateWeeklyPlan } from "../lib/traderCoach/weekly.js";

const router = Router();
const TAG = "Build II — Trader Coach + Playbook Generator. Coaching/review/playbook only. Never places trades, never calls MT5, never enables canPlaceTrades, never recommends live trading.";

function envelope(body: Record<string, unknown>) {
  return {
    system: "traderCoach",
    liveTradingStatus: "DISABLED" as const,
    mode: "PAPER_ONLY" as const,
    disclaimer: TAG,
    ...body,
  };
}

function buildLog(req: { log?: { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void } }) {
  return {
    info: (m: string, x?: Record<string, unknown>) => req.log?.info?.(x ?? {}, `Build II coach: ${m}`),
    warn: (m: string, x?: Record<string, unknown>) => req.log?.warn?.(x ?? {}, `Build II coach: ${m}`),
    error: (m: string, x?: Record<string, unknown>) => req.log?.error?.(x ?? {}, `Build II coach: ${m}`),
  };
}

// GET /api/trader-coach/status — fast non-persisted summary.
router.get("/trader-coach/status", async (req, res) => {
  try {
    const r = await generateCoachReport({ reportType: "DAILY", persist: false, log: buildLog(req) });
    res.json(envelope({ coach: r }));
  } catch (err) {
    res.status(500).json(envelope({ error: "Failed to generate coach status", detail: String(err).slice(0, 200) }));
  }
});

// POST /api/trader-coach/generate — persisted coach report.
router.post("/trader-coach/generate", async (req, res) => {
  const reportType = (req.body?.reportType as "DAILY" | "WEEKLY" | "SESSION" | "PLAYBOOK") ?? "DAILY";
  const generatePlaybookEntries = !!req.body?.generatePlaybookEntries;
  try {
    const r = await generateCoachReport({ reportType, persist: true, log: buildLog(req), generatePlaybookEntries });
    res.json(envelope({ coach: r, persisted: true }));
  } catch (err) {
    res.status(500).json(envelope({ error: "Failed to generate coach report", detail: String(err).slice(0, 200) }));
  }
});

// GET /api/trader-coach/daily — daily coach view.
router.get("/trader-coach/daily", async (req, res) => {
  try {
    const r = await generateCoachReport({ reportType: "DAILY", persist: false, log: buildLog(req) });
    const daily = {
      readiness: r.traderStatus,
      paperModeOnly: true,
      liveTradingDisabledBadge: true,
      currentFocus: r.currentFocusAreas[0] ?? "Continue paper trading and capturing debriefs.",
      setupsToWatch: r.topStrengths,
      setupsToAvoid: r.topWeaknesses,
      mistakeToAvoidToday: r.repeatedMistakes[0]?.tag ?? "No high-frequency mistake yet — keep capturing debriefs.",
      preSessionChecklist: r.preSessionChecklist,
      sessionLimits: { maxTradesPerDay: 5, maxLossPerDay: 100 },
      dailyPaperLossReminder: "Stop paper trading immediately if today's net P&L breaches the daily loss limit.",
      liveTradingDisabledReminder: "Live trading is DISABLED. This guidance is paper-only.",
      warnings: r.warnings,
      coachingSummary: r.coachingSummary,
    };
    res.json(envelope({ daily, coach_report_id: r.coach_report_id }));
  } catch (err) {
    res.status(500).json(envelope({ error: "Daily failed", detail: String(err).slice(0, 200) }));
  }
});

// GET /api/trader-coach/weekly — weekly improvement plan.
router.get("/trader-coach/weekly", async (req, res) => {
  try {
    const persist = req.query.persist === "1" || req.query.persist === "true";
    const plan = await generateWeeklyPlan({ persist });
    res.json(envelope({ weekly: plan, persisted: persist }));
  } catch (err) {
    res.status(500).json(envelope({ error: "Weekly failed", detail: String(err).slice(0, 200) }));
  }
});

// GET /api/trader-coach/session-prep — pre-session checklist + governor.
router.get("/trader-coach/session-prep", async (req, res) => {
  try {
    const r = await generateCoachReport({ reportType: "SESSION", persist: false, log: buildLog(req) });
    res.json(envelope({
      sessionPrep: {
        traderStatus: r.traderStatus,
        preSessionChecklist: r.preSessionChecklist,
        currentFocusAreas: r.currentFocusAreas,
        nextBestActions: r.nextBestActions,
        warnings: r.warnings,
        coachingSummary: r.coachingSummary,
      },
    }));
  } catch (err) {
    res.status(500).json(envelope({ error: "Session prep failed", detail: String(err).slice(0, 200) }));
  }
});

// GET /api/trader-coach/post-session-review — post-session review questions.
router.get("/trader-coach/post-session-review", async (req, res) => {
  try {
    const r = await generateCoachReport({ reportType: "SESSION", persist: false, log: buildLog(req) });
    res.json(envelope({
      postSessionReview: {
        traderStatus: r.traderStatus,
        performanceSummary: r.performanceSummary,
        repeatedMistakes: r.repeatedMistakes,
        postSessionReviewQuestions: r.postSessionReviewQuestions,
        nextBestActions: r.nextBestActions,
        coachingSummary: r.coachingSummary,
        warnings: r.warnings,
      },
    }));
  } catch (err) {
    res.status(500).json(envelope({ error: "Post-session review failed", detail: String(err).slice(0, 200) }));
  }
});

// GET /api/trader-coach/playbook — list current playbook entries.
router.get("/trader-coach/playbook", async (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 100)));
  try {
    const entries = await listPlaybookEntries(limit);
    res.json(envelope({ playbook: entries, count: entries.length }));
  } catch (err) {
    res.status(500).json(envelope({ error: "Playbook list failed", detail: String(err).slice(0, 200) }));
  }
});

// POST /api/trader-coach/playbook/generate — idempotent playbook (re)generation.
router.post("/trader-coach/playbook/generate", async (req, res) => {
  try {
    const summaries = await generatePlaybook({ log: buildLog(req) });
    res.json(envelope({
      playbookUpdates: summaries,
      created: summaries.filter(s => s.changeType === "CREATED").length,
      updated: summaries.filter(s => s.changeType === "UPDATED").length,
      total: summaries.length,
    }));
  } catch (err) {
    res.status(500).json(envelope({ error: "Playbook generation failed", detail: String(err).slice(0, 200) }));
  }
});

// GET /api/trader-coach/playbook/:id
router.get("/trader-coach/playbook/:id", async (req, res) => {
  try {
    const entry = await getPlaybookEntry(req.params.id);
    if (!entry) { res.status(404).json(envelope({ error: "Playbook entry not found", id: req.params.id })); return; }
    res.json(envelope({ playbookEntry: entry }));
  } catch (err) {
    res.status(500).json(envelope({ error: "Playbook get failed", detail: String(err).slice(0, 200) }));
  }
});

// POST /api/trader-coach/demo — persist a coach report and refresh the playbook.
router.post("/trader-coach/demo", async (req, res) => {
  try {
    const log = buildLog(req);
    const coach = await generateCoachReport({ reportType: "DAILY", persist: true, log, generatePlaybookEntries: true });
    const weekly = await generateWeeklyPlan({ persist: true });
    const [recentReports, recentLogs, playbookCount] = await Promise.all([
      db.select().from(traderCoachReportsTable).orderBy(desc(traderCoachReportsTable.createdAt)).limit(3),
      db.select().from(traderCoachLogsTable).orderBy(desc(traderCoachLogsTable.createdAt)).limit(5),
      db.select().from(tradingPlaybookEntriesTable),
    ]);
    res.json(envelope({
      demo: true,
      coach,
      weekly,
      stats: {
        coach_reports_total: recentReports.length,
        coach_logs_total: recentLogs.length,
        playbook_entries_total: playbookCount.length,
      },
    }));
  } catch (err) {
    res.status(500).json(envelope({ error: "Demo failed", detail: String(err).slice(0, 200) }));
  }
});

// GET /api/trader-coach/logs?limit=50
router.get("/trader-coach/logs", async (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 50)));
  try {
    const rows = await db.select().from(traderCoachLogsTable)
      .orderBy(desc(traderCoachLogsTable.createdAt)).limit(limit);
    res.json(envelope({ logs: rows, count: rows.length }));
  } catch (err) {
    res.status(500).json(envelope({ error: "Logs failed", detail: String(err).slice(0, 200) }));
  }
});

// GET /api/trader-coach/reports?limit=20 — historical coach reports.
router.get("/trader-coach/reports", async (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 20)));
  try {
    const rows = await db.select().from(traderCoachReportsTable)
      .orderBy(desc(traderCoachReportsTable.createdAt)).limit(limit);
    res.json(envelope({ reports: rows, count: rows.length }));
  } catch (err) {
    res.status(500).json(envelope({ error: "Reports failed", detail: String(err).slice(0, 200) }));
  }
});

export default router;
