import { test } from "node:test";
import assert from "node:assert/strict";
import { fitStructuralModel, forecastStructural, type DataOrigin, type StructuralBar } from "@workspace/domain/structural";

// This suite refuses every database except the named disposable local DB.
const testUrl = process.env.ARX_STRUCTURAL_TEST_DATABASE_URL;
if (!testUrl && (process.env.CI || process.env.ARX_REQUIRE_INTEGRATION_DB)) {
  throw new Error("ARX_STRUCTURAL_TEST_DATABASE_URL_REQUIRED_FOR_RELEASE");
}
if (testUrl) {
  const parsed = new URL(testUrl);
  if (!(["localhost", "127.0.0.1"].includes(parsed.hostname)) || !parsed.pathname.startsWith("/arx_structural_pr150_")) throw new Error("DISPOSABLE_LOCAL_DATABASE_REQUIRED");
  process.env.DATABASE_URL = testUrl;
}
test("PostgreSQL receipt persistence is immutable, idempotent and user isolated", { skip: !testUrl }, async () => {
  const { structuralRepository: repository } = await import("./repository.js");
  const { db, chartDecisionReceiptsTable: receipts, chartDecisionOutcomesTable: outcomes } = await import("@workspace/db");
  const { eq } = await import("drizzle-orm");
  const userId = 150067, id = `structural-db-test-${Date.now()}`;
  let seed = 123, price = 100;
  const bars: StructuralBar[] = Array.from({ length: 5000 }, (_, i) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const open = price; price += (seed / 2 ** 32 - .5) * .8;
    return { openTime: i * 60_000, closeTime: (i + 1) * 60_000, open, high: Math.max(open, price) + .15,
      low: Math.min(open, price) - .15, close: price, isFinal: true };
  });
  const origin: DataOrigin = { provider: "fixture", symbol: "V75", kind: "SYNTHETIC_TEST", fetchedAt: new Date().toISOString(), historicalArrivalTimesKnown: false };
  const model = fitStructuralModel(bars, origin), forecast = forecastStructural(model, bars.slice(-120), origin);
  const row = { id, issuedAt: Date.now(), forecast, scores: [] };
  try {
    await repository.save(userId, row, model);
    const original = (await db.select().from(receipts).where(eq(receipts.receiptId, id)))[0]!;
    const replacement = structuredClone(row); replacement.forecast.gateReason = "MUST_NOT_OVERWRITE";
    const existing = await repository.save(userId, replacement, model);
    assert.equal(existing.forecast.gateReason, forecast.gateReason);
    assert.equal((await repository.list(userId + 1, "V75")).some(r => r.id === id), false);
    const score = { evaluationVersion: "test-scoring-1", horizon: 1, observedThrough: forecast.asOf + 60_000, outcome: "NEITHER" as const,
      event: null, brier: .2, baselineBrier: .3, logLoss: .4 };
    await assert.rejects(repository.appendScores(userId + 1, id, [score]), /FORECAST_NOT_FOUND/);
    await Promise.all([repository.appendScores(userId, id, [score]), repository.appendScores(userId, id, [score])]);
    const result = (await repository.list(userId, "V75")).find(r => r.id === id)!;
    assert.equal(result.scores.length, 1);
    const final = (await db.select().from(receipts).where(eq(receipts.receiptId, id)))[0]!;
    assert.deepEqual(final, original);
  } finally {
    // Only this suite's rows, only in the guarded disposable test database.
    await db.delete(outcomes).where(eq(outcomes.receiptRef, id));
    await db.delete(receipts).where(eq(receipts.receiptId, id));
  }
});
