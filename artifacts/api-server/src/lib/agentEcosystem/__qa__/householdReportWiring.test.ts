// Agent Ecosystem — Layer 4: Household Report generator integration test.
// Run via:
//   node --import tsx --test src/lib/agentEcosystem/__qa__/householdReportWiring.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:agent-household-report`)
//
// Proves the persisted daily Household Report end-to-end (what pure-engine tests
// cannot): a generate aggregates the REAL registry into the §17 sections, writes
// a row, upserts (one per UTC day, never a duplicate), exposes a list + by-id
// read, and produces a plain-English Eleanor summary that leaks NO internal agent
// codes / table / route / JSON-field names.
//
// SAFETY / SCOPE: OBSERVATION ONLY — nothing here trades or touches the 16-gate
// path. Hits the real dev DB; the throwaway agent uses a TEST_ prefix and is
// cleaned up fail-closed (aborts if the scope looks wrong).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  db, agentsTable, agentHouseholdReportsTable, agentLearningCampRecordsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  generateHouseholdReport, listHouseholdReports, getHouseholdReport,
  buildHouseholdReportBody, buildEleanorSummary,
} from "../householdReport.js";

const TEST_KEY = `TEST_HHR_${randomUUID().slice(0, 8)}`;

async function cleanup(agentId: number, reportDate: string) {
  if (agentId > 0 && TEST_KEY.startsWith("TEST_HHR_")) {
    await db.delete(agentLearningCampRecordsTable).where(eq(agentLearningCampRecordsTable.agentId, agentId));
    await db.delete(agentsTable).where(eq(agentsTable.id, agentId));
    // Only remove the report row this test generated (today's date is shared, but
    // we keep it — generate is an idempotent upsert and the row is real evidence).
    // Intentionally NOT deleting the report row: it is a legitimate daily report.
    void reportDate;
  } else {
    throw new Error("ABORT: refusing cleanup — unexpected test scope");
  }
}

test("generate aggregates real registry, upserts one row/day, exposes list+by-id, Eleanor summary is clean", async () => {
  const [agent] = await db.insert(agentsTable).values({
    agentKey: TEST_KEY, name: "Test Household Agent", role: "TEST",
    department: "TEST", missionStatement: "test", currentStatus: "ACTIVE",
    currentRank: "JUNIOR", currentMode: "SHADOW", authorityWeight: 0,
    liveInfluenceAllowed: false, isCore: false,
  }).returning({ id: agentsTable.id });
  const agentId = agent!.id;
  let reportDate = "";

  try {
    // ── Regression guard: a camp that ended TODAY with a terminal RETURNED_*
    // status must surface in the "learning-camp out" section. The terminal
    // vocabulary is RETURNED_FULL / RETURNED_SUPERVISED — a filter on a bare
    // "RETURNED" silently drops every exit, so assert the real status surfaces.
    await db.insert(agentLearningCampRecordsTable).values({
      recordId: randomUUID(), agentId, reason: "test camp exit",
      stage: "FULL_RETURN", returnStatus: "RETURNED_FULL", correctionRules: "[]",
      endedAt: new Date(),
    });

    // ── Body builder reflects the real registry (our test agent is counted) ────
    const body = await buildHouseholdReportBody();
    reportDate = body.reportDate;
    assert.ok(body.totals.totalAgents >= 1, "at least our test agent is counted");
    assert.match(body.reportDate, /^\d{4}-\d{2}-\d{2}$/, "report date is YYYY-MM-DD");
    assert.ok(Array.isArray(body.promotions), "promotions section present");
    assert.ok(Array.isArray(body.badTradesBlocked), "surface findings present (best-effort, may be empty)");
    assert.ok(
      body.learningCampOut.some((x) => x.agentName === "Test Household Agent" && x.returnStatus === "RETURNED_FULL"),
      "a camp that ended today with RETURNED_FULL surfaces in learning-camp out",
    );

    // ── Generate persists a row ────────────────────────────────────────────────
    const r1 = await generateHouseholdReport({ generatedByUserId: 1 });
    assert.equal(r1.reportDate, reportDate, "stored row carries today's date");
    assert.ok(r1.reportId.length > 0, "report has a uuid");
    assert.ok(r1.eleanorSummary.length > 0, "eleanor summary generated");

    // ── Idempotent upsert: a second generate updates the SAME row (one/day) ─────
    const r2 = await generateHouseholdReport({ generatedByUserId: 1 });
    assert.equal(r2.reportId, r1.reportId, "same report id — upserted, not duplicated");
    const sameDay = await db.select().from(agentHouseholdReportsTable)
      .where(eq(agentHouseholdReportsTable.reportDate, reportDate));
    assert.equal(sameDay.length, 1, "exactly one report row for the day");

    // ── List + by-id reads ─────────────────────────────────────────────────────
    const list = await listHouseholdReports({ limit: 10 });
    assert.ok(list.some((x) => x.reportId === r1.reportId), "report appears in the list");

    const byId = await getHouseholdReport(r1.reportId);
    assert.ok(byId, "by-id read returns the report");
    assert.ok(byId!.body, "by-id read expands the structured body");
    assert.equal(byId!.body!.totals.totalAgents, body.totals.totalAgents, "body totals round-trip");

    // ── Search by date narrows the list ────────────────────────────────────────
    const searched = await listHouseholdReports({ search: reportDate, limit: 10 });
    assert.ok(searched.some((x) => x.reportId === r1.reportId), "date search finds the report");

    // ── Eleanor summary leaks NO internal codes / table / route / field names ──────
    const eleanor = buildEleanorSummary(body).toLowerCase();
    for (const forbidden of [
      "agentkey", "authorityweight", "currentstatus", "currentmode",
      "agent_household_reports", "/api/", "shadow mode", "learning_camp",
      "governancescore", "advisoryscore", "16-gate", "trustscore",
    ]) {
      assert.ok(!eleanor.includes(forbidden), `eleanor summary must not leak internal token "${forbidden}"`);
    }
    assert.ok(eleanor.includes("trading team") || eleanor.includes("desk") || eleanor.includes("specialist"),
      "eleanor summary speaks in plain team language");
    assert.ok(eleanor.includes("decision support") || eleanor.includes("nothing here places"),
      "eleanor summary carries the advisory-only disclaimer");
  } finally {
    await cleanup(agentId, reportDate);
  }
});
