// fix/demo-ladder — OFFLINE structural guards for the simulated/real boundary.
//
// WHY THIS FILE EXISTS: the branch's runtime proof (missionDemoLadder.test.ts)
// is DB-backed, so on a machine without a DATABASE_URL the only thing standing
// between a rename and a production 42703 is a human reading two files. These
// checks are pure text/AST-free reads of the repo — no DB, no network, no clock
// — so they run in the offline `ci` lane and fail loudly the moment the schema,
// the pending SQL and the readers drift apart.
//
// What these lock:
//   * SCHEMA ↔ SQL RECONCILIATION. Every column the pending migration adds is
//     mapped by the Drizzle table under exactly that snake_case name, and every
//     sim_* column the Drizzle table maps is added by the migration. A rename on
//     one side without the other is what would take the money path down at
//     runtime, and the DB suite that would have caught it has never run here.
//   * THE DEPLOY-ORDER CONSTRAINT IS DOCUMENTED. The `simulated = false`
//     predicates were added to EXISTING realised-money readers, so the code is
//     not deployable ahead of the SQL. That is a hard ordering constraint, not
//     housekeeping, and the migration file must keep saying so.
//   * NO STARVATION OF LIVE EXIT MANAGEMENT. The driver's capped open-position
//     read must exclude simulated rows: a simulated draft is `executed` with
//     `closed_at` NULL FOREVER by design, and a promoted mission carries at
//     least MIN_DEMO_SAMPLE of them — four times the per-tick cap.
//   * NO SIMULATED VALUE SURVIVES A BASIS CHANGE. The execution-mode service
//     must rebase `currentValue` when the accounting basis flips, because
//     missionDrafts sizes real positions from `mission.currentValue`.
//
// Run: pnpm --filter @workspace/api-server run test:mission-demo-ladder-guards

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** artifacts/api-server/src/lib/__qa__ → repo root. */
const ROOT = resolve(HERE, "../../../../..");

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

const SQL_PATH = "docs/migrations-pending/fix-demo-ladder.sql";
const SCHEMA_PATH = "lib/db/src/schema/profitMissions.ts";
const SQL = read(SQL_PATH);
const SCHEMA = read(SCHEMA_PATH);

/** Column names the pending migration adds to mission_trade_drafts. */
function sqlAddedColumns(sql: string): string[] {
  const out: string[] = [];
  const rx = /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_]*)/gi;
  for (const m of sql.matchAll(rx)) out.push(m[1]!.toLowerCase());
  return out;
}

/** snake_case column names the Drizzle mission_trade_drafts table maps. */
function schemaDraftColumns(schema: string): string[] {
  const start = schema.indexOf('missionTradeDraftsTable = pgTable("mission_trade_drafts"');
  assert.ok(start > 0, "mission_trade_drafts table not found in the schema");
  const body = schema.slice(start);
  const out: string[] = [];
  const rx = /\b(?:text|integer|serial|boolean|doublePrecision|real|jsonb|timestamp)\(\s*"([a-z_][a-z0-9_]*)"/g;
  for (const m of body.matchAll(rx)) out.push(m[1]!.toLowerCase());
  return out;
}

test("every column the pending migration adds is mapped by the Drizzle table", () => {
  const added = sqlAddedColumns(SQL);
  // The branch adds `simulated` + ten sim_* columns; a shrinking list means the
  // migration was edited without this guard being reconsidered.
  assert.equal(added.length, 11, `expected 11 added columns, got ${added.length}: ${added.join(", ")}`);
  const mapped = new Set(schemaDraftColumns(SCHEMA));
  for (const col of added) {
    assert.ok(mapped.has(col), `${SQL_PATH} adds "${col}" but ${SCHEMA_PATH} never maps it`);
  }
});

test("every sim_* column the Drizzle table maps is added by the pending migration", () => {
  const added = new Set(sqlAddedColumns(SQL));
  const simCols = schemaDraftColumns(SCHEMA).filter((c) => c === "simulated" || c.startsWith("sim_"));
  assert.ok(simCols.length >= 11, `expected the simulated column family in ${SCHEMA_PATH}`);
  for (const col of simCols) {
    assert.ok(added.has(col), `${SCHEMA_PATH} maps "${col}" but ${SQL_PATH} never adds it`);
  }
});

test("the migration states the SQL-before-code deploy order and names the hard-dependent readers", () => {
  assert.match(SQL, /DEPLOY ORDER/i);
  assert.match(SQL, /42703/);
  // The predicates were added to EXISTING money readers, so each of these is a
  // hard dependency, not a new optional feature.
  for (const reader of [
    "resolveMissionRealisedStats",
    "refreshMissionProtection",
    "manageOpenExits",
    "readClosedDrafts",
    "readSimulatedClosedDrafts",
  ]) {
    assert.ok(SQL.includes(reader), `${SQL_PATH} must list ${reader} as requiring the migration first`);
  }
});

test("the driver's capped open-position read excludes simulated drafts", () => {
  const driver = read("artifacts/api-server/src/lib/missionDriver.ts");
  const start = driver.indexOf("async function manageOpenExits");
  assert.ok(start > 0, "manageOpenExits not found in missionDriver.ts");
  const body = driver.slice(start, driver.indexOf("\n}", start));
  assert.ok(
    /eq\(missionTradeDraftsTable\.simulated,\s*false\)/.test(body),
    "manageOpenExits must filter `simulated = false` — a simulated draft's closed_at is NULL forever and would occupy every per-tick exit slot after a demo→live promotion",
  );
  // Deterministic slot allocation: without ORDER BY, Postgres returns physical
  // order, so which open positions get managed would be arbitrary.
  assert.ok(/\.orderBy\(/.test(body), "manageOpenExits must pin an ORDER BY before its LIMIT");
});

test("a mode change that crosses the accounting basis rebases the mission's money figure", () => {
  const svc = read("artifacts/api-server/src/lib/missionExecutionModeService.ts");
  assert.ok(
    svc.includes("accountingBasisForMode"),
    "the execution-mode service must resolve the accounting basis of both the current and target mode",
  );
  assert.ok(
    /currentValue:\s*round2\(mission\.startingAmount \+ rebase\.profit\)/.test(svc),
    "the execution-mode service must rewrite currentValue from the TARGET basis on a basis change — missionDrafts sizes real positions from mission.currentValue",
  );
  // The two series are re-read separately and never converted into each other.
  assert.ok(
    /eq\(missionTradeDraftsTable\.simulated,\s*false\)/.test(svc) &&
      /eq\(missionTradeDraftsTable\.simulated,\s*true\)/.test(svc),
    "the rebase must read each basis from its OWN column family",
  );
});

test("no realised-money reader sums a simulated row into a broker-reconciled total", () => {
  // Structural spot-check over the readers the review named: wherever a file
  // reads the broker-reconciled pnl column of mission drafts for a realised
  // total, the `simulated = false` predicate must be present in that file.
  for (const rel of [
    "artifacts/api-server/src/lib/missionExitManager.ts",
    "artifacts/api-server/src/lib/missionPromotionService.ts",
    "artifacts/api-server/src/lib/missionDriver.ts",
  ]) {
    const src = read(rel);
    assert.ok(
      /eq\(missionTradeDraftsTable\.simulated,\s*false\)/.test(src),
      `${rel} reads executed mission drafts and must carry the simulated = false predicate`,
    );
  }
});
