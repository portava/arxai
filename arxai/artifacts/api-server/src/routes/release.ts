// Build UU — Beta release endpoints: version, readiness gates, feedback
// tracker, diagnostics export. Read-only diagnostics + feedback CRUD only.
// NEVER places trades, NEVER changes mt5/canPlaceTrades flags, NEVER returns
// secrets.

import { Router } from "express";
import { randomUUID } from "node:crypto";
import { db, feedbackTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { requireRole, getSessionFromReq } from "../lib/security/session.js";
import { auditEvent } from "../lib/systemHealth/audit.js";
import { versionEnvelope, readinessReport, diagnosticsPackage, listFeedback } from "../lib/release.js";
import { runAcceptance, getLastAcceptance, setLastAcceptance } from "../lib/acceptance.js";

const router = Router();

router.get("/release/version", (_req, res) => {
  res.json(versionEnvelope());
});

router.get("/release/readiness", async (_req, res) => {
  res.json(await readinessReport());
});

router.post("/release/acceptance-run", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const result = await runAcceptance();
  setLastAcceptance(result);
  const s = getSessionFromReq(req);
  await auditEvent({
    eventType: "ACCEPTANCE_RUN", severity: "INFO", actor: "USER",
    action: `acceptance run: ${result.summary.passed}/${result.summary.total} pass`,
    sourceService: "release",
    metadata: { passed: result.summary.passed, failed: result.summary.failed, needsReview: result.summary.needsReview, role: s.role },
    ipAddress: req.ip ?? null,
  }).catch(() => {});
  res.json(result);
});

router.get("/release/acceptance-last", (_req, res) => {
  res.json(getLastAcceptance() ?? { scenarios: [], summary: null });
});

router.get("/release/notes", (_req, res) => {
  res.json({
    brand: {
      name: "ARX AI",
      shortName: "ARX",
      tagline: "Analyze. Risk. eXecute.",
      lockup: "ARX AI — The AI trading fortress built for disciplined decisions.",
      meaning: {
        analyze: "AI scans charts, sessions, news risk, market structure, strategy fit, price action, trade quality, and confidence.",
        risk: "Risk Governor protects the account through stop-loss enforcement, drawdown limits, max loss rules, overtrading detection, exposure control, and kill switch.",
        execute: "ARX turns qualified decisions into manual trades, AI-assisted trades, simulator trades, live tester intents, and future MT5 execution.",
      },
      ownerTesterAccess: true,
      mt5Deferred: true,
      simulatorReady: true,
      realBrokerExecutionLocked: true,
    },
    version: versionEnvelope().version,
    stage: "BETA_TESTER",
    worksNow: [
      "Full tester access",
      "Simulator trading",
      "AI scanner",
      "AI autopilot simulator",
      "Live tester intents",
      "Shadow testing",
      "Strategy testing",
      "Risk governor",
      "OMS",
      "Journal / Calendar",
      "Live chart",
    ],
    deferred: [
      "Real MT5 broker execution",
      "Real MT5 account sync",
      "Real MT5 live positions",
      "Real broker fills",
    ],
    knownIssues: [],
    testingInstructions: [
      "Run /qa-checklist before each tester session.",
      "Use /test-session-recorder to capture a session.",
      "Open Report Issue from any page (top-right) to file bugs.",
    ],
    nextMilestone: "RELEASE_CANDIDATE — requires MT5 bridge connected and 0 P0 bugs.",
  });
});

router.get("/export/diagnostics", requireRole("OWNER", "ADMIN", "TESTER"), async (req, res) => {
  const s = getSessionFromReq(req);
  await auditEvent({
    eventType: "EXPORT_GENERATED", severity: "INFO", actor: "USER",
    action: "export diagnostics", sourceService: "release",
    metadata: { kind: "diagnostics", role: s.role, sessionId: s.sid }, ipAddress: req.ip ?? null,
  }).catch(() => {});
  res.json(await diagnosticsPackage());
});

const FeedbackInput = z.object({
  title: z.string().min(2).max(200),
  category: z.enum(["BUG", "FEATURE", "UI", "TRADING", "CHART", "AI", "RISK", "JOURNAL", "MOBILE", "MT5", "OTHER"]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
  route: z.string().max(500).optional(),
  whatHappened: z.string().min(2).max(5000),
  whatExpected: z.string().max(5000).optional(),
  stepsToReproduce: z.string().max(5000).optional(),
  currentMode: z.string().max(100).optional(),
  mt5Status: z.string().max(100).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

const SECRET_RE = /(api[_-]?key|secret|token|password|bearer|mt5[_-]?bridge[_-]?token)/i;
function scrub<T>(v: T): T {
  const json = JSON.stringify(v, (k, val) => (typeof k === "string" && SECRET_RE.test(k)) ? "[REDACTED]" : val);
  return JSON.parse(json) as T;
}

router.post("/feedback", requireRole("OWNER", "ADMIN", "TESTER"), async (req, res) => {
  const s = getSessionFromReq(req);
  const parsed = FeedbackInput.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "invalid", details: parsed.error.issues }); return; }
  const data = scrub(parsed.data);
  const sevToPriority: Record<string, string> = { critical: "P0", high: "P1", medium: "P2", low: "P3" };
  const feedbackId = `fb_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  await db.insert(feedbackTable).values({
    feedbackId,
    title: data.title,
    category: data.category,
    severity: data.severity,
    priority: data.priority ?? sevToPriority[data.severity] ?? "P2",
    route: data.route ?? null,
    whatHappened: data.whatHappened,
    whatExpected: data.whatExpected ?? null,
    stepsToReproduce: data.stepsToReproduce ?? null,
    reporterRole: s.role,
    currentMode: data.currentMode ?? null,
    mt5Status: data.mt5Status ?? "deferred",
    context: scrub(data.context ?? {}),
  });
  await auditEvent({
    eventType: "FEEDBACK_SUBMITTED", severity: "INFO", actor: "USER",
    action: `feedback submitted: ${data.category}/${data.severity}`, sourceService: "release",
    metadata: { feedbackId, role: s.role, route: data.route }, ipAddress: req.ip ?? null,
  }).catch(() => {});
  res.json({ ok: true, feedbackId });
});

router.get("/feedback", requireRole("OWNER", "ADMIN", "TESTER"), async (req, res) => {
  const status = typeof req.query["status"] === "string" ? req.query["status"] : undefined;
  res.json({ items: await listFeedback({ status, limit: 500 }) });
});

const FeedbackPatch = z.object({
  status: z.enum(["NEW", "TRIAGED", "IN_PROGRESS", "FIXED", "NEEDS_RETEST", "CLOSED", "WONT_FIX"]).optional(),
  priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
  notes: z.string().max(5000).optional(),
});

router.patch("/feedback/:feedbackId", requireRole("OWNER", "ADMIN"), async (req, res) => {
  const id = String(req.params["feedbackId"] ?? "");
  const parsed = FeedbackPatch.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "invalid", details: parsed.error.issues }); return; }
  const fields: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed.data.status) fields["status"] = parsed.data.status;
  if (parsed.data.priority) fields["priority"] = parsed.data.priority;
  if (parsed.data.notes !== undefined) fields["notes"] = parsed.data.notes;
  const rows = await db.update(feedbackTable).set(fields).where(eq(feedbackTable.feedbackId, id)).returning();
  if (rows.length === 0) { res.status(404).json({ error: "not_found" }); return; }
  const s = getSessionFromReq(req);
  await auditEvent({
    eventType: "FEEDBACK_UPDATED", severity: "INFO", actor: "USER",
    action: `feedback updated ${id}`, sourceService: "release",
    metadata: { feedbackId: id, by: s.role, fields: Object.keys(fields) }, ipAddress: req.ip ?? null,
  }).catch(() => {});
  res.json({ ok: true, item: rows[0] });
});

export default router;
