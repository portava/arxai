// Calibration fits are versioned, persisted and refitted from real rows.
//
// Against a real Postgres (DATABASE_URL; CI provisions one):
//   - a refit over resolved eleanor_signal_outcomes writes a fit per
//     strategy × symbol × timeframe (+ pooled keys) and loads the cache
//   - payloads then read a measured probability with that N
//   - an unchanged refit writes no new version; new graded outcomes append
//     version+1 and the earlier version stays as it was
//
// Run: pnpm --filter @workspace/api-server run test:calibration-store-db

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, like, sql } from "drizzle-orm";
import { db, pool, eleanorSignalOutcomesTable, calibrationFitsTable } from "@workspace/db";
import { fitKey, seededRandom } from "@workspace/domain/calibration";
import { runCalibrationBootstrap, runCalibrationRefit } from "../refitWorker.js";
import { POOLED } from "@workspace/domain/calibration";
import { strategyCalibrationKey } from "../cache.js";
import { PINNED_REAL_HISTORY } from "../historicalFixtures.js";
import type { FitProvenance } from "../provenance.js";
import { fitHistory } from "../store.js";
import { calibrate, clearCalibrationCache, ELEANOR_CALIBRATION_KEY, SCANNER_CALIBRATION_KEY } from "../cache.js";

const SYMBOL = `CALTEST${Date.now() % 1_000_000}`;
const USER = 990_001;

async function insertOutcomes(n: number, seed: number, startMs: number) {
  const r = seededRandom(seed);
  const rows = Array.from({ length: n }, (_, i) => ({
    outcomeId: randomUUID(),
    userId: USER,
    symbol: SYMBOL,
    timeframe: "M15",
    direction: "BUY",
    decision: "approve",
    confidenceScore: 50 + Math.floor(r() * 45),
    outcomeStatus: r() < 0.4 ? "WIN" : "LOSS",
    scannerSignalId: i % 2 === 0 ? `scan-${randomUUID()}` : null,
    locked: true,
    createdAt: new Date(startMs + i * 60_000),
    updatedAt: new Date(startMs + i * 60_000),
    resolvedAt: new Date(startMs + i * 60_000 + 1),
  }));
  await db.insert(eleanorSignalOutcomesTable).values(rows);
}

// Fits the historical bootstrap writes during this test (public replay keys)
// are removed afterwards: only rows newer than the test's start id.
let startId = 0;

async function cleanup() {
  await db.delete(eleanorSignalOutcomesTable).where(eq(eleanorSignalOutcomesTable.symbol, SYMBOL));
  await db.delete(calibrationFitsTable).where(eq(calibrationFitsTable.symbol, SYMBOL));
  if (startId > 0) {
    await db.delete(calibrationFitsTable).where(and(gt(calibrationFitsTable.id, startId), like(calibrationFitsTable.source, "%historical_replay%")));
  }
}

describe("calibration store + refit worker (Postgres)", () => {
  before(async () => {
    const r = await db.select({ m: sql<number>`coalesce(max(${calibrationFitsTable.id}), 0)::int` }).from(calibrationFitsTable);
    startId = Number(r[0]?.m ?? 0) || 0;
    await cleanup();
    await insertOutcomes(150, 1, Date.UTC(2026, 9, 1));
  });
  after(async () => {
    await cleanup();
    clearCalibrationCache();
    await pool.end();
  });

  it("refits from resolved outcomes, persists v1 and serves it", async () => {
    const rep = await runCalibrationRefit();
    assert.deepEqual(rep.errors.filter((e) => !e.startsWith("replay") && !e.startsWith("agents")), [], JSON.stringify(rep.errors));
    const key = fitKey(ELEANOR_CALIBRATION_KEY, SYMBOL, "M15");
    const hist = await fitHistory(key);
    assert.equal(hist.length, 1);
    assert.equal(hist[0].version, 1);
    assert.equal(hist[0].n, 150);
    const c = calibrate(ELEANOR_CALIBRATION_KEY, SYMBOL, "M15", 80);
    assert.equal(c.status, "measured");
    assert.equal(c.n, 150);
    assert.equal(c.scope, "exact");
    assert.equal(c.fitVersion, 1);
    // Scanner-originated half has its own key.
    const s = calibrate(SCANNER_CALIBRATION_KEY, SYMBOL, "M15", 80);
    assert.equal(s.n, 75);
  });

  it("an unchanged refit writes no new version", async () => {
    await runCalibrationRefit();
    const hist = await fitHistory(fitKey(ELEANOR_CALIBRATION_KEY, SYMBOL, "M15"));
    assert.equal(hist.length, 1);
  });

  it("new graded outcomes append version 2 and leave version 1 intact", async () => {
    await insertOutcomes(40, 2, Date.UTC(2026, 9, 5));
    await runCalibrationRefit();
    const key = fitKey(ELEANOR_CALIBRATION_KEY, SYMBOL, "M15");
    const hist = await fitHistory(key);
    assert.deepEqual(hist.map((h) => h.version), [2, 1]);
    assert.deepEqual(hist.map((h) => h.n), [190, 150]);
    const rows = await db.select().from(calibrationFitsTable).where(inArray(calibrationFitsTable.fitKey, [key]));
    assert.equal(rows.length, 2);
    assert.equal(calibrate(ELEANOR_CALIBRATION_KEY, SYMBOL, "M15", 80).fitVersion, 2);
  });

  it("an obsolete method forces a new version even when the outcomes are unchanged", async () => {
    const key = fitKey(ELEANOR_CALIBRATION_KEY, SYMBOL, "M15");
    const rows = await db.select().from(calibrationFitsTable).where(eq(calibrationFitsTable.fitKey, key));
    const latest = rows.sort((a, b) => b.version - a.version)[0];
    const obsolete = "isotonic_pav_beta_shrinkage_cv_selected";
    await db.update(calibrationFitsTable).set({ method: obsolete, fit: { ...latest.fit, method: obsolete } }).where(eq(calibrationFitsTable.id, latest.id));
    await runCalibrationRefit();
    let history = await fitHistory(key);
    assert.equal(history[0].version, latest.version + 1);
    await runCalibrationRefit();
    history = await fitHistory(key);
    assert.equal(history[0].version, latest.version + 1, "same new-method fit is idempotent");
  });

  it("bootstraps from the committed real history with provenance, idempotently", async () => {
    const first = await runCalibrationBootstrap();
    assert.ok(first.historical?.fixtures.some((f) => f.fixtureId === "real-history-v1" && f.pinned), JSON.stringify(first.historical));
    const key = fitKey(strategyCalibrationKey("Trend Continuation"), POOLED, POOLED);
    const rows = await db.select().from(calibrationFitsTable).where(eq(calibrationFitsTable.fitKey, key));
    const latest = rows.sort((a, b) => b.version - a.version)[0];
    assert.ok(latest, "pooled trend-continuation fit persisted");
    assert.equal(latest.status, "measured");
    assert.ok(latest.n >= 30, `N=${latest.n}`);
    assert.match(latest.source, /historical_replay/);
    const prov = latest.provenance as unknown as FitProvenance;
    assert.ok(prov?.digest);
    assert.ok(prov.components.some((c) => c.fixtureId === "real-history-v1" && c.datasetHash === PINNED_REAL_HISTORY["real-history-v1"] && c.sha256));
    const st = calibrate(strategyCalibrationKey("Trend Continuation"), "EURUSD", "D1", 80);
    assert.equal(st.status, "measured");
    assert.match(st.source, /historical_replay/);
    assert.ok(st.provenance.fixtures.some((f) => f.fixtureId === "real-history-v1"));
    // Agents: a replayed record exists for STRUCT.
    const agentRows = await db.select().from(calibrationFitsTable).where(eq(calibrationFitsTable.fitKey, fitKey("agent:STRUCT", POOLED, POOLED)));
    assert.ok(agentRows.length >= 1 && agentRows.every((r) => r.n >= 30));
    // Unchanged evidence: a second run appends nothing for any historical key.
    const before = (await db.select({ id: calibrationFitsTable.id }).from(calibrationFitsTable)).length;
    await runCalibrationBootstrap();
    const afterCount = (await db.select({ id: calibrationFitsTable.id }).from(calibrationFitsTable)).length;
    assert.equal(afterCount, before, "second bootstrap must write no new version");
  });
});
