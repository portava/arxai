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

// ── Dimensions that were constants, not measurements ─────────────────────────
// riskWarning is the risk sentence and is stored on every receipt, including
// "Risk looks normal…"; agentConflict is false when no agent was consulted;
// every read stores a headline plus a what-would-change line; and qualityLabel
// is the trade-readiness grade (A+…F/unrated), not "clean/high/strong".
const { readFileSync } = await import("node:fs");
const { riskSentenceIsWarning } = await import("../benchmarkScore.js");
const NORMAL_RISK = "Risk looks normal for this read — no major conflicts in the picture.";

function scoreOf(b: { scores: Array<{ key: string; score: number | null; note: string; sampleSize: number }> }, key: string) {
  const s = b.scores.find((x) => x.key === key);
  assert.ok(s, `missing score ${key}`);
  return s;
}

function lossOutcomes(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    receiptRef: `r${i}`,
    kind: "OUTCOME",
    outcome: "LOSS",
    plQuality: null,
    createdAt: new Date(NOW - i * 1000),
  }));
}

function boilerplateReceipts(n: number, over: (i: number) => Row = () => ({})): Row[] {
  return Array.from({ length: n }, (_, i) =>
    receipt(i, {
      riskWarning: NORMAL_RISK,
      agentConflict: false,
      agentConsensusStance: "neutral",
      courtResult: null,
      qualityLabel: "A",
      rubyFinalRead: "EURUSD is ranging.",
      whatWouldChange: "A close above resistance would change this read.",
      invalidation: "No clear invalidation level yet — wait for structure before risking anything.",
      ...over(i),
    }),
  );
}

test("risk detection: the all-clear risk sentence is not a flag; losses after it score 0, not 100", async () => {
  reset();
  receipts = boilerplateReceipts(5);
  outcomes = lossOutcomes(5);
  const b = await computeChartBrainBenchmark({ windowDays: 30 });
  const s = scoreOf(b, "risk_detection");
  assert.equal(s.sampleSize, 5);
  assert.equal(s.score, 0);
});

test("risk detection: a veto or a warning-form risk sentence counts as flagged", async () => {
  reset();
  receipts = boilerplateReceipts(4, (i) =>
    i === 0 ? { vetoed: true }
    : i === 1 ? { riskWarning: "Risk is elevated — price is pressing into resistance." }
    : i === 2 ? { riskWarning: "Risk is moderate — the timeframes disagree, so treat anything here as scalp-only." }
    : {},
  );
  outcomes = lossOutcomes(4);
  const b = await computeChartBrainBenchmark({ windowDays: 30 });
  assert.equal(scoreOf(b, "risk_detection").score, 75);
});

test("every warning form of the real risk sentence is recognised, and the all-clear line is not", () => {
  const src = readFileSync(new URL("../../data/chart/marketSentenceEngine.ts", import.meta.url), "utf8");
  const start = src.indexOf("function sentenceRisk(");
  assert.ok(start > 0, "sentenceRisk not found");
  const body = src.slice(start, src.indexOf("\n}\n", start));
  const texts = [...body.matchAll(/text:\s*(["`])((?:(?!\1).)*)\1/g)].map((m) => m[2]!);
  assert.ok(texts.length >= 5, `expected the risk sentence variants, got ${texts.length}`);
  const normal = texts.filter((t) => t.startsWith("Risk looks normal"));
  assert.equal(normal.length, 1);
  assert.equal(normal[0], NORMAL_RISK);
  assert.equal(riskSentenceIsWarning(NORMAL_RISK), false);
  // "Risk not assessed" (no read) is neither the all-clear nor a warning flag.
  const notAssessed = texts.filter((t) => t.startsWith("Risk not assessed"));
  assert.equal(notAssessed.length, 1);
  assert.equal(riskSentenceIsWarning(notAssessed[0]), false);
  for (const t of texts.filter((x) => x !== NORMAL_RISK && !notAssessed.includes(x))) {
    assert.equal(riskSentenceIsWarning(t), true, `not recognised as a warning: ${t}`);
  }
  assert.equal(riskSentenceIsWarning(null), false);
  assert.equal(riskSentenceIsWarning(""), false);
});

test("agent agreement: reads where no agent was consulted are not agreement", async () => {
  reset();
  receipts = boilerplateReceipts(5);
  const b = await computeChartBrainBenchmark({ windowDays: 30 });
  const s = scoreOf(b, "agent_agreement");
  assert.equal(s.score, null);
  assert.equal(s.sampleSize, 0);
  assert.match(s.note, /5 of 5 reads had no agents consulted/);
});

test("agent agreement: measured over reads where agents were consulted", async () => {
  reset();
  receipts = boilerplateReceipts(6, (i) =>
    i < 3 ? { courtResult: "NO_CONFLICT" }
    : i === 3 ? { courtResult: "CONFLICT", agentConflict: true }
    : {},
  );
  const b = await computeChartBrainBenchmark({ windowDays: 30 });
  const s = scoreOf(b, "agent_agreement");
  assert.equal(s.sampleSize, 4);
  assert.equal(s.score, 75);
  assert.match(s.note, /2 of 6 reads had no agents consulted/);
});

test("Ruby explanation quality is not measured: boilerplate presence does not score 100", async () => {
  reset();
  receipts = boilerplateReceipts(5);
  const b = await computeChartBrainBenchmark({ windowDays: 30 });
  const s = scoreOf(b, "ruby_explanation_quality");
  assert.equal(s.score, null);
  assert.match(s.note, /^Not measured/);
  assert.equal(b.weakAreas.some((w) => w.key === "ruby_explanation_quality"), false);
});

test("structure read uses the grader's A+…F vocabulary and leaves unrated reads out", async () => {
  reset();
  receipts = boilerplateReceipts(6, (i) =>
    ({ qualityLabel: ["A+", "A", "A", "C", "F", "unrated"][i] }),
  );
  const b = await computeChartBrainBenchmark({ windowDays: 30 });
  const s = scoreOf(b, "structure_read");
  assert.equal(s.sampleSize, 5);
  assert.equal(s.score, 60);
  assert.match(s.note, /rated A\+ or A/);
});

// ── Feed facts come from chartTruthSnapshot; P/L quality is user-entered ────
// readSnapshot read intelligenceSnapshot, which never holds stale/aiUsable,
// so Feed Truth was always "Insufficient data" and the stale-feed warning
// never fired. Exit Realism called the user's own plQuality "broker-known".
test("feed truth reads the chart-truth snapshot: stale, unusable feeds score 0 and warn", async () => {
  reset();
  receipts = Array.from({ length: 4 }, (_, i) =>
    receipt(i, {
      chartTruthSnapshot: { truthState: "STALE", stale: true, aiUsable: false },
      intelligenceSnapshot: { bias: "neutral", setupStage: "no_setup" },
    }),
  );
  const b = await computeChartBrainBenchmark({ windowDays: 30 });
  const s = scoreOf(b, "feed_truth");
  assert.equal(s.sampleSize, 4);
  assert.equal(s.score, 0);
  assert.ok(
    b.warnings.some((w) => /100% of recent reads ran on a stale or unusable feed/.test(w)),
    JSON.stringify(b.warnings),
  );
});

test("feed truth counts clean reads from the chart-truth snapshot", async () => {
  reset();
  receipts = Array.from({ length: 4 }, (_, i) =>
    receipt(i, {
      chartTruthSnapshot: i < 3 ? { stale: false, aiUsable: true } : { stale: true, aiUsable: false },
    }),
  );
  const b = await computeChartBrainBenchmark({ windowDays: 30 });
  assert.equal(scoreOf(b, "feed_truth").score, 75);
});

test("speed says it counts governance runs only when receipts record no read build time", async () => {
  reset();
  receipts = [receipt(0)];
  traces = Array.from({ length: 4 }, (_, i) => ({
    totalGovernanceRuntimeMs: i === 0 ? 900 : 50,
    createdAt: new Date(NOW),
  }));
  const b = await computeChartBrainBenchmark({ windowDays: 30 });
  const s = scoreOf(b, "speed");
  assert.equal(s.score, 75);
  assert.match(s.note, /3\/4 governance runs finished within 400ms/);
  assert.match(s.note, /Read build times are not recorded/);
  assert.doesNotMatch(s.note, /reads\/governance runs/);
});

test("exit realism: user-entered plQuality KNOWN earns no points and is never called broker-known", async () => {
  reset();
  receipts = Array.from({ length: 4 }, (_, i) => receipt(i, { direction: "BUY" }));
  outcomes = receipts.map((r, i) => ({
    receiptRef: r.receiptId,
    kind: "OUTCOME",
    outcome: i % 2 === 0 ? "WIN" : "LOSS",
    plQuality: "KNOWN",
    evidence: {},
    createdAt: new Date(NOW - i * 1000),
  }));
  const b = await computeChartBrainBenchmark({ windowDays: 30 });
  const s = scoreOf(b, "exit_realism");
  assert.equal(s.score, null);
  assert.doesNotMatch(s.note, /broker-known/);
  assert.match(s.note, /^Not measured/);
  assert.match(s.note, /4 of 4 resolved trades were reported by the user/);
  assert.equal(b.weakAreas.some((w) => w.key === "exit_realism"), false);
});
