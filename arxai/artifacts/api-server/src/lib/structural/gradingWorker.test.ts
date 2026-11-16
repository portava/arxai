import { test } from "node:test";
import assert from "node:assert/strict";
import { fitStructuralModel, forecastStructural, type DataOrigin, type StructuralBar } from "@workspace/domain/structural";

// The DB case refuses every database except the named disposable local DB.
const testUrl = process.env.ARX_STRUCTURAL_TEST_DATABASE_URL;
if (testUrl) {
  const parsed = new URL(testUrl);
  if (!(["localhost", "127.0.0.1"].includes(parsed.hostname)) || !parsed.pathname.startsWith("/arx_structural_pr150_")) throw new Error("DISPOSABLE_LOCAL_DATABASE_REQUIRED");
  process.env.DATABASE_URL = testUrl;
}
process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:1/arx_structural_pr150_unused";

test("a grading cycle grades every pending market and survives one failing", async () => {
  const { runGradingCycle } = await import("./gradingWorker.js");
  const seen: string[] = [];
  const result = await runGradingCycle({
    async listPending() { return [{ userId: 1, symbol: "V75" }, { userId: 1, symbol: "BAD" }, { userId: 2, symbol: "V25_1S" }]; },
    async grade(userId, symbol) { seen.push(`${userId}:${symbol}`); if (symbol === "BAD") throw new Error("FEED_GAP"); },
  }, Date.now());
  assert.deepEqual(seen, ["1:V75", "1:BAD", "2:V25_1S"]);
  assert.deepEqual(result, { pending: 3, graded: 2, failed: 1 });
});

test("an empty backlog does no grading work", async () => {
  const { runGradingCycle } = await import("./gradingWorker.js");
  let calls = 0;
  const result = await runGradingCycle({ async listPending() { return []; }, async grade() { calls++; } }, Date.now());
  assert.equal(calls, 0);
  assert.deepEqual(result, { pending: 0, graded: 0, failed: 0 });
});

test("pending query lists closed unscored forecasts only, per owner", { skip: !testUrl }, async () => {
  const { structuralRepository: repository } = await import("./repository.js");
  const { listPendingGrades } = await import("./gradingWorker.js");
  const { db, chartDecisionReceiptsTable: receipts, chartDecisionOutcomesTable: outcomes } = await import("@workspace/db");
  const { eq } = await import("drizzle-orm");
  const userId = 150068, id = `structural-grader-test-${Date.now()}`;
  let seed = 7, price = 100;
  const bars: StructuralBar[] = Array.from({ length: 5000 }, (_, i) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const open = price; price += (seed / 2 ** 32 - .5) * .8;
    return { openTime: i * 60_000, closeTime: (i + 1) * 60_000, open, high: Math.max(open, price) + .15,
      low: Math.min(open, price) - .15, close: price, isFinal: true };
  });
  const origin: DataOrigin = { provider: "fixture", symbol: "GRADERTEST", kind: "SYNTHETIC_TEST", fetchedAt: new Date().toISOString(), historicalArrivalTimesKnown: false };
  const model = fitStructuralModel(bars, origin), forecast = forecastStructural(model, bars.slice(-120), origin);
  try {
    // The fixture's window closed long ago, so it is due for grading.
    await repository.save(userId, { id, issuedAt: Date.now(), forecast, scores: [] }, model);
    const mine = (rows: { userId: number; symbol: string }[]) => rows.filter(r => r.userId === userId);
    assert.deepEqual(mine(await listPendingGrades(Date.now())), [{ userId, symbol: "GRADERTEST" }]);
    // Before its window closes it is not due.
    assert.deepEqual(mine(await listPendingGrades(forecast.asOf)), []);
    const score = { evaluationVersion: "test-scoring-1", horizon: 60, observedThrough: forecast.asOf + 3_600_000,
      outcome: "NEITHER", event: null, brier: .2, baselineBrier: .3, logLoss: .4 } as const;
    // Scored without a grade (the pre-grade scorer): still due.
    await repository.appendScores(userId, id, [score as never]);
    assert.deepEqual(mine(await listPendingGrades(Date.now())), [{ userId, symbol: "GRADERTEST" }]);
    // A late grade is appended beside it, read in its place, and clears the backlog.
    await repository.appendScores(userId, id, [{ ...score, lateGrade: true, grade: { letter: "C" } } as never]);
    await repository.appendScores(userId, id, [{ ...score, lateGrade: true, grade: { letter: "A" } } as never]);
    const row = (await repository.list(userId, "GRADERTEST")).find(r => r.id === id)!;
    assert.equal(row.scores.length, 1); assert.equal((row.scores[0]!.grade as { letter: string }).letter, "C");
    assert.deepEqual(mine(await listPendingGrades(Date.now())), []);
  } finally {
    await db.delete(outcomes).where(eq(outcomes.receiptRef, id));
    await db.delete(receipts).where(eq(receipts.receiptId, id));
  }
});
