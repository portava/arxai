// Regression: the admin Chart Brain Benchmark must describe what was actually
// read. A failed aggregation query used to come back as an "empty" scorecard
// ("No chart-brain activity recorded yet.", every total 0, no error), and a
// window holding more receipts than the 2000-row cap showed the cap as the
// Receipts total with nothing saying older receipts were left out.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");
mock.method(database.pool, "query", () => { throw new Error("Unexpected database access"); });
mock.method(database.pool, "connect", () => { throw new Error("Unexpected database access"); });

type Row = Record<string, unknown>;
let receipts: Row[] = [];
let outcomes: Row[] = [];
let traces: Row[] = [];
let failWith: Error | null = null;

function rowsFor(table: unknown): Row[] {
  if (table === database.chartDecisionReceiptsTable) return receipts;
  if (table === database.chartDecisionOutcomesTable) return outcomes;
  if (table === database.agentGovernanceTracesTable) return traces;
  throw new Error("unexpected table");
}
const fakeDb = {
  select: () => ({
    from: (table: unknown) => ({
      where: () => ({
        orderBy: () => ({
          limit: async (n: number) => {
            if (failWith) throw failWith;
            return rowsFor(table).slice(0, n);
          },
        }),
      }),
    }),
  }),
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });

const { computeChartBrainBenchmark } = await import("../benchmarkScore.js");

const NOW = Date.now();
function receipt(i: number, over: Row = {}): Row {
  return {
    receiptId: `r${i}`,
    userId: 7,
    symbol: "EURUSD",
    timeframe: "M15",
    source: "ruby_draft_read",
    intent: null,
    direction: "NEUTRAL",
    tradeType: null,
    setupStage: "no_setup",
    qualityLabel: "unrated",
    vetoed: false,
    agentConsensusStance: "neutral",
    agentConflict: false,
    courtResult: null,
    riskWarning: null,
    rubyFinalRead: null,
    confidenceScore: null,
    whatWouldChange: null,
    invalidation: null,
    fpRegime: "range",
    fpStage: "no_setup",
    chartTruthSnapshot: {},
    intelligenceSnapshot: {},
    createdAt: new Date(NOW - i * 60_000),
    ...over,
  };
}

function reset() {
  receipts = [];
  outcomes = [];
  traces = [];
  failWith = null;
}

test("a failed aggregation query is 'could not be loaded', not an empty 'no activity' scorecard", async () => {
  reset();
  failWith = new Error("connection refused");
  await assert.rejects(
    () => computeChartBrainBenchmark({ windowDays: 30 }),
    /could not be loaded/,
  );
});

test("a window with no reads says so for that window, not 'yet'", async () => {
  reset();
  const b = await computeChartBrainBenchmark({ windowDays: 7 });
  assert.equal(b.totalReceipts, 0);
  for (const s of b.scores) {
    assert.equal(s.score, null);
    assert.equal(s.note, "No chart-brain reads recorded in the last 7 days.");
  }
});

test("more receipts than the read cap: the total is the cap and a warning says older receipts were left out", async () => {
  reset();
  receipts = Array.from({ length: 2005 }, (_, i) => receipt(i));
  const b = await computeChartBrainBenchmark({ windowDays: 90 });
  assert.equal(b.totalReceipts, 2000);
  const w = b.warnings.find((x) => x.includes("receipts"));
  assert.ok(w, `expected a coverage warning, got ${JSON.stringify(b.warnings)}`);
  assert.match(w, /more than 2000 receipts/);
  assert.match(w, /only the newest 2000 were read/);
});

test("exactly the cap is complete: no coverage warning", async () => {
  reset();
  receipts = Array.from({ length: 2000 }, (_, i) => receipt(i));
  const b = await computeChartBrainBenchmark({ windowDays: 90 });
  assert.equal(b.totalReceipts, 2000);
  assert.equal(b.warnings.some((x) => x.includes("only the newest")), false);
});

test("more governance traces than the cap is reported too", async () => {
  reset();
  traces = Array.from({ length: 2001 }, () => ({
    totalGovernanceRuntimeMs: 10,
    createdAt: new Date(NOW),
  }));
  const b = await computeChartBrainBenchmark({ windowDays: 30 });
  assert.equal(b.totalTraces, 2000);
  assert.ok(b.warnings.some((x) => /more than 2000 governance traces/.test(x)));
});
