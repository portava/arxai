// Build WW — Daily Owner Testing Mode endpoints.
//
// SAFETY: All endpoints read or append-only mutate the in-memory daily
// testing store. NEVER places trades, NEVER touches MT5/broker state,
// NEVER returns secrets. Owner/admin/tester gated where mutating; reads
// are open to authenticated session.

import { Router } from "express";
import { z } from "zod/v4";
import { requireRole, getSessionFromReq } from "../lib/security/session.js";
import { auditEvent } from "../lib/systemHealth/audit.js";
import {
  startSession, recordStep, completeSession, recordRating,
  getActive, getSession, listSessionsAll, dailyPerformanceReview,
  weeklySummary, readinessTrend, exportDailyReport, exportWeeklyReport,
  STEPS,
} from "../lib/dailyTesting.js";

const router = Router();

router.get("/daily-testing/status", requireRole("OWNER", "ADMIN", "TESTER"), (_req, res) => {
  const active = getActive();
  res.json({
    active,
    stepTemplate: STEPS,
    lastSession: listSessionsAll(1)[0] ?? null,
    mt5Deferred: true,
    realBrokerExecutionAvailable: false,
    note: "Daily testing mode — simulator + tester intents only. MT5 deferred.",
  });
});

router.post("/daily-testing/start", requireRole("OWNER", "ADMIN", "TESTER"), async (req, res) => {
  const Body = z.object({ deviceType: z.enum(["desktop", "mobile", "tablet"]).optional() });
  const parsed = Body.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "invalid", issues: parsed.error.issues }); return; }
  const s = getSessionFromReq(req);
  const created = startSession({ userRole: s.role, deviceType: parsed.data.deviceType });
  await auditEvent({
    eventType: "DAILY_TEST_SESSION_START", severity: "INFO", actor: "USER",
    action: `daily test session ${created.sessionId} started by ${s.role}`,
    sourceService: "dailyTesting",
    metadata: { sessionId: created.sessionId, role: s.role, device: created.deviceType },
    ipAddress: req.ip ?? null,
  }).catch(() => {});
  res.json(created);
});

router.post("/daily-testing/step", requireRole("OWNER", "ADMIN", "TESTER"), async (req, res) => {
  const Body = z.object({
    sessionId: z.string().min(1),
    stepId: z.string().min(1),
    status: z.enum(["PENDING", "PASS", "FAIL", "NEEDS_REVIEW", "SKIPPED"]),
    notes: z.string().max(2000).optional(),
    evidence: z.record(z.string(), z.unknown()).optional(),
  });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "invalid", issues: parsed.error.issues }); return; }
  const out = recordStep(parsed.data);
  if ("error" in out) { res.status(404).json(out); return; }
  res.json(out);
});

router.post("/daily-testing/complete", requireRole("OWNER", "ADMIN", "TESTER"), async (req, res) => {
  const Body = z.object({ sessionId: z.string().min(1), notes: z.string().max(5000).optional() });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "invalid", issues: parsed.error.issues }); return; }
  const out = await completeSession(parsed.data.sessionId, parsed.data.notes ?? "");
  if ("error" in out) { res.status(404).json(out); return; }
  const s = getSessionFromReq(req);
  await auditEvent({
    eventType: "DAILY_TEST_SESSION_COMPLETE", severity: "INFO", actor: "USER",
    action: `daily test session ${out.sessionId} completed (${out.status})`,
    sourceService: "dailyTesting",
    metadata: {
      sessionId: out.sessionId, status: out.status, role: s.role,
      stepsPass: out.steps.filter((x) => x.status === "PASS").length,
      stepsFail: out.steps.filter((x) => x.status === "FAIL").length,
      readinessSnapshot: out.readinessSnapshot,
    },
    ipAddress: req.ip ?? null,
  }).catch(() => {});
  res.json(out);
});

router.get("/daily-testing/sessions", requireRole("OWNER", "ADMIN", "TESTER"), async (req, res) => {
  const limit = Math.min(Number(req.query["limit"] ?? 50) || 50, 200);
  const sess = getSessionFromReq(req);
  await auditEvent({
    eventType: "DAILY_TEST_SESSIONS_LIST", severity: "INFO", actor: "USER",
    action: `daily test sessions list (limit=${limit})`,
    sourceService: "dailyTesting",
    metadata: { limit, role: sess.role }, ipAddress: req.ip ?? null,
  }).catch(() => {});
  res.json({ sessions: listSessionsAll(limit) });
});

router.get("/daily-testing/session/:sessionId", requireRole("OWNER", "ADMIN", "TESTER"), async (req, res) => {
  const id = String(req.params["sessionId"] ?? "");
  const s = getSession(id);
  if (!s) { res.status(404).json({ error: "not_found" }); return; }
  const sess = getSessionFromReq(req);
  await auditEvent({
    eventType: "DAILY_TEST_SESSION_VIEW", severity: "INFO", actor: "USER",
    action: `daily test session ${id} viewed`, sourceService: "dailyTesting",
    metadata: { sessionId: id, role: sess.role }, ipAddress: req.ip ?? null,
  }).catch(() => {});
  res.json(s);
});

router.get("/daily-performance-review", requireRole("OWNER", "ADMIN", "TESTER"), async (req, res) => {
  const date = String(req.query["date"] ?? "");
  const out = await dailyPerformanceReview(date || undefined);
  const sess = getSessionFromReq(req);
  await auditEvent({
    eventType: "DAILY_PERFORMANCE_REVIEW_VIEW", severity: "INFO", actor: "USER",
    action: `daily performance review viewed (${date || "today"})`,
    sourceService: "dailyTesting",
    metadata: { date: date || "today", role: sess.role }, ipAddress: req.ip ?? null,
  }).catch(() => {});
  res.json(out);
});

router.post("/daily-performance-review/rating", requireRole("OWNER", "ADMIN", "TESTER"), async (req, res) => {
  const Body = z.object({
    sessionId: z.string().min(1),
    appUsability: z.number().min(1).max(10),
    aiTradeQuality: z.number().min(1).max(10),
    riskControlClarity: z.number().min(1).max(10),
    speedPerformance: z.number().min(1).max(10),
    mobileExperience: z.number().min(1).max(10),
    overallConfidence: z.number().min(1).max(10),
    feltBroken: z.string().max(2000).default(""),
    feltConfusing: z.string().max(2000).default(""),
    feltImpressive: z.string().max(2000).default(""),
    shouldImprove: z.string().max(2000).default(""),
  });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "invalid", issues: parsed.error.issues }); return; }
  const { sessionId, ...rating } = parsed.data;
  const out = recordRating(sessionId, rating);
  if ("error" in out) { res.status(404).json(out); return; }
  const s = getSessionFromReq(req);
  await auditEvent({
    eventType: "DAILY_TEST_RATING", severity: "INFO", actor: "USER",
    action: `owner rating recorded for ${sessionId} (overall=${rating.overallConfidence}/10)`,
    sourceService: "dailyTesting",
    metadata: { sessionId, role: s.role, overall: rating.overallConfidence },
    ipAddress: req.ip ?? null,
  }).catch(() => {});
  res.json(out);
});

router.get("/weekly-testing-summary", requireRole("OWNER", "ADMIN", "TESTER"), async (req, res) => {
  const sess = getSessionFromReq(req);
  await auditEvent({
    eventType: "WEEKLY_TESTING_SUMMARY_VIEW", severity: "INFO", actor: "USER",
    action: "weekly testing summary viewed", sourceService: "dailyTesting",
    metadata: { role: sess.role }, ipAddress: req.ip ?? null,
  }).catch(() => {});
  res.json(await weeklySummary());
});

router.get("/readiness/trend", requireRole("OWNER", "ADMIN", "TESTER"), async (_req, res) => {
  // Polled frequently — role-gated but not audit-logged to avoid log spam.
  res.json(await readinessTrend());
});

router.get("/export/daily-testing-report", requireRole("OWNER", "ADMIN", "TESTER"), async (req, res) => {
  const sessionId = req.query["sessionId"] ? String(req.query["sessionId"]) : undefined;
  const out = await exportDailyReport(sessionId);
  await auditEvent({
    eventType: "EXPORT_GENERATED", severity: "INFO", actor: "USER",
    action: "export daily testing report", sourceService: "dailyTesting",
    metadata: { kind: "daily-testing", sessionId: sessionId ?? "(latest)" },
    ipAddress: req.ip ?? null,
  }).catch(() => {});
  res.json(out);
});

router.get("/export/weekly-testing-report", requireRole("OWNER", "ADMIN", "TESTER"), async (req, res) => {
  const out = await exportWeeklyReport();
  await auditEvent({
    eventType: "EXPORT_GENERATED", severity: "INFO", actor: "USER",
    action: "export weekly testing report", sourceService: "dailyTesting",
    metadata: { kind: "weekly-testing" },
    ipAddress: req.ip ?? null,
  }).catch(() => {});
  res.json(out);
});

export default router;
