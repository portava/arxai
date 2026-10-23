// ═══════════════════════════════════════════════════════════════════════════
// /api/audit/* — read-only HTTP surface for the SHADOW event-sourced vault.
//
// These endpoints never mutate trading state, never call into Risk Governor /
// Control Tower, and do not affect main app behavior.
//
// /audit/integrity additionally emits a VAULT_CORRUPTION_ALERT row into the
// Phase 1/2 vault_events log when critical flags are found — record-only,
// does NOT change executionPermission or governor state.
//
// /audit/_debug/* endpoints are test-only (404 in NODE_ENV=production):
//   - POST /audit/_debug/force-fail   { n }      — simulate storage outage
//   - POST /audit/_debug/capture     { draft }  — exercise the guard pipeline
// ═══════════════════════════════════════════════════════════════════════════

import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { eventSourced as ev } from "@workspace/domain/black-box-vault";
import { db, vaultEventsTable } from "@workspace/db";
import {
  listAllAuditEvents,
  isAuditStorageAvailable,
  auditPorts,
  VAULT_MODE,
  isVaultDegraded,
  getVaultPendingCount,
  getConsecutiveFailures,
  forceFailNextWrites,
  shadowCapture,
  findAuditEventById,
} from "../lib/auditVault.js";

const router: IRouter = Router();

const QuerySchema = z.object({
  sinceIso: z.string().optional(),
  untilIso: z.string().optional(),
  symbol: z.string().optional(),
  source: z.string().optional(),
  severity: z.enum(["INFO", "WARN", "DANGER", "CRITICAL"]).optional(),
  systemMode: z.string().optional(),
  globalState: z.string().optional(),
  strategy: z.string().optional(),
  tradeId: z.string().optional(),
  eventType: z.string().optional(),
  freeText: z.string().optional(),
  trainingEligible: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});

function isProd() { return process.env.NODE_ENV === "production"; }

function trainingEligibleOf(e: ev.AuditEvent): boolean | null {
  // Prefer the top-level field (canonical); fall back to legacy nested
  // `_quality.trainingEligible` for events written before the field existed.
  if (typeof e.trainingEligible === "boolean") return e.trainingEligible;
  const q = (e.payload as { _quality?: { trainingEligible?: unknown } } | undefined)?._quality;
  return typeof q?.trainingEligible === "boolean" ? q.trainingEligible : null;
}

// GET /api/audit/health
router.get("/audit/health", async (_req, res) => {
  const storageOk = await isAuditStorageAvailable();
  res.json({
    mode: VAULT_MODE,
    storageOk,
    degraded: isVaultDegraded(),
    pendingCount: getVaultPendingCount(),
    consecutiveFailures: getConsecutiveFailures(),
  });
});

// GET /api/audit/events?...filters
router.get("/audit/events", async (req, res) => {
  try {
    const q = QuerySchema.parse(req.query);
    const all = await listAllAuditEvents(2000);
    let filtered = ev.queryAuditEvents(all, q);
    if (q.trainingEligible) {
      const wantTrue = q.trainingEligible === "true";
      filtered = filtered.filter((e) => trainingEligibleOf(e) === wantTrue);
    }
    res.json({ count: filtered.length, events: filtered });
  } catch (err) {
    req.log.warn({ err }, "audit events query failed");
    res.status(400).json({ error: "invalid audit query" });
  }
});

// GET /api/audit/integrity
router.get("/audit/integrity", async (req, res) => {
  const all = await listAllAuditEvents(5000);
  const report = ev.scanIntegrity(all, auditPorts.hash, auditPorts.clock);
  if (report.criticalCount > 0) {
    try {
      await db.insert(vaultEventsTable).values({
        kind: "VAULT_CORRUPTION_ALERT",
        severity: "CRITICAL",
        source: "VAULT",
        truthDomain: "AUDIT",
        operationalMode: null,
        globalState: null,
        symbol: null,
        summary: `audit vault integrity scan flagged ${report.criticalCount} critical issue(s)`,
        reasons: Object.entries(report.byCategory)
          .filter(([, n]) => n > 0)
          .map(([cat, n]) => `${cat}: ${n}`),
        blockers: [],
        payload: { byCategory: report.byCategory, sampleFlags: report.flags.slice(0, 10) },
        linkedTradeId: null,
        linkedSignalId: null,
        linkedDecisionId: null,
        generatedAtIso: new Date().toISOString(),
      });
    } catch (err) {
      req.log.warn({ err }, "failed to record VAULT_CORRUPTION_ALERT (non-fatal)");
    }
  }
  res.json(report);
});

// GET /api/audit/snapshot
router.get("/audit/snapshot", async (_req, res) => {
  const all = await listAllAuditEvents(5000);
  res.json(ev.buildSnapshot(all));
});

// GET /api/audit/replay/:eventId
router.get("/audit/replay/:eventId", async (req, res) => {
  const all = await listAllAuditEvents(5000);
  const result = ev.replayUpTo(all, req.params.eventId);
  if (!result.found) {
    res.status(404).json({ error: "event id not found", target: result.target });
    return;
  }
  res.json(result);
});

// GET /api/audit/retention
router.get("/audit/retention", async (_req, res) => {
  const all = await listAllAuditEvents(5000);
  res.json(ev.classifyRetention(all, auditPorts.clock()));
});

// POST /api/audit/correction — emit a VAULT_CORRECTION event that points to a
// previously written event. Events themselves are immutable; corrections are
// appended as new events. The vault still cannot mutate trading state — it
// only records the correction.
const CorrectionSchema = z.object({
  correctsEventId: z.string().min(1),
  reason: z.string().min(1).max(2000),
  source: z.string().min(1).default("OPERATOR"),
  severity: z.enum(["INFO", "WARN", "DANGER", "CRITICAL"]).default("WARN"),
  payload: z.record(z.string(), z.unknown()).optional(),
});
router.post("/audit/correction", async (req, res) => {
  try {
    const body = CorrectionSchema.parse(req.body);
    // Verify the corrected event exists via an indexed point-lookup so the
    // check stays correct as the vault grows past any bounded list window.
    const original = await findAuditEventById(body.correctsEventId);
    if (!original) {
      res.status(404).json({ error: "correctsEventId not found in audit vault", correctsEventId: body.correctsEventId });
      return;
    }
    const result = await shadowCapture({
      eventType: "VAULT_CORRECTION",
      source: body.source,
      severity: body.severity,
      systemMode: null,
      globalState: null,
      payload: { correctsEventId: body.correctsEventId, reason: body.reason, ...(body.payload ?? {}) },
    });
    res.json({ ok: result.ok, event: result.event, error: result.error ?? null });
  } catch (err) {
    req.log.warn({ err }, "audit correction failed");
    res.status(400).json({ error: "invalid correction request", detail: String(err) });
  }
});

// POST /api/audit/_debug/force-fail
router.post("/audit/_debug/force-fail", (req, res) => {
  if (isProd()) { res.status(404).json({ error: "not found" }); return; }
  const n = Number((req.body as { n?: unknown } | undefined)?.n ?? 0);
  if (!Number.isFinite(n) || n < 0 || n > 1000) {
    res.status(400).json({ error: "n must be a non-negative integer <= 1000" });
    return;
  }
  forceFailNextWrites(n);
  res.json({ ok: true, forceFailRemaining: n });
});

// POST /api/audit/_debug/capture — exercise the guard pipeline directly
const DebugCaptureSchema = z.object({
  eventType: z.string().min(1),
  source: z.string().min(1),
  severity: z.enum(["INFO", "WARN", "DANGER", "CRITICAL"]),
  systemMode: z.string().nullable().optional(),
  globalState: z.string().nullable().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  timestamp: z.string().optional(),
});
router.post("/audit/_debug/capture", async (req, res) => {
  if (isProd()) { res.status(404).json({ error: "not found" }); return; }
  try {
    const draft = DebugCaptureSchema.parse(req.body);
    const result = await shadowCapture({
      ...draft,
      systemMode: draft.systemMode ?? null,
      globalState: draft.globalState ?? null,
    });
    res.json({ ok: result.ok, event: result.event, error: result.error ?? null });
  } catch (err) {
    res.status(400).json({ error: "invalid debug capture body", detail: String(err) });
  }
});

export default router;
