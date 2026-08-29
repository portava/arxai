// Proof for the CI guard `per-user-isolation-scoped-surfaces`.
//
// The guard pins the fix for a cross-user leak on nine non-/me routers: their
// weekly P&L, analytics, mentor briefings, skill level, edge reports,
// onboarding acknowledgements, paper sessions and coach reports were all
// served unscoped, so every trader saw whichever row the planner returned.
//
// A guard nobody has watched fail proves nothing, so this suite drives
// `scanScopedSurfaceSource` with deliberately-broken snippets — the exact
// shapes of the original defects — and asserts each one goes RED, then
// asserts the real tree is GREEN and that coverage has not been quietly
// narrowed.
//
// Run: node --import tsx --test src/__qa__/perUserIsolationScopedSurfaces.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scanScopedSurfaceSource,
  checkPerUserIsolationScopedSurfaces,
  SCOPED_SURFACE_COVERAGE,
} from "../ci/perUserIsolationMeRoutes.js";

const GATES = ["requireUser"] as const;

test("R4 goes RED on the original defect: an unscoped select from a user-owned table", () => {
  const broken = `
    router.get("/skill/profile", requireUser, async (req, res) => {
      const profile = (await db.select().from(traderSkillProfilesTable)
        .orderBy(desc(traderSkillProfilesTable.updatedAt)).limit(1))[0] ?? null;
      ok(res, { profile });
    });
  `;
  const scan = scanScopedSurfaceSource("routes/traderSkill.ts", broken, GATES);
  assert.equal(scan.statementsChecked, 1);
  assert.equal(scan.violations.length, 1);
  assert.match(scan.violations[0]!, /R4-unscoped-user-owned-table/);
  assert.match(scan.violations[0]!, /traderSkillProfilesTable/);
});

test("R4 goes GREEN once the userId predicate is present", () => {
  const fixed = `
    router.get("/skill/profile", requireUser, async (req, res) => {
      const profile = (await db.select().from(traderSkillProfilesTable)
        .where(eq(traderSkillProfilesTable.userId, uid(req)))
        .orderBy(desc(traderSkillProfilesTable.updatedAt)).limit(1))[0] ?? null;
      ok(res, { profile });
    });
  `;
  const scan = scanScopedSurfaceSource("routes/traderSkill.ts", fixed, GATES);
  assert.deepEqual(scan.violations, []);
  assert.equal(scan.statementsChecked, 1);
});

test("R4 sees EACH element of a Promise.all block separately", () => {
  // The exact shape of the defect the first guard could not see. Before the
  // span terminated on a depth-0 comma, ONE scoped element waived every
  // unscoped sibling in the same array, and the guard reported PASS over
  // routes/tradeDecision.ts while it served a stranger's analytics snapshot,
  // skill profile, mentor session and readiness check.
  const broken = `
    router.post("/trade-decision/evaluate", requireUser, async (req, res) => {
      const [snapRows, skillRows, edgeRows] = await Promise.all([
        db.select().from(analyticsSnapshotsTable).orderBy(desc(analyticsSnapshotsTable.createdAt)).limit(1),
        db.select().from(traderSkillProfilesTable).orderBy(desc(traderSkillProfilesTable.updatedAt)).limit(1),
        db.select().from(edgeDiscoveryReportsTable).where(eq(edgeDiscoveryReportsTable.userId, userId)).limit(5),
      ]);
    });
  `;
  const scan = scanScopedSurfaceSource("routes/tradeDecision.ts", broken, GATES);
  assert.equal(scan.statementsChecked, 3);
  assert.equal(
    scan.violations.length, 2,
    `expected the two unscoped elements to be flagged, got: ${scan.violations.join(" | ")}`,
  );
  assert.match(scan.violations.join(" "), /analyticsSnapshotsTable/);
  assert.match(scan.violations.join(" "), /traderSkillProfilesTable/);
  assert.doesNotMatch(scan.violations.join(" "), /edgeDiscoveryReportsTable/);
});

test("R4 does not split a statement on a comma nested inside a predicate", () => {
  // The depth-0 comma terminator must not truncate `and(a, b)` / object
  // literals — otherwise the fix above would manufacture false violations.
  const fixed = `
    const rows = await db.select().from(paperOrdersTable)
      .where(and(
        eq(paperOrdersTable.userId, userId),
        eq(paperOrdersTable.status, "OPEN"),
      ));
    await db.insert(paperOrdersTable).values({
      userId,
      symbol: "EURUSD",
      direction: "BUY",
    });
  `;
  const scan = scanScopedSurfaceSource("lib/paperExecution/paperExecutionService.ts", fixed);
  assert.deepEqual(scan.violations, [], "a nested comma must not truncate the statement span");
  assert.equal(scan.statementsChecked, 2);
});

test("R4 goes RED on the original defect: an insert that leaves user_id NULL", () => {
  const broken = `
    const ins = await db.insert(edgeDiscoveryReportsTable).values({
      edgeName: "symbol=EURUSD",
      sampleSize: 42,
    }).returning();
  `;
  const scan = scanScopedSurfaceSource("routes/edgeDiscovery.ts", broken, GATES);
  assert.equal(scan.violations.length, 1);
  assert.match(scan.violations[0]!, /R4-unscoped-user-owned-table/);
});

test("R4 covers service libs too (no route gates, statements still scoped)", () => {
  const broken = `
    const rs = await db.select().from(riskSettingsTable).orderBy(desc(riskSettingsTable.id)).limit(1);
  `;
  const scan = scanScopedSurfaceSource("lib/riskGovernor/governor.ts", broken);
  assert.equal(scan.handlersChecked, 0, "lib files declare no handlers");
  assert.equal(scan.violations.length, 1);
  assert.match(scan.violations[0]!, /riskSettingsTable/);
});

test("R3 goes RED when a handler loses its auth gate", () => {
  const broken = `
    router.post("/mentor/sessions", async (req, res) => {
      res.json({});
    });
  `;
  const scan = scanScopedSurfaceSource("routes/aiMentor.ts", broken, GATES);
  assert.equal(scan.handlersChecked, 1);
  assert.equal(scan.violations.length, 1);
  assert.match(scan.violations[0]!, /R3-handler-not-gated/);
});

test("R3 goes GREEN with requireUser in the handler declaration", () => {
  const fixed = `
    router.post("/mentor/sessions", requireUser, async (req, res) => {
      res.json({});
    });
  `;
  const scan = scanScopedSurfaceSource("routes/aiMentor.ts", fixed, GATES);
  assert.deepEqual(scan.violations, []);
});

test("R3 accepts the router-level requireAdmin mount used by tester-data", () => {
  const src = `
    router.use("/tester-data", requireAdmin);
    router.post("/tester-data/seed", async (req, res) => { res.json({}); });
  `;
  const withMount = scanScopedSurfaceSource(
    "routes/testerData.ts", src, ["requireAdmin", "ROUTER_LEVEL_REQUIRE_ADMIN"],
  );
  assert.deepEqual(withMount.violations, []);

  // Remove the mount and the very same handler must go RED.
  const withoutMount = scanScopedSurfaceSource(
    "routes/testerData.ts",
    src.replace('router.use("/tester-data", requireAdmin);', ""),
    ["requireAdmin", "ROUTER_LEVEL_REQUIRE_ADMIN"],
  );
  assert.equal(withoutMount.violations.length, 1);
  assert.match(withoutMount.violations[0]!, /R3-handler-not-gated/);
});

test("the isolation-ok waiver requires a written reason", () => {
  const withReason = `
    // isolation-ok: instance-wide health row, carries no trader data
    const rows = await db.select().from(riskSettingsTable).limit(1);
  `;
  assert.deepEqual(scanScopedSurfaceSource("lib/alerts/ruleEngine.ts", withReason).violations, []);

  const bareWaiver = `
    // isolation-ok:
    const rows = await db.select().from(riskSettingsTable).limit(1);
  `;
  assert.equal(
    scanScopedSurfaceSource("lib/alerts/ruleEngine.ts", bareWaiver).violations.length, 1,
    "a waiver with no reason must not silence the guard",
  );
});

test("the real tree passes and coverage has not been narrowed", () => {
  const result = checkPerUserIsolationScopedSurfaces();
  assert.equal(result.ok, true, result.violations.join("\n"));

  // Every router named in the audit finding must stay covered.
  for (const f of [
    "routes/aiMentor.ts", "routes/traderSkill.ts", "routes/edgeDiscovery.ts",
    "routes/weeklyReviews.ts", "routes/analytics.ts", "routes/paperSessions.ts",
    "routes/traderCoach.ts", "routes/security.ts", "routes/onboarding.ts",
    "routes/testerData.ts",
    // Sibling routers that read the same per-trader tables. The first two
    // were the live hole the original coverage list could not see:
    // tradeDecision.ts served a stranger's analytics snapshot / skill profile
    // / mentor session / readiness check through POST
    // /trade-decision/evaluate, and tradingReadiness.ts served a stranger's
    // weekly performance review — while this guard reported PASS.
    "routes/tradeDecision.ts", "routes/tradingReadiness.ts",
    "routes/ruleContracts.ts", "routes/postTradeDebriefs.ts",
    "routes/paperExecution.ts",
  ]) {
    assert.ok(SCOPED_SURFACE_COVERAGE.routeFiles.includes(f), `route file dropped from coverage: ${f}`);
  }
  for (const f of [
    "lib/onboarding/state.ts", "lib/traderCoach/coach.ts", "lib/traderCoach/weekly.ts",
    "lib/paperSession/manager.ts", "lib/riskGovernor/governor.ts", "lib/alerts/ruleEngine.ts",
    "lib/paperExecution/paperExecutionService.ts", "lib/paperAutopilot/autopilotService.ts",
  ]) {
    assert.ok(SCOPED_SURFACE_COVERAGE.libFiles.includes(f), `service file dropped from coverage: ${f}`);
  }

  // Statements are actually being inspected — a silently-empty scan must never
  // read as a green isolation proof.
  const stmts = Number(/(\d+) user-owned-table statement/.exec(result.notes?.[0] ?? "")?.[1] ?? 0);
  assert.ok(stmts >= 100, `expected the scan to inspect many statements, saw ${stmts}`);
});
