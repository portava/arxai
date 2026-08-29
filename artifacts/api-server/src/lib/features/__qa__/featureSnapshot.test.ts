// Feature Snapshot adapter — R7 step 4 (ONE FEATURE PATH) contract locks.
//
// Pins, offline (no DB, no network — dummy unroutable DATABASE_URL satisfies
// any lazy @workspace/db init; no query is ever issued):
//
//   1. DETERMINISM — same candles + same asOf ⇒ byte-identical snapshot,
//      including the FeatureVector's dataSnapshotHash. This is the property
//      that makes a persisted snapshot replayable evidence at all.
//   2. HONEST REFUSALS — too few bars, flat closes, and empty input refuse
//      with INSUFFICIENT_DATA; they never fabricate a σ. Refusals still carry
//      featureSetId (a refusal records WHICH engine version refused).
//   3. LOOKAHEAD SURFACING — data that was not knowable at asOf throws a
//      typed LookaheadError from the reader (contract pin) and surfaces as
//      LOOKAHEAD_REFUSED from the adapter; it is never folded into the
//      missing-data path, and bars after asOf can never influence the vector.
//   4. SCANNER ATTACHMENT — the snapshot rides the ScannerOpportunity beside
//      the regime verdict, computed from the SAME routed window (source
//      proof), and attaching it changes NO score and NO final read
//      (additive-only pin — the expectancy engine consumes it in a later
//      calibration step, not this slice).
//   5. SHADOW STAMPING — createShadowDecision stamps featureSetId + snapshot
//      (behavioral, via the seeded in-memory simulator) and
//      shapeShadowDecisionRow persists both verbatim; unstamped decisions
//      persist null, never a default.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/features/__qa__/featureSnapshot.test.ts

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildFeatureSnapshot,
  candlePointInTimeReader,
  ewmaSigma,
  inferBarMinutes,
  latestCloseIso,
  EWMA_LAMBDA,
  FEATURE_SET_ID,
  LookaheadError,
  MIN_SIGMA_CANDLES,
  type FeatureCandle,
  type FeatureSnapshot,
} from "../featureSnapshot.js";
import type { ScannerOpportunity } from "../../marketScanner.js";
import type { ShadowDecision } from "../../shadowMode.js";

// Static imports are hoisted ABOVE the DATABASE_URL assignment, and the
// scanner/shadow chains transitively load @workspace/db (which throws at
// module init without a URL) — so the runtime imports must be dynamic, after
// the dummy URL is in place. Type-only imports above are erased at runtime.
const { computeFinalRead, effectiveOpportunityScore } = await import("../../marketScanner.js");
const { createShadowDecision } = await import("../../shadowMode.js");
const { shapeShadowDecisionRow } = await import("../../shadowPersistence.js");

// ── Fixtures ────────────────────────────────────────────────────────────────

const T0 = Date.parse("2026-08-19T10:00:00.000Z");
const M1 = 60_000;

/** Deterministic 1-minute candles: close wobbles ±0.1% around base. */
function mkCandles(
  n: number,
  opts: { wobble?: number; base?: number; startMs?: number } = {},
): FeatureCandle[] {
  const { wobble = 0.001, base = 100, startMs = T0 } = opts;
  const out: FeatureCandle[] = [];
  for (let i = 0; i < n; i++) {
    const close = base * (1 + wobble * Math.sin(i + 1));
    out.push({
      time: new Date(startMs + i * M1).toISOString(),
      open: close, high: close * 1.0001, low: close * 0.9999, close,
      volume: 100,
    });
  }
  return out;
}

const SIGMA_KEY = "sigma1min:XAUUSD";
const MINUTES_PER_YEAR = 365 * 1440;

function scannerOpp(over: Partial<ScannerOpportunity> = {}): ScannerOpportunity {
  return {
    symbol: "EURUSD", timeframe: "M5",
    bias: "bullish", recommendedAction: "BUY", setupType: "Continuation",
    confidenceScore: 88, riskScore: 20, entrySniperScore: 80, riskRewardRatio: 2,
    reasonForTrade: "Support hold", reasonToAvoid: "",
    rulesPassed: [], rulesFailed: [],
    statusBadge: "HOT_SETUP",
    opportunity: {
      score: 88, label: "STRONG",
      factors: {
        trendAlignment: 80, supportResistanceQuality: 80, entryTiming: 80,
        riskRewardQuality: 80, volatilityCondition: 80, spreadCondition: 80,
        strategyMatch: 80, aiConfidenceCalibration: 80,
      },
    },
    entry: 1.1, stopLoss: 1.09, takeProfit: 1.12,
    generatedAt: "2026-08-19T00:00:00.000Z",
    dataSource: "LIVE_FEED",
    approvedTop250: true, dataStatus: "live",
    selectable: true, tradeable: true, disabledReason: null,
    chartConfirmed: true,
    ...over,
  };
}

// ── 1. Determinism ──────────────────────────────────────────────────────────

test("same candles + same asOf ⇒ byte-identical snapshot (incl. dataSnapshotHash)", () => {
  const candles = mkCandles(60);
  const asOf = latestCloseIso(candles);
  assert.ok(asOf, "60 one-minute bars must yield an asOf anchor");
  const a = buildFeatureSnapshot("XAUUSD", candles, asOf);
  const b = buildFeatureSnapshot("XAUUSD", candles, asOf);
  // A structurally fresh copy of the same bars must not change a single byte.
  const c = buildFeatureSnapshot("XAUUSD", JSON.parse(JSON.stringify(candles)), asOf);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(JSON.stringify(a), JSON.stringify(c));
  assert.equal(a.available, true);
  if (a.available) {
    assert.equal(a.featureSetId, FEATURE_SET_ID);
    assert.equal(a.features.featureSetId, FEATURE_SET_ID);
    assert.equal(a.features.instrument, "XAUUSD");
    assert.equal(a.features.asOfIso, asOf);
    assert.equal(a.computedAt, asOf);
    assert.ok((a.features.expectedMoveSigma1min ?? 0) > 0, "measured σ must be positive");
    assert.match(a.features.dataSnapshotHash, /^[0-9a-f]{64}$/);
  }
});

test("bars after asOf can never influence the vector (point-in-time pin)", () => {
  const first60 = mkCandles(60);
  const all80 = mkCandles(80);
  const asOf = latestCloseIso(first60);
  assert.ok(asOf);
  // Same asOf, one call holding 20 FUTURE bars beyond it: identical snapshot.
  assert.equal(
    JSON.stringify(buildFeatureSnapshot("XAUUSD", all80, asOf)),
    JSON.stringify(buildFeatureSnapshot("XAUUSD", first60, asOf)),
  );
});

// ── 2. Honest refusals ──────────────────────────────────────────────────────

test("too few bars ⇒ INSUFFICIENT_DATA (never a fabricated σ)", () => {
  const candles = mkCandles(MIN_SIGMA_CANDLES - 1);
  const asOf = latestCloseIso(candles);
  assert.ok(asOf);
  const snap = buildFeatureSnapshot("XAUUSD", candles, asOf);
  assert.equal(snap.available, false);
  if (!snap.available) {
    assert.equal(snap.reason, "INSUFFICIENT_DATA");
    // A refusal records WHICH engine version refused.
    assert.equal(snap.featureSetId, FEATURE_SET_ID);
  }
});

test("flat closes ⇒ INSUFFICIENT_DATA (σ=0 is refused, not reported as riskless)", () => {
  const candles = mkCandles(60, { wobble: 0 });
  const asOf = latestCloseIso(candles);
  assert.ok(asOf);
  const snap = buildFeatureSnapshot("XAUUSD", candles, asOf);
  assert.equal(snap.available, false);
  if (!snap.available) assert.equal(snap.reason, "INSUFFICIENT_DATA");
});

test("no candles at all ⇒ INSUFFICIENT_DATA — missing data is NOT lookahead", () => {
  const snap = buildFeatureSnapshot("XAUUSD", [], "2026-08-19T11:00:00.000Z");
  assert.equal(snap.available, false);
  if (!snap.available) assert.equal(snap.reason, "INSUFFICIENT_DATA");
});

test("synthetic closed form needs no market read (exact by construction)", () => {
  const expected = 0.75 / Math.sqrt(MINUTES_PER_YEAR);
  const withBars = buildFeatureSnapshot("R_75", mkCandles(60), latestCloseIso(mkCandles(60))!);
  const noBars = buildFeatureSnapshot("Volatility 75 Index", [], "2026-08-19T11:00:00.000Z");
  for (const snap of [withBars, noBars]) {
    assert.equal(snap.available, true);
    if (snap.available) assert.equal(snap.features.expectedMoveSigma1min, expected);
  }
});

// ── 3. Lookahead surfacing ──────────────────────────────────────────────────

test("reader THROWS typed LookaheadError when the only data closes after asOf", () => {
  const candles = mkCandles(60);
  const reader = candlePointInTimeReader(candles);
  // asOf = 1ms before the FIRST bar's close: data exists, none knowable yet.
  const asOf = new Date(T0 + M1 - 1).toISOString();
  assert.throws(
    () => reader.latestFact<number>(SIGMA_KEY, asOf),
    (err: unknown) => {
      assert.ok(err instanceof LookaheadError, "must be the typed LookaheadError, never generic");
      assert.equal((err as LookaheadError).name, "LookaheadError");
      return true;
    },
  );
});

test("adapter surfaces lookahead as LOOKAHEAD_REFUSED — never as missing data", () => {
  const candles = mkCandles(60);
  const asOf = new Date(T0 + M1 - 1).toISOString();
  const snap = buildFeatureSnapshot("XAUUSD", candles, asOf);
  assert.equal(snap.available, false);
  if (!snap.available) {
    assert.equal(snap.reason, "LOOKAHEAD_REFUSED");
    assert.equal(snap.featureSetId, FEATURE_SET_ID);
    assert.match(snap.detail, /ingested/i);
  }
});

test("only the still-forming tail is excluded when asOf sits mid-series", () => {
  const candles = mkCandles(60);
  // asOf = close of bar #40 (index 39): exactly 40 bars knowable.
  const asOf = new Date(T0 + 40 * M1).toISOString();
  const snap = buildFeatureSnapshot("XAUUSD", candles, asOf);
  const snapOnlyEligible = buildFeatureSnapshot("XAUUSD", candles.slice(0, 40), asOf);
  assert.equal(snap.available, true);
  assert.equal(JSON.stringify(snap), JSON.stringify(snapOnlyEligible));
});

// ── EWMA measured-σ estimator (fset_v2) ─────────────────────────────────────

test("fset_v2: the measured-σ math changed, so the engine version MUST say so", () => {
  // The reader's estimator moved from a flat sample stdev to a RiskMetrics
  // EWMA. FEATURE_SET_ID discipline: changed math without a bump would poison
  // replay lineage — this pin fails if anyone reverts the bump but not the math.
  assert.equal(FEATURE_SET_ID, "fset_v2");
});

test("EWMA: a constant-|r| return series yields exactly |r| (fixed point)", () => {
  // With every squared return equal, both the seed and the recursion sit at
  // the same fixed point — the estimator must reproduce |r| to the bit.
  const r = 0.0025;
  const returns = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? r : -r));
  assert.ok(
    Math.abs(ewmaSigma(returns) - r) < r * 1e-12,
    `fixed point must reproduce |r| to fp precision (got ${ewmaSigma(returns)})`,
  );

  // And through the reader: alternating closes 100 ↔ 100·e^r on 1-minute bars
  // produce exactly those returns, so σ_1min = r (barMinutes = 1).
  const candles: FeatureCandle[] = Array.from({ length: 41 }, (_, i) => {
    const close = i % 2 === 0 ? 100 : 100 * Math.exp(r);
    return {
      time: new Date(T0 + i * M1).toISOString(),
      open: close, high: close, low: close, close,
    };
  });
  const reader = candlePointInTimeReader(candles);
  const fact = reader.latestFact<number>(SIGMA_KEY, latestCloseIso(candles)!);
  assert.ok(fact, "41 bars clear the honesty floor");
  assert.ok(Math.abs(fact!.value - r) < 1e-15, `σ_1min must equal r (got ${fact!.value})`);
});

test("EWMA weights the CURRENT regime — a flat stdev cannot tell these apart", () => {
  const calm = 0.0005;
  const shock = 0.005;
  // Same multiset of returns, opposite placement of the volatile stretch.
  const shockLast = [...Array(50).fill(calm), ...Array(5).fill(shock)];
  const shockFirst = [...Array(5).fill(shock), ...Array(50).fill(calm)];
  const recent = ewmaSigma(shockLast);
  const stale = ewmaSigma(shockFirst);
  // A flat sample stdev is order-invariant; the EWMA must NOT be.
  assert.ok(
    recent > stale * 1.5,
    `a shock in the newest bars must dominate (recent=${recent}, stale=${stale})`,
  );
  assert.ok(EWMA_LAMBDA > 0.9 && EWMA_LAMBDA < 1, "RiskMetrics-range decay");
});

test("EWMA honesty edges: empty series → 0; all-zero returns stay refused downstream", () => {
  assert.equal(ewmaSigma([]), 0);
  assert.equal(ewmaSigma([0, 0, 0]), 0);
  // The reader path still refuses a flat series (σ=0 is never 'riskless').
  const flat = mkCandles(60, { wobble: 0 });
  const snap = buildFeatureSnapshot("XAUUSD", flat, latestCloseIso(flat)!);
  assert.equal(snap.available, false);
});

// ── Anchor helpers ──────────────────────────────────────────────────────────

test("latestCloseIso anchors to the newest bar's CLOSE; refuses without an interval", () => {
  const candles = mkCandles(3);
  assert.equal(latestCloseIso(candles), new Date(T0 + 2 * M1 + M1).toISOString());
  assert.equal(latestCloseIso([]), null);
  assert.equal(latestCloseIso(mkCandles(1)), null); // interval unknowable from one bar
  assert.equal(inferBarMinutes(candles), 1);
});

// ── 4. Scanner attachment ───────────────────────────────────────────────────

const scannerSource = readFileSync(
  fileURLToPath(new URL("../../marketScanner.ts", import.meta.url)),
  "utf8",
);

test("scanner computes the snapshot from the SAME routed window the regime consumes (source proof)", () => {
  assert.ok(
    scannerSource.includes("const featureCandles = routed?.regimeCandles ?? []"),
    "feature snapshot must consume the already-fetched regime window — never a second fetch",
  );
  assert.ok(
    scannerSource.includes("buildFeatureSnapshot(sym, featureCandles, featureAsOf)"),
    "scanner must call the shared adapter once per symbol scan",
  );
  // The snapshot rides the opportunity payload beside the regime verdict.
  const opLiteral = scannerSource.indexOf("regime,\n      featureSnapshot,");
  assert.ok(opLiteral !== -1, "featureSnapshot must ride the op literal beside regime");
  assert.ok(scannerSource.includes("featureSnapshot?: FeatureSnapshot;"));
});

test("attaching a snapshot changes NO score and NO final read (additive-only pin)", () => {
  const candles = mkCandles(60);
  const snap = buildFeatureSnapshot("EURUSD", candles, latestCloseIso(candles)!);
  const bare = scannerOpp();
  const stamped = scannerOpp({ featureSnapshot: snap });
  assert.deepEqual(computeFinalRead(stamped), computeFinalRead(bare));
  assert.equal(effectiveOpportunityScore(stamped), effectiveOpportunityScore(bare));
});

// ── 5. Shadow stamping ──────────────────────────────────────────────────────

test("createShadowDecision stamps featureSetId + snapshot from its own candles (behavioral)", () => {
  // The in-memory simulator seeds 60 one-minute bars at construction, so this
  // runs offline. Its candles are SYNTHETIC — the stamp records assumptions,
  // while provenance stays SYNTHETIC_SIMULATOR_SOURCE on the persisted row.
  const d = createShadowDecision("EURUSD", "M15");
  assert.ok(d, "seeded simulator candles must yield a shadow decision");
  assert.equal(d.featureSetId, FEATURE_SET_ID);
  assert.ok(d.featureSnapshot, "decision must carry its feature snapshot");
  const snap = d.featureSnapshot as FeatureSnapshot;
  assert.equal(snap.featureSetId, FEATURE_SET_ID);
  assert.equal(snap.available, true);
  if (snap.available) {
    assert.ok((snap.features.expectedMoveSigma1min ?? 0) > 0);
    // asOf anchors to the newest simulator bar's close — a data-derived
    // instant, so the persisted snapshot is replayable from the bars alone.
    assert.equal(snap.computedAt, snap.features.asOfIso);
  }
});

test("shapeShadowDecisionRow persists the stamp verbatim; unstamped rows persist null", () => {
  const candles = mkCandles(60);
  const snap = buildFeatureSnapshot("EURUSD", candles, latestCloseIso(candles)!);
  const base: ShadowDecision = {
    id: "sh_test_1", ts: "2026-08-19T10:00:00.000Z", symbol: "EURUSD", tf: "M15",
    strategy: "Trend Continuation", marketCondition: "TRENDING", action: "BUY",
    entry: 1.1, sl: 1.09, tp: 1.12, confidence: 70, opportunity: 70, sniper: 65,
    grade: 7, riskGovernor: { approved: true, level: "LOW", hardBlocks: [], warnings: [] },
    reason: "test", reasonToAvoid: "", status: "SHADOW_TRACKING_OUTCOME",
    expiresAt: "2026-08-19T10:05:00.000Z", dataSource: "SHADOW",
    featureSetId: FEATURE_SET_ID, featureSnapshot: snap,
  };
  const row = shapeShadowDecisionRow(base, "SYNTHETIC_SIMULATOR");
  assert.equal(row.featureSetId, FEATURE_SET_ID);
  assert.ok(row.featureSnapshot, "snapshot column must be populated");
  assert.deepEqual(JSON.parse(row.featureSnapshot as string), JSON.parse(JSON.stringify(snap)));

  // Pre-R7 / unstamped decision ⇒ honest nulls, never a fabricated default.
  const unstamped: ShadowDecision = { ...base, id: "sh_test_2" };
  delete unstamped.featureSetId;
  delete unstamped.featureSnapshot;
  const bareRow = shapeShadowDecisionRow(unstamped, "SYNTHETIC_SIMULATOR");
  assert.equal(bareRow.featureSetId, null);
  assert.equal(bareRow.featureSnapshot, null);
});

test("shadowMode stamps via the shared adapter (source proof)", () => {
  const shadowSource = readFileSync(
    fileURLToPath(new URL("../../shadowMode.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(shadowSource.includes("buildFeatureSnapshot(symbol, candles, featureAsOf)"));
  assert.ok(shadowSource.includes("featureSetId: FEATURE_SET_ID"));
  const persistenceSource = readFileSync(
    fileURLToPath(new URL("../../shadowPersistence.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(persistenceSource.includes("featureSetId:    d.featureSetId ?? null"));
  assert.ok(
    persistenceSource.includes(
      "featureSnapshot: d.featureSnapshot ? JSON.stringify(d.featureSnapshot) : null",
    ),
  );
});
