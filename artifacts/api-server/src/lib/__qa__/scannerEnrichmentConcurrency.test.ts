// Regression lock — scanner enrichment fan-out is bounded (Task: scanner
// honest-banner + bounded enrichment).
// Run via:
//   node --import tsx --test src/lib/__qa__/scannerEnrichmentConcurrency.test.ts
//   (wired as `pnpm --filter @workspace/api-server run test:scanner-enrichment-concurrency`)
//
// The three async enrichment decorators (history, news-risk, timing-context)
// previously ran an unbounded `Promise.all` over every symbol — on the full
// ~250-symbol universe that opened ~250 simultaneous outbound calls and caused
// scan slowdowns/timeouts. They now route their per-symbol fan-out through the
// shared `mapWithConcurrency` limiter capped at `ENRICHMENT_CONCURRENCY`.
//
// This test proves:
//   1. The limiter never exceeds the cap over a large (~250) input list, even
//      when every per-symbol task overlaps in time (injected fake async fn that
//      records the peak simultaneous in-flight count). No live external calls.
//   2. The limiter preserves input ordering of results.
//   3. The cap is the expected small value (≤ ~8).
//   4. Each async decorator actually routes through the bounded helper — a
//      source-scan asserting none of them still uses a raw `Promise.all` over a
//      symbol list (so the behavioural guarantee above applies to each).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  mapWithConcurrency,
  ENRICHMENT_CONCURRENCY,
  runWithScannerBudget,
  scannerDataBudget,
} from "../marketScanner.js";

// ── 1 + 2 + 3: behavioural cap + ordering, over ~250 overlapping tasks ───────

test("mapWithConcurrency caps peak in-flight at ENRICHMENT_CONCURRENCY over 250 items", async () => {
  const N = 250;
  const items = Array.from({ length: N }, (_, i) => i);

  let inFlight = 0;
  let peak = 0;

  const results = await mapWithConcurrency(items, ENRICHMENT_CONCURRENCY, async (item) => {
    inFlight++;
    if (inFlight > peak) peak = inFlight;
    // Yield across several microtasks so tasks genuinely overlap; an unbounded
    // Promise.all would let all 250 enter before any resolves, driving peak=250.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    inFlight--;
    return item * 2;
  });

  assert.ok(peak > 1, `tasks must genuinely overlap (peak was ${peak})`);
  assert.ok(
    peak <= ENRICHMENT_CONCURRENCY,
    `peak in-flight ${peak} must be <= cap ${ENRICHMENT_CONCURRENCY}`,
  );
  // Results preserve input order regardless of completion order.
  assert.deepEqual(results, items.map((i) => i * 2));
});

test("the enrichment cap stays a small bounded value (<= ~8)", () => {
  assert.ok(ENRICHMENT_CONCURRENCY >= 1, "cap must be positive");
  assert.ok(ENRICHMENT_CONCURRENCY <= 8, `cap ${ENRICHMENT_CONCURRENCY} must stay <= ~8`);
});

// ── 4: every async decorator routes through the bounded helper ───────────────

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "marketScanner.ts"),
  "utf8",
);

const ASYNC_DECORATORS = [
  "decorateOpportunitiesWithNewsRisk",
  "decorateOpportunitiesWithTimingContext",
  "decorateOpportunitiesWithHistory",
];

for (const name of ASYNC_DECORATORS) {
  test(`${name} bounds its per-symbol fan-out via mapWithConcurrency`, () => {
    const start = SRC.indexOf(`export async function ${name}(`);
    assert.ok(start > -1, `${name} should exist`);
    // Window covers the function body up to the next top-level export.
    const after = SRC.indexOf("\nexport ", start + 1);
    const body = SRC.slice(start, after === -1 ? undefined : after);
    assert.match(
      body,
      /mapWithConcurrency\(/,
      `${name} must fan out through mapWithConcurrency`,
    );
    assert.ok(
      !/Promise\.all\(\s*\w+\.map\(/.test(body) && !/Promise\.all\(\s*Array\.from\(/.test(body),
      `${name} must NOT use an unbounded Promise.all over a symbol list`,
    );
  });
}

// ── 5: the remaining scanner data lookups are also bounded ───────────────────
//
// Beyond the three enrichment decorators, two more lookup sites previously ran
// un-pooled: the fixed 2-call `Promise.all([routeCandles, routeQuote])` inside
// `analyzeViaRouter`, and the core per-symbol scan loop in `scanOnce`. Both now
// route through the SAME `mapWithConcurrency` limiter so a wide scan's total
// router/DB fan-out stays capped. These are source-scans (the cap *behaviour*
// is already proven by test #1, which every site shares via the one helper).

function bodyOf(decl: string): string {
  const start = SRC.indexOf(decl);
  assert.ok(start > -1, `${decl} should exist`);
  // Window covers the function body up to the next top-level declaration
  // (either an `export ` or a non-exported `async function `).
  const tail = SRC.indexOf("\nexport ", start + 1);
  const nextFn = SRC.indexOf("\nasync function ", start + 1);
  const ends = [tail, nextFn].filter((i) => i > -1);
  return SRC.slice(start, ends.length ? Math.min(...ends) : undefined);
}

test("analyzeViaRouter routes its candle+quote lookups through the shared budget", () => {
  const body = bodyOf("async function analyzeViaRouter(");
  // Both leaf lookups must acquire the ONE shared budget — not a nested
  // per-call limiter that would multiply against the outer scan loop's cap.
  const budgetCalls = body.match(/runWithScannerBudget\(/g) ?? [];
  assert.ok(
    budgetCalls.length >= 2,
    `analyzeViaRouter must route BOTH candle+quote leaf lookups through runWithScannerBudget (found ${budgetCalls.length})`,
  );
  assert.ok(
    !/mapWithConcurrency\(/.test(body),
    "analyzeViaRouter must NOT open its own nested limiter — leaf I/O shares the one budget",
  );
  assert.ok(
    !/Promise\.all\(\s*\[\s*routeCandles/.test(body),
    "analyzeViaRouter must NOT use a raw Promise.all over routeCandles/routeQuote",
  );
});

test("scanOnce core symbol×timeframe scan fans out through the bounded helper", () => {
  const body = bodyOf("export async function scanOnce(");
  assert.match(
    body,
    /mapWithConcurrency\(/,
    "scanOnce's core scan loop must fan out through mapWithConcurrency",
  );
  assert.ok(
    !/Promise\.all\(\s*\w+\.map\(/.test(body),
    "scanOnce must NOT use an unbounded Promise.all over the symbol list",
  );
});

const LEAF_BUDGET_SITES: Array<{ decl: string; min: number }> = [
  { decl: "export async function decorateOpportunitiesWithNewsRisk(", min: 1 },
  { decl: "export async function decorateOpportunitiesWithTimingContext(", min: 1 },
  { decl: "export async function decorateOpportunitiesWithHistory(", min: 1 },
  // Task #675 — FVG Trend Pullback decorator fetches H4+H1+M5 candles per symbol.
  { decl: "export async function decorateOpportunitiesWithFvgRead(", min: 1 },
];

for (const { decl, min } of LEAF_BUDGET_SITES) {
  const name = decl.replace("export async function ", "").replace("(", "");
  test(`${name} routes its provider/DB leaf lookup through the shared budget`, () => {
    const body = bodyOf(decl);
    const budgetCalls = body.match(/runWithScannerBudget\(/g) ?? [];
    assert.ok(
      budgetCalls.length >= min,
      `${name} must route its leaf lookup through runWithScannerBudget (found ${budgetCalls.length})`,
    );
  });
}

// ── 5b: the per-symbol advisory/governance path is also budgeted ─────────────
//
// `scanSymbolTimeframe` runs best-effort advisory + governance work per symbol
// (agent-ecosystem advisory read, Court traffic selection, durable governance
// trace persist). Each of those touches the agent registry / governance tables
// (DB), so under a wide scan they must draw from the SAME shared budget as the
// data lookups — otherwise total in-flight provider/DB calls could exceed the
// single cap. These are source-scans; the cap *behaviour* is proven by the
// shared-budget tests below (every site funnels through the one helper).

test("scanSymbolTimeframe routes its advisory/governance DB lookups through the shared budget", () => {
  const body = bodyOf("export async function scanSymbolTimeframe(");
  // Each of the three async DB-touching advisory/governance calls must be
  // wrapped so its leaf lookup acquires from the one shared budget.
  for (const [pattern, label] of [
    [/runWithScannerBudget\(\s*\(\)\s*=>\s*\n?\s*computeScannerAdvisory\(/, "computeScannerAdvisory (agent registry read)"],
    [/runWithScannerBudget\(\s*\(\)\s*=>\s*\n?\s*runTrafficSelection\(/, "runTrafficSelection (agent registry read)"],
    [/runWithScannerBudget\(\s*\(\)\s*=>\s*\n?\s*persistGovernanceTrace\(/, "persistGovernanceTrace (governance trace insert)"],
  ] as const) {
    assert.match(
      body,
      pattern,
      `${label} must run under runWithScannerBudget so advisory/governance work shares the single cap`,
    );
  }
  // And none of those calls may run un-budgeted (bare invocation outside the
  // shared budget would escape the single cap).
  assert.ok(
    !/await\s+computeScannerAdvisory\(/.test(body),
    "computeScannerAdvisory must not be awaited outside runWithScannerBudget",
  );
  assert.ok(
    !/await\s+runTrafficSelection\(/.test(body),
    "runTrafficSelection must not be awaited outside runWithScannerBudget",
  );
  assert.ok(
    !/void\s+persistGovernanceTrace\(/.test(body),
    "persistGovernanceTrace must not be fired outside runWithScannerBudget",
  );
});

// ── 6: ONE shared budget across nested fan-outs — the core regression ────────
//
// The scanner's structural fan-outs nest: the core `scanOnce` loop runs up to
// ENRICHMENT_CONCURRENCY per-symbol scans at once, and each per-symbol scan
// (via analyzeViaRouter) fires its OWN candle+quote sub-lookups. Two separate
// caps of N would multiply to N×M simultaneous provider/DB calls. This test
// reproduces that exact loop×sub-lookup nesting against the REAL shared
// `runWithScannerBudget` budget and asserts total peak in-flight leaf I/O never
// exceeds the single cap — i.e. the caps no longer multiply.

test("nested loop × per-symbol sub-lookups draw from ONE budget — total peak stays within the single cap", async () => {
  let inFlight = 0;
  let peak = 0;

  // A fake provider/DB leaf lookup, gated by the SHARED budget exactly like
  // routeCandles/routeQuote/news/timing/history are in production.
  const leafLookup = () =>
    runWithScannerBudget(async () => {
      inFlight++;
      if (inFlight > peak) peak = inFlight;
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      inFlight--;
      return 1;
    });

  // Outer scan loop over many symbols, bounded structurally by the same cap —
  // each symbol fires TWO concurrent sub-lookups (mirrors candle+quote).
  const symbols = Array.from({ length: 60 }, (_, i) => i);
  await mapWithConcurrency(symbols, ENRICHMENT_CONCURRENCY, async () => {
    await Promise.all([leafLookup(), leafLookup(), leafLookup()]);
  });

  assert.ok(peak > 1, `leaf lookups must genuinely overlap (peak was ${peak})`);
  assert.ok(
    peak <= ENRICHMENT_CONCURRENCY,
    `total peak in-flight ${peak} must be <= the single shared cap ${ENRICHMENT_CONCURRENCY} ` +
      `(if the caps still multiplied this would reach loop×sublookups)`,
  );
  // The budget fully drains back — no leaked permits after a full scan.
  assert.equal(inFlight, 0, "all leaf lookups must have completed");
});

test("the shared budget serializes excess demand without dropping work", async () => {
  // Fire far more leaf lookups than the cap, all at once, directly against the
  // shared budget. Every one must still complete (FIFO, no starvation) while
  // the peak stays capped.
  let inFlight = 0;
  let peak = 0;
  let completed = 0;
  const N = 200;
  await Promise.all(
    Array.from({ length: N }, () =>
      runWithScannerBudget(async () => {
        inFlight++;
        if (inFlight > peak) peak = inFlight;
        await new Promise((r) => setTimeout(r, 0));
        inFlight--;
        completed++;
      }),
    ),
  );
  assert.equal(completed, N, "every queued leaf lookup must complete");
  assert.ok(
    peak <= ENRICHMENT_CONCURRENCY,
    `peak in-flight ${peak} must be <= cap ${ENRICHMENT_CONCURRENCY}`,
  );
  assert.equal(inFlight, 0, "no in-flight work should remain");
  // Sanity: the exported budget instance is the one the helper uses.
  assert.ok(scannerDataBudget != null, "scannerDataBudget must be exported");
});
