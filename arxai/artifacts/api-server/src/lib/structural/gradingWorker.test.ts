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

test("a 15-minute direction result becomes due when its own window closes", { skip: !testUrl }, async () => {
  const { listPendingGrades } = await import("./gradingWorker.js");
  const { db, chartDecisionReceiptsTable: receipts } = await import("@workspace/db");
  const { eq } = await import("drizzle-orm");
  const userId = 150070, id = "direction-window-" + process.pid;
  const asOf = Date.now() - 16 * 60_000;
  try {
    await db.insert(receipts).values({receiptId:id,userId,symbol:"V75",timeframe:"M1",source:"structural_forecast",
      expiresAt:new Date(asOf+3_600_000),intelligenceSnapshot:{forecast:{asOf,horizonBars:15,stepMs:60_000}}});
    const due = async (at: number) => (await listPendingGrades(at)).some(r => r.userId === userId);
    assert.equal(await due(asOf+900_000-1), false);
    assert.equal(await due(asOf+900_000), true);
  } finally {
    await db.delete(receipts).where(eq(receipts.receiptId,id));
  }
});

test("paper orders settle before expiry and after a direction grade, without opening history", { skip: !testUrl }, async () => {
  const { gradePublishedPaperOrders } = await import("./paperGrading.js");
  const { publicPaperBrackets } = await import("../tradeEngine/publicPaperBrackets.js");
  const { db, chartDecisionReceiptsTable: receipts, chartDecisionOutcomesTable: outcomes } = await import("@workspace/db");
  const { eq } = await import("drizzle-orm");
  const at = Date.UTC(2024,0,1), userId = 150069, id = "paper-worker-" + process.pid;
  const plan = { action: "BUY", reference: 100, stop: 98, target: 103, reason: "test" };
  const run = (ms: number) => gradePublishedPaperOrders(at + ms, 60_000);
  try {
    await db.insert(receipts).values({ receiptId:id, userId, symbol:"V75", timeframe:"M1", source:"structural_forecast",
      expiresAt:new Date(at+3_600_000), intelligenceSnapshot:{forecast:{paperInstruction:plan}} });
    await db.insert(outcomes).values({receiptRef:id,userId,kind:"STRUCTURAL_PAPER_ISSUED",evidence:{at}});
    publicPaperBrackets.observe({symbol:"R_75",epoch:at/1000+2,bid:100,ask:100.25,quote:100.125});
    assert.deepEqual(await run(2000), {checked:1,saved:0,failed:0});
    await db.insert(outcomes).values({receiptRef:id,userId,kind:"STRUCTURAL_EVALUATION",evidence:{grade:{letter:"A"}}});
    publicPaperBrackets.observe({symbol:"R_75",epoch:at/1000+4,bid:103,ask:103.25,quote:103.125});
    assert.deepEqual(await run(4000), {checked:1,saved:1,failed:0});
    assert.deepEqual(await run(6000), {checked:0,saved:0,failed:0});
    const rows = await db.select().from(outcomes).where(eq(outcomes.receiptRef,id));
    assert.deepEqual(rows.find(r=>r.kind==="STRUCTURAL_PAPER_RESULT")?.evidence,
      {state:"TARGET",entry:100.25,exit:103,observedAt:at+4000});
  } finally {
    await db.delete(outcomes).where(eq(outcomes.receiptRef,id));
    await db.delete(receipts).where(eq(receipts.receiptId,id));
  }
});
