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
import { and, desc, eq, inArray } from "drizzle-orm";
import { generateCoachReport } from "../lib/traderCoach/coach.js";
import { generatePlaybook, listPlaybookEntries, getPlaybookEntry } from "../lib/traderCoach/playbook.js";
import { generateWeeklyPlan } from "../lib/traderCoach/weekly.js";
import { requireUser } from "../lib/auth/middleware.js";

const router = Router();
const TAG = "Build II — Trader Coach + Playbook Generator. Coaching/review/playbook only. Never places trades, never calls MT5, never enables canPlaceTrades, never recommends live trading.";

/** Authenticated caller id — `requireUser` gates every /trader-coach/* route. */
function uid(req: import("express").Request): number {
  return req.authUser!.id;
}

function envelope(body: Record<string, unknown>) {
  return {
    system: "traderCoach",
    // NOTE: this states what the COACH is allowed to do — it can never
    // authorize or enable a live trade. It is NOT a reading of the caller's
    // account state, which this surface does not consult.
    liveTradingStatus: "DISABLED" as const,
    liveTradingStatusMeaning: "This coaching surface never authorizes live execution. It does not report whether live trading is enabled on your account." as const,
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
router.get("/trader-coach/status", requireUser, async (req, res) => {
  try {
    const r = await generateCoachReport(uid(req), { reportType: "DAILY", persist: false, log: buildLog(req) });
    res.json(envelope({ coach: r }));
  } catch (err) {
    res.status(500).json(envelope({ error: "Failed to generate coach status", detail: String(err).slice(0, 200) }));
  }
});

// POST /api/trader-coach/generate — persisted coach report.
router.post("/trader-coach/generate", requireUser, async (req, res) => {
  const reportType = (req.body?.reportType as "DAILY" | "WEEKLY" | "SESSION" | "PLAYBOOK") ?? "DAILY";
  const generatePlaybookEntries = !!req.body?.generatePlaybookEntries;
  try {
    const r = await generateCoachReport(uid(req), { reportType, persist: true, log: buildLog(req), generatePlaybookEntries });
    res.json(envelope({ coach: r, persisted: true }));
  } catch (err) {
    res.status(500).json(envelope({ error: "Failed to generate coach report", detail: String(err).slice(0, 200) }));
  }
});

// GET /api/trader-coach/daily — daily coach view.
router.get("/trader-coach/daily", requireUser, async (req, res) => {
  try {
    const r = await generateCoachReport(uid(req), { reportType: "DAILY", persist: false, log: buildLog(req) });
    const daily = {
      readiness: r.traderStatus,
      paperModeOnly: true,
      paperOnlyBadge: true,
      currentFocus: r.currentFocusAreas[0] ?? "Continue paper trading and capturing debriefs.",
      setupsToWatch: r.topStrengths,
      setupsToAvoid: r.topWeaknesses,
      mistakeToAvoidToday: r.repeatedMistakes[0]?.tag ?? "No high-frequency mistake yet — keep capturing debriefs.",
      preSessionChecklist: r.preSessionChecklist,
      sessionLimits: { maxTradesPerDay: 5, maxLossPerDay: 100 },
      dailyPaperLossReminder: "Stop paper trading immediately if today's net P&L breaches the daily loss limit.",
      // HONEST: describes this guidance's scope, not the reader's account.
      paperOnlyReminder: "This guidance is paper-only. The coach never authorizes live execution and does not report your account's live-trading state.",
      warnings: r.warnings,
      coachingSummary: r.coachingSummary,
    };
    res.json(envelope({ daily, coach_report_id: r.coach_report_id }));
  } catch (err) {
    res.status(500).json(envelope({ error: "Daily failed", detail: String(err).slice(0, 200) }));
  }
});

// GET /api/trader-coach/weekly — weekly improvement plan.
router.get("/trader-coach/weekly", requireUser, async (req, res) => {
  try {
    const persist = req.query.persist === "1" || req.query.persist === "true";
    const plan = await generateWeeklyPlan(uid(req), { persist });
    // Report what ACTUALLY happened, not what was requested.
    res.json(envelope({ weekly: plan, persisted: plan.persisted, persistenceNote: plan.persistenceNote }));
  } catch (err) {
    res.status(500).json(envelope({ error: "Weekly failed", detail: String(err).slice(0, 200) }));
  }
});

// GET /api/trader-coach/session-prep — pre-session checklist + governor.
router.get("/trader-coach/session-prep", requireUser, async (req, res) => {
  try {
    const r = await generateCoachReport(uid(req), { reportType: "SESSION", persist: false, log: buildLog(req) });
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
router.get("/trader-coach/post-session-review", requireUser, async (req, res) => {
  try {
    const r = await generateCoachReport(uid(req), { reportType: "SESSION", persist: false, log: buildLog(req) });
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
router.get("/trader-coach/playbook", requireUser, async (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 100)));
  try {
    const entries = await listPlaybookEntries(limit);
    res.json(envelope({
      playbook: entries, count: entries.length,
      // trading_playbook_entries has no owner column and is UNIQUE on
      // (symbol, setupName, actionBias): it is one shared library for the
      // whole platform. Saying so beats implying it is "your" playbook.
      scope: "INSTANCE_WIDE",
      scopeNote: "Playbook entries are a shared, platform-wide setup library — they are not derived from your data alone.",
    }));
  } catch (err) {
    res.status(500).json(envelope({ error: "Playbook list failed", detail: String(err).slice(0, 200) }));
  }
});

// POST /api/trader-coach/playbook/generate — idempotent playbook (re)generation.
router.post("/trader-coach/playbook/generate", requireUser, async (req, res) => {
  try {
    const summaries = await generatePlaybook({ log: buildLog(req) });
    res.json(envelope({
      scope: "INSTANCE_WIDE",
      scopeNote: "Regenerating the playbook updates the shared, platform-wide setup library — not a personal copy.",
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
router.get("/trader-coach/playbook/:id", requireUser, async (req, res) => {
  try {
    const entry = await getPlaybookEntry(String(req.params.id));
    if (!entry) { res.status(404).json(envelope({ error: "Playbook entry not found", id: req.params.id })); return; }
    res.json(envelope({ playbookEntry: entry, scope: "INSTANCE_WIDE" }));
  } catch (err) {
    res.status(500).json(envelope({ error: "Playbook get failed", detail: String(err).slice(0, 200) }));
  }
});

// POST /api/trader-coach/demo — persist a coach report and refresh the playbook.
router.post("/trader-coach/demo", requireUser, async (req, res) => {
  try {
    const userId = uid(req);
    const log = buildLog(req);
    const coach = await generateCoachReport(userId, { reportType: "DAILY", persist: true, log, generatePlaybookEntries: true });
    const weekly = await generateWeeklyPlan(userId, { persist: true });
    const myReports = await db.select().from(traderCoachReportsTable)
      .where(eq(traderCoachReportsTable.userId, userId))
      .orderBy(desc(traderCoachReportsTable.createdAt)).limit(3);
    // trader_coach_logs has no owner column; each row carries the
    // coachReportId of the report it belongs to, so ownership is resolved
    // through this user's own reports.
    const myReportIds = myReports.map((r) => r.coachReportId).filter((x): x is string => !!x);
    const recentLogs = myReportIds.length === 0 ? [] : await db.select().from(traderCoachLogsTable)
      .where(inArray(traderCoachLogsTable.coachReportId, myReportIds))
      .orderBy(desc(traderCoachLogsTable.createdAt)).limit(5);
    const playbookCount = await db.select().from(tradingPlaybookEntriesTable);
    const recentReports = myReports;
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
router.get("/trader-coach/logs", requireUser, async (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 50)));
  try {
    // trader_coach_logs has no user_id column. Ownership is resolved through
    // the caller's own coach reports (logs carry that report's id), so a
    // stranger's coach log can never appear here.
    const myReportIds = (await db.select({ id: traderCoachReportsTable.coachReportId })
      .from(traderCoachReportsTable)
      .where(eq(traderCoachReportsTable.userId, uid(req)))
      .orderBy(desc(traderCoachReportsTable.createdAt)).limit(200))
      .map((r) => r.id).filter((x): x is string => !!x);
    const rows = myReportIds.length === 0 ? [] : await db.select().from(traderCoachLogsTable)
      .where(inArray(traderCoachLogsTable.coachReportId, myReportIds))
      .orderBy(desc(traderCoachLogsTable.createdAt)).limit(limit);
    res.json(envelope({ logs: rows, count: rows.length }));
  } catch (err) {
    res.status(500).json(envelope({ error: "Logs failed", detail: String(err).slice(0, 200) }));
  }
});

// GET /api/trader-coach/reports?limit=20 — historical coach reports.
router.get("/trader-coach/reports", requireUser, async (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 20)));
  try {
    const rows = await db.select().from(traderCoachReportsTable)
      .where(eq(traderCoachReportsTable.userId, uid(req)))
      .orderBy(desc(traderCoachReportsTable.createdAt)).limit(limit);
    res.json(envelope({ reports: rows, count: rows.length }));
  } catch (err) {
    res.status(500).json(envelope({ error: "Reports failed", detail: String(err).slice(0, 200) }));
  }
});

export default router;
