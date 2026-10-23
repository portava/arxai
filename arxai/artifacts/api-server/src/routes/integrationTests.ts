// Build OO — Integration test runner routes. NN-protected. PAPER_ONLY.
import { Router, type IRouter } from "express";
import { readRoleFromRequest } from "../lib/security/middleware.js";

import { db } from "@workspace/db";
import { integrationTestRunsTable, integrationTestResultsTable } from "@workspace/db/schema";
import { desc, eq } from "drizzle-orm";
import { runTestGroups, TEST_GROUPS, type TestGroup } from "../lib/readiness/runner.js";
import { checkPermission } from "../lib/security/permissions.js";
import { recordSecurityEvent } from "../lib/security/events.js";
import { scrub } from "../lib/security/redact.js";

const router: IRouter = Router();

const DISCLAIMER = "Build OO — Integration test runner. Read-only. Never places trades, never enables live trading.";

function envelope(payload: Record<string, unknown>) {
  return {
    system: "integration-tests",
    appMode: "PAPER_ONLY" as const,
    liveTradingStatus: "DISABLED" as const,
    mode: "PAPER_ONLY" as const,
    canPlaceLiveTrade: false as const,
    canProceedToLiveTrading: false as const,
    disclaimer: DISCLAIMER,
    ...payload,
  };
}

router.post("/integration-tests/run", async (req, res) => {
  const role = readRoleFromRequest(req);
  const decision = await checkPermission(role, "admin:health_check");
  if (!decision.allowed) {
    await recordSecurityEvent({ eventType: "PERMISSION_DENIED", severity: "WARNING", actorRole: role, permissionKey: "admin:health_check", route: "/api/integration-tests/run", status: "DENIED", message: `DENIED — ${role} cannot run integration tests` });
    res.status(403).json(envelope({ result: { status: "REJECTED" } }));
    return;
  }
  const requested = Array.isArray(req.body?.groups) ? req.body.groups : null;
  const groups = (requested ?? TEST_GROUPS).filter((g: string): g is TestGroup => (TEST_GROUPS as readonly string[]).includes(g));
  if (groups.length === 0) { res.status(400).json(envelope({ error: "No valid groups provided" })); return; }
  const result = await runTestGroups(groups);
  res.json(envelope({ run: scrub(result) }));
});

router.get("/integration-tests/runs", async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10) || 20, 100);
  const rows = await db.select().from(integrationTestRunsTable).orderBy(desc(integrationTestRunsTable.createdAt)).limit(limit);
  res.json(envelope({ count: rows.length, runs: rows }));
});

router.get("/integration-tests/runs/:id", async (req, res) => {
  const rows = await db.select().from(integrationTestRunsTable).where(eq(integrationTestRunsTable.testRunId, req.params.id)).limit(1);
  if (rows.length === 0) { res.status(404).json(envelope({ error: "run not found" })); return; }
  res.json(envelope({ run: rows[0] }));
});

router.get("/integration-tests/runs/:id/results", async (req, res) => {
  const rows = await db.select().from(integrationTestResultsTable).where(eq(integrationTestResultsTable.testRunId, req.params.id));
  res.json(envelope({ count: rows.length, results: scrub(rows) }));
});

router.get("/integration-tests/groups", async (_req, res) => {
  res.json(envelope({ groups: TEST_GROUPS }));
});

router.post("/integration-tests/demo", async (_req, res) => {
  const result = await runTestGroups(["safety", "security", "data_protection"]);
  res.json(envelope({ demoRun: { runId: result.runId, counts: result.counts, sample: result.results.slice(0, 3) } }));
});

export default router;
