// Build LL — Notification Center routes.
//
// SAFETY: alerts/notifications only. Endpoints NEVER place trades, NEVER
// modify canPlaceTrades, NEVER call MT5, NEVER expose secrets.
//
// PHASE-2: every notification read/write is scoped to req.authUser.id. The
// shared digest/logs/ingest endpoints remain global because they describe
// system-wide health (not user data) and contain no per-user PII.

import { Router } from "express";
import {
  notify, listNotifications, getCounts, getById,
  markRead, markAcknowledged, markDismissed, snooze, markAllRead,
  getPreferences, setPreferences,
  generateDigest, latestDigest, listLogs, seedDemo,
} from "../lib/notifications/service.js";
import {
  ruleGovernorEvaluation, ruleMarketData, rulePaperExecution, ruleAutopilot,
  ruleDebrief, ruleLearning, ruleCoach, ruleReplay, ruleImport, ruleBroker,
  ruleAADecision, ruleCommandCenter, ruleSystemError,
  type NotifyInput,
} from "../lib/notifications/rules.js";
import { ingest } from "../lib/notifications/ingest.js";
import { requireUser } from "../lib/auth/middleware.js";

const router = Router();
const TAG = "Build LL — Notification Center + Safety Alerts. Alerts/notifications only. Never places trades, never enables live trading, never calls MT5, never modifies canPlaceTrades, never exposes secrets.";

function envelope(body: Record<string, unknown>) {
  return {
    system: "notifications",
    liveTradingStatus: "DISABLED" as const,
    mode: "ALERTS_ONLY" as const,
    liveTradingAllowed: false as const,
    canPlaceLiveTrade: false as const,
    disclaimer: TAG,
    ...body,
  };
}

router.get("/notifications", requireUser, async (req, res) => {
  try {
    const items = await listNotifications(req.authUser!.id, {
      type: req.query.type as string | undefined,
      severity: req.query.severity as string | undefined,
      status: req.query.status as string | undefined,
      sourceBuild: req.query.sourceBuild as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : 50,
    });
    res.json(envelope({ count: items.length, notifications: items }));
  } catch (err) {
    res.status(500).json(envelope({ error: "list failed", detail: String(err).slice(0, 200) }));
  }
});

router.get("/notifications/unread", requireUser, async (req, res) => {
  try {
    const items = await listNotifications(req.authUser!.id, { status: "UNREAD", limit: 100 });
    res.json(envelope({ count: items.length, notifications: items }));
  } catch (err) {
    res.status(500).json(envelope({ error: "unread failed", detail: String(err).slice(0, 200) }));
  }
});

router.get("/notifications/counts", requireUser, async (req, res) => {
  try { res.json(envelope({ counts: await getCounts(req.authUser!.id) })); }
  catch (err) { res.status(500).json(envelope({ error: "counts failed", detail: String(err).slice(0, 200) })); }
});

router.get("/notifications/preferences", requireUser, async (req, res) => {
  try { res.json(envelope({ preferences: await getPreferences(req.authUser!.id) })); }
  catch (err) { res.status(500).json(envelope({ error: "preferences failed", detail: String(err).slice(0, 200) })); }
});

router.post("/notifications/preferences", requireUser, async (req, res) => {
  try {
    const updated = await setPreferences(req.authUser!.id, req.body ?? {});
    res.json(envelope({ preferences: updated, note: "critical_alerts_always_on and safety_alerts_enabled are forced ON." }));
  } catch (err) {
    res.status(400).json(envelope({ error: "preferences update failed", detail: String(err).slice(0, 200) }));
  }
});

router.post("/notifications/demo", requireUser, async (req, res) => {
  try { res.json(envelope({ demo: true, ...(await seedDemo(req.authUser!.id)) })); }
  catch (err) { res.status(500).json(envelope({ error: "demo failed", detail: String(err).slice(0, 200) })); }
});

router.post("/notifications/test-event", requireUser, async (req, res) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const source = String(b.sourceBuild ?? "").toUpperCase();
    const event  = String(b.event ?? "").toUpperCase();
    let inp: NotifyInput | null = null;
    if (source === "HH") inp = ruleGovernorEvaluation({
      governorId: String(b.governorId ?? `gov_test_${Date.now()}`),
      overallStatus: String(b.overallStatus ?? "LOCKED"),
      liveTradingAllowed: Boolean(b.liveTradingAllowed),
      hardBlocks: (b.hardBlocks as Array<{ code: string; severity: string; message: string }>) ?? [{ code: "TEST", severity: "CRITICAL", message: "test block" }],
      metrics: (b.metrics as { dailyPnl?: number; dailyLossLimit?: number }) ?? {},
    });
    else if (source === "DD") inp = ruleMarketData({
      symbol: String(b.symbol ?? "Volatility 75 Index"),
      event: (event || "WIDE_SPREAD") as "STALE_QUOTE"|"WIDE_SPREAD"|"PROVIDER_DEGRADED"|"MISSING_CANDLES"|"EXTREME_VOLATILITY"|"FALLBACK_MODE",
      spread: typeof b.spread === "number" ? b.spread : undefined,
    });
    else if (source === "EE") {
      const eeAlias: Record<string, "OPENED"|"REJECTED"|"DUPLICATE_BLOCKED"|"TP_HIT"|"SL_HIT"|"MANUAL_CLOSE"> = {
        DUPLICATE_PREVENTED: "DUPLICATE_BLOCKED", DUPLICATE_SKIPPED: "DUPLICATE_BLOCKED",
        MANUAL_CLOSED: "MANUAL_CLOSE", CLOSED: "MANUAL_CLOSE",
      };
      const eeEv = (eeAlias[event] ?? (event || "OPENED")) as "OPENED"|"REJECTED"|"DUPLICATE_BLOCKED"|"TP_HIT"|"SL_HIT"|"MANUAL_CLOSE";
      inp = rulePaperExecution({
        paperOrderId: (b.paperOrderId ?? Date.now()) as number,
        event: eeEv,
        symbol: b.symbol as string | undefined,
        pnl: typeof b.pnl === "number" ? b.pnl : null,
      });
    }
    else if (source === "FF") {
      const ffAlias: Record<string, "STARTED"|"STOPPED"|"PAUSED_BY_GOVERNOR"|"COOLDOWN_ACTIVE"|"SAME_SYMBOL_CONFLICT"|"DAILY_LOSS_STOP"> = {
        COOLDOWN_APPLIED: "COOLDOWN_ACTIVE",
        DAILY_LOSS_LIMIT: "DAILY_LOSS_STOP",
        DAILY_PAPER_LOSS_HIT: "DAILY_LOSS_STOP",
      };
      const ffEv = (ffAlias[event] ?? (event || "PAUSED_BY_GOVERNOR")) as "STARTED"|"STOPPED"|"PAUSED_BY_GOVERNOR"|"COOLDOWN_ACTIVE"|"SAME_SYMBOL_CONFLICT"|"DAILY_LOSS_STOP";
      inp = ruleAutopilot({
        cycleId: String(b.cycleId ?? `cyc_test_${Date.now()}`),
        event: ffEv,
        symbol: b.symbol as string | undefined, reason: b.reason as string | undefined,
      });
    }
    else if (source === "BB") inp = ruleDebrief({
      debriefId: (b.debriefId ?? Date.now()) as number,
      event: (event || "CREATED") as "CREATED"|"FAILED"|"DUPLICATE_SKIPPED",
      tradeId: b.tradeId as string | number | undefined,
    });
    else if (source === "CC") inp = ruleLearning({
      learningEventId: (b.learningEventId ?? Date.now()) as number,
      event: (event || "PROCESSED") as "PROCESSED"|"SKIPPED_IDEMPOTENT"|"REPEATED_MISTAKE_RISING",
      tag: b.tag as string | undefined, count: b.count as number | undefined, symbol: b.symbol as string | undefined,
    });
    else if (source === "II") inp = ruleCoach({
      reportId: String(b.reportId ?? `rep_test_${Date.now()}`),
      event: (event || "REPORT_READY") as "REPORT_READY"|"WEEKLY_PLAN_READY"|"PLAYBOOK_UPDATED"|"REPEATED_MISTAKE_COACHING",
    });
    else if (source === "JJ") inp = ruleReplay({
      runId: String(b.runId ?? `rrun_test_${Date.now()}`),
      event: (event || "REPORT_READY") as "REPORT_READY"|"EXPERIMENT_COMPLETE"|"FAILED",
      detail: b.detail as string | undefined,
    });
    else if (source === "KK" && (event === "IMPORT_REJECTED" || event === "IMPORT_PARTIAL" || event === "IMPORT_IMPORTED")) {
      const status = event.replace("IMPORT_", "");
      inp = ruleImport({
        importId: String(b.importId ?? `imp_test_${Date.now()}`),
        status, warnings: (b.warnings as string[]) ?? [], errors: (b.errors as string[]) ?? [],
      });
    } else if (source === "KK") inp = ruleBroker({
      event: (event || "UNSAFE_MODE_REJECTED") as "UNSAFE_MODE_REJECTED"|"SNAPSHOT_CREATED"|"SECRET_EXPOSURE_ATTEMPT"|"READ_ONLY_VERIFIED",
      snapshotId: b.snapshotId as string | undefined,
      brokerModeEnv: b.brokerModeEnv as string | undefined,
      detail: b.detail as string | undefined,
    });
    else if (source === "AA") inp = ruleAADecision({
      decisionId: (b.decisionId ?? Date.now()) as number,
      symbol: b.symbol as string | undefined,
      shouldTrade: Boolean(b.shouldTrade),
      reason: b.reason as string | undefined,
      riskScore: typeof b.riskScore === "number" ? b.riskScore : undefined,
    });
    else if (source === "GG") inp = ruleCommandCenter({
      event: (event || "MAJOR_WARNING") as "MAJOR_WARNING"|"PERF_REBUILD_OK"|"PERF_REBUILD_FAILED",
      detail: b.detail as string | undefined,
    });
    else inp = ruleSystemError({
      source: (source || "LL") as Parameters<typeof ruleSystemError>[0]["source"],
      message: String(b.message ?? "test event"),
      severity: b.severity as "INFO"|"WARNING"|"HIGH"|"CRITICAL"|undefined,
    });

    if (!inp) { res.status(400).json(envelope({ error: "rule did not match — no notification produced" })); return; }
    const result = await notify({ ...inp, userId: req.authUser!.id });
    res.json(envelope({ result }));
  } catch (err) {
    res.status(500).json(envelope({ error: "test-event failed", detail: String(err).slice(0, 200) }));
  }
});

router.post("/notifications/ingest", requireUser, async (req, res) => {
  try {
    const limit = req.body?.limitPerSource ? Number(req.body.limitPerSource) : 50;
    res.json(envelope({ ingest: await ingest({ limitPerSource: limit, userId: req.authUser!.id }) }));
  } catch (err) {
    res.status(500).json(envelope({ error: "ingest failed", detail: String(err).slice(0, 200) }));
  }
});

router.get("/notifications/digest", requireUser, async (_req, res) => {
  try { res.json(envelope({ digest: await latestDigest() })); }
  catch (err) { res.status(500).json(envelope({ error: "digest failed", detail: String(err).slice(0, 200) })); }
});

router.post("/notifications/digest/generate", requireUser, async (req, res) => {
  try {
    const hours = req.body?.rangeHours ? Number(req.body.rangeHours) : 24;
    res.json(envelope({ digest: await generateDigest(hours) }));
  } catch (err) {
    res.status(500).json(envelope({ error: "digest generate failed", detail: String(err).slice(0, 200) }));
  }
});

router.get("/notifications/logs", requireUser, async (req, res) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    res.json(envelope({ logs: await listLogs(limit) }));
  } catch (err) {
    res.status(500).json(envelope({ error: "logs failed", detail: String(err).slice(0, 200) }));
  }
});

router.post("/notifications/mark-all-read", requireUser, async (req, res) => {
  try { res.json(envelope({ updated: await markAllRead(req.authUser!.id) })); }
  catch (err) { res.status(500).json(envelope({ error: "mark-all-read failed", detail: String(err).slice(0, 200) })); }
});

router.get("/notifications/:id", requireUser, async (req, res) => {
  try {
    const row = await getById(req.authUser!.id, String(req.params.id));
    if (!row) { res.status(404).json(envelope({ error: "not found" })); return; }
    res.json(envelope({ notification: row }));
  } catch (err) { res.status(500).json(envelope({ error: "get failed", detail: String(err).slice(0, 200) })); }
});

router.post("/notifications/:id/read", requireUser, async (req, res) => {
  try {
    const row = await markRead(req.authUser!.id, String(req.params.id));
    if (!row) { res.status(404).json(envelope({ error: "not found" })); return; }
    res.json(envelope({ notification: row }));
  } catch (err) { res.status(500).json(envelope({ error: "read failed", detail: String(err).slice(0, 200) })); }
});

router.post("/notifications/:id/acknowledge", requireUser, async (req, res) => {
  try {
    const row = await markAcknowledged(req.authUser!.id, String(req.params.id));
    if (!row) { res.status(404).json(envelope({ error: "not found" })); return; }
    res.json(envelope({ notification: row }));
  } catch (err) { res.status(500).json(envelope({ error: "ack failed", detail: String(err).slice(0, 200) })); }
});

router.post("/notifications/:id/dismiss", requireUser, async (req, res) => {
  try {
    const row = await markDismissed(req.authUser!.id, String(req.params.id));
    if (!row) { res.status(404).json(envelope({ error: "not found" })); return; }
    res.json(envelope({ notification: row }));
  } catch (err) { res.status(500).json(envelope({ error: "dismiss failed", detail: String(err).slice(0, 200) })); }
});

router.post("/notifications/:id/snooze", requireUser, async (req, res) => {
  try {
    const minutes = Number(req.body?.minutes ?? 30);
    const row = await snooze(req.authUser!.id, String(req.params.id), minutes);
    if (!row) { res.status(404).json(envelope({ error: "not found" })); return; }
    res.json(envelope({ notification: row }));
  } catch (err) { res.status(500).json(envelope({ error: "snooze failed", detail: String(err).slice(0, 200) })); }
});

export default router;
