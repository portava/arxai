// Pattern Sync engine + comparator determinism / honesty contract.
// Pure deterministic structural analyzer — ADVISORY ONLY, never an execution
// path. These tests lock: honest-empty on insufficient candles, bias detection,
// countertrend open-trade warnings, leader/follower/lagging ranking, H4/M15
// disagreement handling, match scoring, and byte-identical determinism.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

import {
  runPatternSyncEngine,
  patternMatchScore,
  PATTERN_SYNC_MIN_CANDLES,
  type PatternSyncCandle,
} from "../patternSyncEngine.js";
import { comparePatternSync, type PatternSyncSymbolInput } from "../patternSyncComparator.js";

function candlesFromCloses(closes: number[]): PatternSyncCandle[] {
  return closes.map((c, i) => {
    const open = i === 0 ? c : closes[i - 1]!;
    const span = Math.abs(c - open);
    return {
      time: i,
      open,
      high: Math.max(open, c) + span * 0.1 + 0.2,
      low: Math.min(open, c) - span * 0.1 - 0.2,
      close: c,
    };
  });
}

// Rising structure with pullbacks => ascending swing highs AND lows (HH/HL).
function bullishWithPullbacks(legs = 6, endDeepPullback = false): PatternSyncCandle[] {
  const closes: number[] = [];
  let base = 100;
  for (let leg = 0; leg < legs; leg++) {
    for (let k = 1; k <= 4; k++) closes.push(base + k * 3);
    base += 12;
    const pull = endDeepPullback && leg === legs - 1 ? 9 : 5;
    closes.push(base - 3);
    closes.push(base - pull);
    base -= pull;
  }
  return candlesFromCloses(closes);
}

function bearishWithPullbacks(legs = 6): PatternSyncCandle[] {
  const closes: number[] = [];
  let base = 1000;
  for (let leg = 0; leg < legs; leg++) {
    for (let k = 1; k <= 4; k++) closes.push(base - k * 3);
    base -= 12;
    closes.push(base + 3);
    closes.push(base + 5);
    base += 5;
  }
  return candlesFromCloses(closes);
}

// Net-zero oscillation => low efficiency ratio => high choppiness, ranging bias.
function choppyRange(n = 36): PatternSyncCandle[] {
  const closes: number[] = [];
  for (let i = 0; i < n; i++) closes.push(100 + (i % 2 === 0 ? 6 : -6) + (i % 4 === 0 ? 1 : 0));
  return candlesFromCloses(closes);
}

describe("patternSyncEngine — honesty + bias", () => {
  it("returns honest-empty (sufficient:false) on insufficient candles", () => {
    const r = runPatternSyncEngine({
      symbol: "V75",
      timeframe: "H4",
      candles: candlesFromCloses([1, 2, 3, 4, 5]),
    });
    assert.equal(r.sufficient, false);
    assert.equal(r.detectedPatternType, "unclear");
    assert.equal(r.confidenceScore, 0);
    assert.match(r.readableSummary, new RegExp(String(PATTERN_SYNC_MIN_CANDLES)));
    assert.ok(!/guarantee|guaranteed|profit/i.test(r.readableSummary));
  });

  it("detects a bullish structure with clean HH/HL", () => {
    const r = runPatternSyncEngine({ symbol: "V75", timeframe: "H4", candles: bullishWithPullbacks() });
    assert.equal(r.sufficient, true);
    assert.equal(r.trendBias, "bullish");
    assert.equal(r.signature.swingPattern, "HH_HL");
    assert.ok(r.structureScore >= 60, `structureScore ${r.structureScore}`);
    assert.ok(!/guarantee|guaranteed|profit/i.test(r.readableSummary));
  });

  it("detects a bearish structure with clean LH/LL", () => {
    const r = runPatternSyncEngine({ symbol: "V25_1S", timeframe: "H4", candles: bearishWithPullbacks() });
    assert.equal(r.sufficient, true);
    assert.equal(r.trendBias, "bearish");
    assert.equal(r.signature.swingPattern, "LH_LL");
  });

  it("penalizes choppy V50-style structure with high choppiness + ranging bias", () => {
    const r = runPatternSyncEngine({ symbol: "V50", timeframe: "H4", candles: choppyRange() });
    assert.equal(r.trendBias, "ranging");
    assert.ok(r.choppinessScore >= 60, `choppinessScore ${r.choppinessScore}`);
    assert.ok(r.cleanSetupScore < 60, `cleanSetupScore ${r.cleanSetupScore}`);
  });

  it("marks a SELL after a bullish rally as countertrend with risk language", () => {
    const candles = bullishWithPullbacks();
    const last = candles[candles.length - 1]!.close;
    const r = runPatternSyncEngine({
      symbol: "V50_1S",
      timeframe: "H4",
      candles,
      openTrades: [{ side: "SELL", entryPrice: last }],
    });
    assert.ok(r.tradeContext);
    assert.equal(r.tradeContext!.tradeDirectionAlignment, "countertrend");
    assert.match(r.tradeContext!.saferActionSummary, /countertrend/i);
    assert.ok(!/guarantee|guaranteed|profit/i.test(r.tradeContext!.saferActionSummary));
  });

  it("honors admin-provided support/resistance override levels", () => {
    const candles = bullishWithPullbacks();
    const last = candles[candles.length - 1]!.close;
    const r = runPatternSyncEngine({
      symbol: "V75",
      timeframe: "H4",
      candles,
      supportLevels: [last - 50],
      resistanceLevels: [last + 80],
    });
    assert.equal(r.levels.nearestSupport, Math.round((last - 50) * 100) / 100);
    assert.equal(r.levels.nearestResistance, Math.round((last + 80) * 100) / 100);
  });

  it("is byte-identical deterministic for identical input", () => {
    const c = bullishWithPullbacks();
    const a = runPatternSyncEngine({ symbol: "V75", timeframe: "H4", candles: c });
    const b = runPatternSyncEngine({ symbol: "V75", timeframe: "H4", candles: c });
    assert.deepEqual(a, b);
  });
});

describe("patternMatchScore", () => {
  it("scores two same-bias bull charts as similar (>=60) and bull-vs-chop as low (<60)", () => {
    const bullA = runPatternSyncEngine({ symbol: "V75", timeframe: "H4", candles: bullishWithPullbacks() });
    const bullB = runPatternSyncEngine({ symbol: "V25_1S", timeframe: "H4", candles: bullishWithPullbacks(5) });
    const chop = runPatternSyncEngine({ symbol: "V50", timeframe: "H4", candles: choppyRange() });
    assert.ok(patternMatchScore(bullA, bullB) >= 60, `bull-bull ${patternMatchScore(bullA, bullB)}`);
    assert.ok(patternMatchScore(bullA, chop) < 60, `bull-chop ${patternMatchScore(bullA, chop)}`);
  });
});

describe("patternSyncComparator — leader/follower/lagging", () => {
  function eng(symbol: string, candles: PatternSyncCandle[], tf = "H4") {
    return runPatternSyncEngine({ symbol, timeframe: tf, candles });
  }

  it("returns honest-empty comparison when all inputs are insufficient", () => {
    const thin = candlesFromCloses([1, 2, 3]);
    const cmp = comparePatternSync([
      { symbol: "V75", h4: eng("V75", thin) },
      { symbol: "V50", h4: eng("V50", thin) },
    ]);
    assert.equal(cmp.sufficient, false);
    assert.equal(cmp.leaderSymbol, null);
  });

  it("ranks the cleanest bull chart as leader and a choppy chart as not-leader", () => {
    const leader: PatternSyncSymbolInput = { symbol: "V75", h4: eng("V75", bullishWithPullbacks(7)) };
    const follower: PatternSyncSymbolInput = { symbol: "V25_1S", h4: eng("V25_1S", bullishWithPullbacks(5, true)) };
    const chopper: PatternSyncSymbolInput = { symbol: "V50", h4: eng("V50", choppyRange()) };
    const cmp = comparePatternSync([leader, follower, chopper], { timeframe: "H4" });

    assert.equal(cmp.sufficient, true);
    assert.notEqual(cmp.leaderSymbol, "V50");
    assert.equal(cmp.choppiestSymbol, "V50");
    const chopRow = cmp.rows.find((r) => r.symbol === "V50")!;
    assert.equal(chopRow.status, "Choppy");
    assert.ok(!/guarantee|guaranteed|profit/i.test(cmp.readableSummary));
  });

  it("flags H4/M15 disagreement as not_aligned + countertrend entry quality", () => {
    const h4 = eng("V75", bullishWithPullbacks());
    const m15 = eng("V75", bearishWithPullbacks(), "M15");
    const cmp = comparePatternSync([{ symbol: "V75", h4, m15 }], { timeframe: "H4" });
    const row = cmp.rows.find((r) => r.symbol === "V75")!;
    assert.equal(row.h4m15Alignment, "not_aligned");
    assert.equal(row.entryQuality, "countertrend");
  });

  it("is deterministic for identical comparison input", () => {
    const inputs: PatternSyncSymbolInput[] = [
      { symbol: "V75", h4: eng("V75", bullishWithPullbacks(7)) },
      { symbol: "V50", h4: eng("V50", choppyRange()) },
    ];
    const fixedNow = new Date("2026-01-01T00:00:00.000Z");
    const a = comparePatternSync(inputs, { timeframe: "H4", now: fixedNow });
    const b = comparePatternSync(inputs, { timeframe: "H4", now: fixedNow });
    assert.deepEqual(a, b);
  });
});

// ── Single-source lock (Task #758) ──────────────────────────────────────────
//
// Task #751's separate shared Pattern Sync engine was never merged into this
// environment, so the admin-cockpit engine in lib/patternSync/ is the ONE
// canonical implementation. There is nothing to "reconcile" against because no
// second engine exists. These structural tests LOCK that single-source +
// advisory-containment outcome so a divergent copy can never silently reappear:
//   1. exactly one definition of runPatternSyncEngine / comparePatternSync,
//      both inside lib/patternSync/;
//   2. the only api-server consumer of the engine is the admin-cockpit route
//      (advisory, admin/owner-gated) — it never leaks into another backend
//      surface or any execution path.

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PATTERN_SYNC_DIR = join(SRC_ROOT, "lib", "patternSync");
const ADMIN_COCKPIT_ROUTE = join(SRC_ROOT, "routes", "adminCockpit.ts");

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...walkTs(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("Pattern Sync single-source lock (Task #758)", () => {
  const sourceFiles = walkTs(SRC_ROOT).filter(
    (f) => !/\.test\.tsx?$/.test(f),
  );

  it("defines runPatternSyncEngine exactly once, inside lib/patternSync/", () => {
    const defs = sourceFiles.filter((f) =>
      /export\s+function\s+runPatternSyncEngine\b/.test(readFileSync(f, "utf8")),
    );
    assert.equal(
      defs.length,
      1,
      `expected one runPatternSyncEngine definition, found: ${defs
        .map((f) => relative(SRC_ROOT, f))
        .join(", ")}`,
    );
    assert.ok(defs[0]!.startsWith(PATTERN_SYNC_DIR + sep));
  });

  it("defines comparePatternSync exactly once, inside lib/patternSync/", () => {
    const defs = sourceFiles.filter((f) =>
      /export\s+function\s+comparePatternSync\b/.test(readFileSync(f, "utf8")),
    );
    assert.equal(
      defs.length,
      1,
      `expected one comparePatternSync definition, found: ${defs
        .map((f) => relative(SRC_ROOT, f))
        .join(", ")}`,
    );
    assert.ok(defs[0]!.startsWith(PATTERN_SYNC_DIR + sep));
  });

  it("is consumed ONLY by the admin-cockpit route (no other backend surface)", () => {
    const importers = sourceFiles.filter((f) => {
      const t = readFileSync(f, "utf8");
      return (
        t.includes("lib/patternSync/") ||
        /from\s+["'][^"']*patternSync(Engine|Comparator)\.js/.test(t)
      );
    });
    // Proof is not vacuous: the admin-cockpit route must be among the importers.
    assert.ok(
      importers.some((f) => f === ADMIN_COCKPIT_ROUTE),
      "admin-cockpit route should import the Pattern Sync engine",
    );
    // Allowed consumers: the engine package itself + the admin-cockpit route.
    const offenders = importers
      .filter(
        (f) => !f.startsWith(PATTERN_SYNC_DIR + sep) && f !== ADMIN_COCKPIT_ROUTE,
      )
      .map((f) => relative(SRC_ROOT, f));
    assert.deepEqual(
      offenders,
      [],
      `Pattern Sync engine leaked into non-cockpit backend surfaces: ${JSON.stringify(offenders)}`,
    );
  });
});
