// Capability #11 — market ecology engine: competing behavioral hypotheses.
//
// Locked here:
//   * Four behavioral hypotheses (momentum participation, two-sided liquidity,
//     forced movement, mean-reversion pressure) scored probabilistically from
//     real candle features.
//   * VALIDATED ON HISTORICAL FIXTURES: each hypothesis must outrank every
//     rival on ≥ 60% of ≥ 8 labeled fixture windows before it may carry a
//     probability. Held-out windows (fresh seeds) must still rank the true
//     behavior dominant.
//   * UNVALIDATED CONTRIBUTES NOTHING: an unvalidated hypothesis reports
//     probability null and is excluded from the normalization; zero validated
//     hypotheses → NO_VALIDATED_HYPOTHESES; thin candles → INSUFFICIENT_DATA.
//     Never a guess.
//
// Run: pnpm --filter @workspace/api-server run test:market-ecology

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ECOLOGY_HYPOTHESES,
  MIN_ECOLOGY_CANDLES,
  readMarketEcology,
  validateEcologyHypotheses,
  validateEcologyHypothesis,
  type EcologyCandle,
  type EcologyHypothesisId,
  type EcologyValidationRecord,
  type LabeledEcologyFixture,
} from "@workspace/domain/market-ecology";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const BARS = 40;

/** Momentum: persistent one-directional pressure, directional bodies. */
function momentumFixture(seed: number): EcologyCandle[] {
  const rnd = lcg(seed);
  const out: EcologyCandle[] = [];
  let p = 100;
  for (let i = 0; i < BARS; i++) {
    const r = 0.004 + (rnd() - 0.5) * 0.001; // always positive drift
    const open = p;
    const close = open * (1 + r);
    out.push({ open, high: close * 1.0002, low: open * 0.9998, close });
    p = close;
  }
  return out;
}

/** Two-sided liquidity: tiny bodies, symmetric wicks, bounded range. */
function twoSidedFixture(seed: number): EcologyCandle[] {
  const rnd = lcg(seed);
  const out: EcologyCandle[] = [];
  let p = 100;
  for (let i = 0; i < BARS; i++) {
    const open = p;
    const close = open * (1 + (rnd() - 0.5) * 0.0004); // ~no net movement
    const wick = open * 0.004;
    out.push({
      open,
      close,
      high: Math.max(open, close) + wick,
      low: Math.min(open, close) - wick,
    });
    p = close;
  }
  return out;
}

/** Forced movement: accelerating sweep bars — growing ranges, extreme closes,
 *  long one-sided wicks, direction chosen by coin flip (no clean drift). */
function forcedFixture(seed: number): EcologyCandle[] {
  const rnd = lcg(seed);
  const out: EcologyCandle[] = [];
  let p = 100;
  for (let i = 0; i < BARS; i++) {
    const open = p;
    const range = 0.2 * Math.pow(1.12, i); // accelerating cascade
    const up = rnd() > 0.5;
    let high: number, low: number, close: number;
    if (up) {
      // swept the downside, closed pinned at the top
      low = open - range * 0.9;
      high = open + range * 0.1;
      close = open + range * 0.05;
    } else {
      high = open + range * 0.9;
      low = open - range * 0.1;
      close = open - range * 0.05;
    }
    out.push({ open, high, low, close });
    p = close;
  }
  return out;
}

/** Mean-reversion pressure: alternating fades, high sign-flip rate. */
function meanRevFixture(seed: number): EcologyCandle[] {
  const rnd = lcg(seed);
  const out: EcologyCandle[] = [];
  let p = 100;
  for (let i = 0; i < BARS; i++) {
    const mag = 0.003 + (rnd() - 0.5) * 0.0005;
    const r = i % 2 === 0 ? mag : -mag; // strict alternation
    const open = p;
    const close = open * (1 + r);
    out.push({ open, high: Math.max(open, close) * 1.0001, low: Math.min(open, close) * 0.9999, close });
    p = close;
  }
  return out;
}

const GENERATORS: Record<EcologyHypothesisId, (seed: number) => EcologyCandle[]> = {
  MOMENTUM_PARTICIPATION: momentumFixture,
  TWO_SIDED_LIQUIDITY: twoSidedFixture,
  FORCED_MOVEMENT: forcedFixture,
  MEAN_REVERSION_PRESSURE: meanRevFixture,
};

function fixtureLibrary(seedBase: number, perLabel: number): LabeledEcologyFixture[] {
  const out: LabeledEcologyFixture[] = [];
  for (const label of ECOLOGY_HYPOTHESES) {
    for (let i = 0; i < perLabel; i++) {
      out.push({ label, candles: GENERATORS[label](seedBase + i * 17 + label.length) });
    }
  }
  return out;
}

// ── Validation on historical fixtures ───────────────────────────────────────

test("all four hypotheses VALIDATE on their labeled fixture library", () => {
  const validations = validateEcologyHypotheses(fixtureLibrary(1000, 10));
  for (const h of ECOLOGY_HYPOTHESES) {
    const v = validations[h];
    assert.equal(v.status, "VALIDATED", `${h}: ${JSON.stringify(v)}`);
    if (v.status === "VALIDATED") {
      assert.ok(v.hitRate >= 0.6);
      assert.equal(v.fixtures, 10);
    }
  }
});

test("too few labeled fixtures → UNVALIDATED with the honest reason", () => {
  const v = validateEcologyHypothesis(
    "MOMENTUM_PARTICIPATION",
    fixtureLibrary(2000, 3),
  );
  assert.equal(v.status, "UNVALIDATED");
  if (v.status === "UNVALIDATED") assert.match(v.reason, /fixtures < required/);
});

test("a hypothesis that cannot outrank rivals on its own labels is UNVALIDATED", () => {
  // Label two-sided windows as FORCED_MOVEMENT — the scorer must NOT validate
  // against evidence that contradicts it.
  const mislabeled: LabeledEcologyFixture[] = Array.from({ length: 10 }, (_, i) => ({
    label: "FORCED_MOVEMENT" as const,
    candles: twoSidedFixture(3000 + i),
  }));
  const v = validateEcologyHypothesis("FORCED_MOVEMENT", mislabeled);
  assert.equal(v.status, "UNVALIDATED");
  if (v.status === "UNVALIDATED") assert.match(v.reason, /hit rate/);
});

// ── Held-out probabilistic reads ────────────────────────────────────────────

test("held-out windows rank the true behavioral hypothesis dominant", () => {
  const validations = validateEcologyHypotheses(fixtureLibrary(1000, 10));
  for (const truth of ECOLOGY_HYPOTHESES) {
    const read = readMarketEcology(GENERATORS[truth](99_991), validations);
    assert.equal(read.status, "OK", `${truth}: ${JSON.stringify(read)}`);
    if (read.status === "OK") {
      assert.equal(read.dominant, truth, `expected ${truth}, got ${read.dominant}`);
      assert.ok(read.dominantProbability > 1 / ECOLOGY_HYPOTHESES.length);
      // Probabilities over validated hypotheses sum to 1.
      const sum = read.readings
        .filter((r) => r.probability !== null)
        .reduce((a, r) => a + (r.probability as number), 0);
      assert.ok(Math.abs(sum - 1) < 1e-9);
    }
  }
});

// ── UNVALIDATED contributes nothing ─────────────────────────────────────────

function unvalidated(h: EcologyHypothesisId): EcologyValidationRecord {
  return { status: "UNVALIDATED", hypothesis: h, fixtures: 0, reason: "no validation data" };
}

test("an UNVALIDATED hypothesis reports probability null and is excluded from normalization", () => {
  const validations = validateEcologyHypotheses(fixtureLibrary(1000, 10));
  const partial = { ...validations, FORCED_MOVEMENT: unvalidated("FORCED_MOVEMENT") };
  const read = readMarketEcology(forcedFixture(5555), partial);
  assert.equal(read.status, "OK");
  if (read.status === "OK") {
    const forced = read.readings.find((r) => r.hypothesis === "FORCED_MOVEMENT")!;
    assert.equal(forced.status, "UNVALIDATED");
    assert.equal(forced.probability, null); // contributes NOTHING — never a guess
    assert.ok(forced.evidenceScore01 >= 0); // raw evidence still journaled
    assert.equal(read.validatedCount, 3);
    const sum = read.readings
      .filter((r) => r.probability !== null)
      .reduce((a, r) => a + (r.probability as number), 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
  }
});

test("zero validated hypotheses → NO_VALIDATED_HYPOTHESES, all probabilities null", () => {
  const none = {
    MOMENTUM_PARTICIPATION: unvalidated("MOMENTUM_PARTICIPATION"),
    TWO_SIDED_LIQUIDITY: unvalidated("TWO_SIDED_LIQUIDITY"),
    FORCED_MOVEMENT: unvalidated("FORCED_MOVEMENT"),
    MEAN_REVERSION_PRESSURE: unvalidated("MEAN_REVERSION_PRESSURE"),
  };
  const read = readMarketEcology(momentumFixture(777), none);
  assert.equal(read.status, "NO_VALIDATED_HYPOTHESES");
  if (read.status === "NO_VALIDATED_HYPOTHESES") {
    assert.ok(read.readings.every((r) => r.probability === null));
  }
});

test("insufficient candles → INSUFFICIENT_DATA, never a read", () => {
  const validations = validateEcologyHypotheses(fixtureLibrary(1000, 10));
  const read = readMarketEcology(momentumFixture(1).slice(0, MIN_ECOLOGY_CANDLES - 1), validations);
  assert.equal(read.status, "INSUFFICIENT_DATA");
});
