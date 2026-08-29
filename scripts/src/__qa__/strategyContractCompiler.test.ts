// Capability #13 — Strategy constitution compiler test suite.
//
// Proves, offline and deterministically:
//   1. EXTRACTION: the declarative contracts for london-breakout and
//      trend-continuation are replay-EQUIVALENT to the hand-written engines
//      over frozen fixture datasets — including frames where the correct
//      answer is "stay silent".
//   2. LOUDNESS: every way an engine can drift from its contract (emitting
//      where forbidden, staying silent where the contract emits, flipping
//      direction, dropping the stop, widening the take-profit) produces a
//      MISMATCH verdict with an exact frame-level inventory — never a
//      silent preference for either side.
//   3. GENERATION: the compiler generates one invariant test per contract
//      rule plus universal structural invariants, and those generated tests
//      catch hand-built violating results.
//   4. FAIL-CLOSED: unknown features never satisfy a rule — a frame whose
//      features cannot be computed decides NO_EMIT with typed reasons, and
//      an emission under unknown eligibility is a violation.
//
// Run: pnpm --filter @workspace/scripts run test:strategy-contract-compiler

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  londonBreakoutStrategy,
  trendContinuationStrategy,
  noSignal,
  type Strategy,
  type StrategyInput,
  type StrategyResult,
} from "@workspace/domain/strategies";
import {
  compileContract,
  decideFromContract,
  londonBreakoutContract,
  trendContinuationContract,
  CONTRACT_REGISTRY,
  CONTRACT_BY_STRATEGY_NAME,
  isTradeSignal,
} from "@workspace/domain/strategy-factory";
import {
  londonBreakoutDataset,
  trendContinuationDataset,
  LONDON_EMIT_FRAMES,
  TREND_EMIT_FRAMES,
} from "./strategyFactoryFixtures";

// ── 1. Replay equivalence of the extracted contracts ────────────────────────

test("london-breakout: contract is replay-equivalent to the hand-written engine", () => {
  const dataset = londonBreakoutDataset();
  const compiled = compileContract(londonBreakoutContract);
  const report = compiled.replayEquivalence(londonBreakoutStrategy, dataset.frames);

  assert.equal(report.verdict, "EQUIVALENT",
    `mismatches: ${JSON.stringify(report.mismatches, null, 2)} reasons: ${report.reasons.join("; ")}`);
  assert.equal(report.framesEvaluated, 16);
  assert.equal(report.agreements, 16);
  assert.equal(report.engineEmissions, LONDON_EMIT_FRAMES.length);
  assert.equal(report.contractEmissions, LONDON_EMIT_FRAMES.length);

  // Pin WHICH frames emit — the fixture is meaningful only if the breakout
  // frames actually trade and the pre-breakout frames actually wait.
  dataset.frames.forEach((input, i) => {
    const r = londonBreakoutStrategy.evaluate(input);
    assert.equal(isTradeSignal(r.signal), LONDON_EMIT_FRAMES.includes(i),
      `frame ${i} (${input.now.toISOString()}) emission expectation`);
    if (isTradeSignal(r.signal)) assert.equal(r.signal.direction, "BUY");
  });
});

test("trend-continuation: contract is replay-equivalent to the hand-written engine", () => {
  const dataset = trendContinuationDataset();
  const compiled = compileContract(trendContinuationContract);
  const report = compiled.replayEquivalence(trendContinuationStrategy, dataset.frames);

  assert.equal(report.verdict, "EQUIVALENT",
    `mismatches: ${JSON.stringify(report.mismatches, null, 2)} reasons: ${report.reasons.join("; ")}`);
  assert.equal(report.framesEvaluated, 100);
  assert.equal(report.engineEmissions, TREND_EMIT_FRAMES.length);
  assert.equal(report.contractEmissions, TREND_EMIT_FRAMES.length);

  dataset.frames.forEach((input, i) => {
    const r = trendContinuationStrategy.evaluate(input);
    assert.equal(isTradeSignal(r.signal), TREND_EMIT_FRAMES.includes(i),
      `frame ${i} emission expectation`);
    if (isTradeSignal(r.signal)) assert.equal(r.signal.direction, "BUY");
  });
});

// ── 2. Drift is LOUD ────────────────────────────────────────────────────────

function wrap(base: Strategy, mutate: (input: StrategyInput, r: StrategyResult) => StrategyResult): Strategy {
  return { ...base, evaluate: (input) => mutate(input, base.evaluate(input)) };
}

test("mutant emitting where the contract forbids => MISMATCH with ENGINE_EMITS_CONTRACT_FORBIDS", () => {
  const dataset = londonBreakoutDataset();
  const compiled = compileContract(londonBreakoutContract);
  const mutant = wrap(londonBreakoutStrategy, (_input, r) => {
    if (r.emitted) return r;
    return {
      strategyName: r.strategyName,
      emitted: true,
      signal: { action: "BUY", direction: "BUY", entry: 1.1005, stopLoss: 1.0995, takeProfit: 1.102, confidence: 70, reasons: ["mutant"] },
      rejectedReasons: [],
    };
  });
  const report = compiled.replayEquivalence(mutant, dataset.frames);
  assert.equal(report.verdict, "MISMATCH");
  const kinds = new Set(report.mismatches.map((m) => m.kind));
  assert.ok(kinds.has("ENGINE_EMITS_CONTRACT_FORBIDS"), [...kinds].join(","));
  // Exact inventory: every non-emit frame is reported.
  const forbidden = report.mismatches.filter((m) => m.kind === "ENGINE_EMITS_CONTRACT_FORBIDS");
  assert.equal(forbidden.length, 16 - LONDON_EMIT_FRAMES.length);
});

test("mutant silent where the contract emits => MISMATCH with ENGINE_SILENT_WHERE_CONTRACT_EMITS", () => {
  const dataset = londonBreakoutDataset();
  const compiled = compileContract(londonBreakoutContract);
  const mutant = wrap(londonBreakoutStrategy, () => noSignal("london-breakout", "mutant refuses"));
  const report = compiled.replayEquivalence(mutant, dataset.frames);
  assert.equal(report.verdict, "MISMATCH");
  const silent = report.mismatches.filter((m) => m.kind === "ENGINE_SILENT_WHERE_CONTRACT_EMITS");
  assert.equal(silent.length, LONDON_EMIT_FRAMES.length);
  assert.deepEqual(silent.map((m) => m.frameIndex), LONDON_EMIT_FRAMES);
});

test("mutant flipping direction => MISMATCH", () => {
  const dataset = londonBreakoutDataset();
  const compiled = compileContract(londonBreakoutContract);
  const mutant = wrap(londonBreakoutStrategy, (_input, r) => {
    if (!isTradeSignal(r.signal)) return r;
    const s = r.signal;
    const flipped = s.direction === "BUY" ? "SELL" as const : "BUY" as const;
    return { ...r, signal: { ...s, action: flipped, direction: flipped } };
  });
  const report = compiled.replayEquivalence(mutant, dataset.frames);
  assert.equal(report.verdict, "MISMATCH");
  assert.ok(report.mismatches.some((m) => m.kind === "INVARIANT_VIOLATION"
    && m.details.some((d) => d.includes("direction-matches-contract"))));
});

test("mutant dropping the stop => MISMATCH via generated stop-required invariant", () => {
  const dataset = londonBreakoutDataset();
  const compiled = compileContract(londonBreakoutContract);
  const mutant = wrap(londonBreakoutStrategy, (_input, r) => {
    if (!isTradeSignal(r.signal)) return r;
    return { ...r, signal: { ...r.signal, stopLoss: null } };
  });
  const report = compiled.replayEquivalence(mutant, dataset.frames);
  assert.equal(report.verdict, "MISMATCH");
  assert.ok(report.mismatches.some((m) => m.kind === "INVARIANT_VIOLATION"
    && m.details.some((d) => d.includes("stop-required"))));
});

test("mutant widening the take-profit => MISMATCH via contract exit rule", () => {
  const dataset = londonBreakoutDataset();
  const compiled = compileContract(londonBreakoutContract);
  const mutant = wrap(londonBreakoutStrategy, (_input, r) => {
    if (!isTradeSignal(r.signal)) return r;
    const s = r.signal;
    const entry = s.entry;
    const tp = s.takeProfit;
    if (entry === null || tp === null) return r;
    const widened = entry + (tp - entry) * 2; // 3.0× range instead of 1.5×
    return { ...r, signal: { ...s, takeProfit: widened } };
  });
  const report = compiled.replayEquivalence(mutant, dataset.frames);
  assert.equal(report.verdict, "MISMATCH");
  assert.ok(report.mismatches.some((m) => m.kind === "INVARIANT_VIOLATION"
    && m.details.some((d) => d.includes("tp-1p5x-asia-range"))));
});

test("version drift between engine and contract is reported", () => {
  const dataset = londonBreakoutDataset();
  const compiled = compileContract(londonBreakoutContract);
  const bumped: Strategy = { ...londonBreakoutStrategy, version: "9.9.9" };
  const report = compiled.replayEquivalence(bumped, dataset.frames);
  assert.equal(report.verdict, "MISMATCH");
  assert.ok(report.reasons.some((r) => r.includes("STRATEGY_VERSION_MISMATCH")));
});

// ── 3. Generated invariant tests ────────────────────────────────────────────

test("compiler generates one invariant test per contract rule plus structural invariants", () => {
  for (const contract of CONTRACT_REGISTRY) {
    const compiled = compileContract(contract);
    const ids = compiled.invariantTests.map((t) => t.testId);
    for (const nr of contract.eligibility) assert.ok(ids.includes(`${contract.contractId}/eligibility/${nr.id}`));
    for (const nr of contract.invalidation) assert.ok(ids.includes(`${contract.contractId}/invalidation/${nr.id}`));
    for (const nr of contract.exit.rules) assert.ok(ids.includes(`${contract.contractId}/exit/${nr.id}`));
    assert.ok(ids.includes(`${contract.contractId}/structural/stop-required`));
    assert.ok(ids.includes(`${contract.contractId}/structural/confidence-bounds`));
    assert.ok(ids.includes(`${contract.contractId}/structural/direction-matches-contract`));
    // No duplicate ids
    assert.equal(new Set(ids).size, ids.length);
  }
});

test("generated invariants catch a hand-built violating result", () => {
  const dataset = londonBreakoutDataset();
  const compiled = compileContract(londonBreakoutContract);
  const input = dataset.frames[LONDON_EMIT_FRAMES[0]];
  const violating: StrategyResult = {
    strategyName: "london-breakout",
    emitted: true,
    signal: {
      action: "BUY", direction: "BUY",
      entry: 1.1015,
      stopLoss: 1.1016,        // stop on the WRONG side of entry
      takeProfit: 1.1016,      // tp not 1.5× range
      confidence: 99,          // outside [40, 95]
      reasons: [],
    },
    rejectedReasons: [],
  };
  const violations = compiled.checkResult(input, violating);
  const ids = violations.map((v) => v.testId);
  assert.ok(ids.some((id) => id.includes("structural/stop-required")), ids.join("\n"));
  assert.ok(ids.some((id) => id.includes("structural/confidence-bounds")), ids.join("\n"));
  assert.ok(ids.some((id) => id.includes("exit/tp-1p5x-asia-range")), ids.join("\n"));
  // And the compliant engine output on the same frame passes cleanly.
  const clean = compiled.checkResult(input, londonBreakoutStrategy.evaluate(input));
  assert.deepEqual(clean, []);
});

// ── 4. Fail-closed on unknown features ──────────────────────────────────────

test("a frame with uncomputable features decides NO_EMIT with typed reasons — never a guess", () => {
  const dataset = londonBreakoutDataset();
  const rich = dataset.frames[0];
  const bare: StrategyInput = {
    ...rich,
    candles: [], // nothing recorded — Asia range, SMA, closes all uncomputable
  };
  for (const contract of CONTRACT_REGISTRY) {
    const d = decideFromContract(contract, bare);
    assert.equal(d.decision, "NO_EMIT");
    assert.ok(d.reasons.length > 0);
  }
  // London contract specifically: the Asia-range features are UNKNOWN, and
  // that unknown-ness is carried as a typed reason, not coerced to a value.
  const d = decideFromContract(londonBreakoutContract, bare);
  assert.ok(d.unknownFeatures.length > 0, JSON.stringify(d));
  assert.ok(d.reasons.some((r) => r.includes("fail closed")), d.reasons.join("; "));
});

test("emission under unknown eligibility is itself a violation", () => {
  const dataset = londonBreakoutDataset();
  const compiled = compileContract(londonBreakoutContract);
  const bare: StrategyInput = { ...dataset.frames[0], candles: [] };
  const emitted: StrategyResult = {
    strategyName: "london-breakout",
    emitted: true,
    signal: { action: "BUY", direction: "BUY", entry: 1.1, stopLoss: 1.099, takeProfit: 1.102, confidence: 70, reasons: [] },
    rejectedReasons: [],
  };
  const violations = compiled.checkResult(bare, emitted);
  assert.ok(violations.some((v) => v.detail.includes("unknown")
    || v.detail.includes("unreadable")), JSON.stringify(violations));
});

// ── Registry wiring ─────────────────────────────────────────────────────────

test("contract registry maps strategy names and matches engine identities", () => {
  assert.equal(CONTRACT_BY_STRATEGY_NAME["london-breakout"], londonBreakoutContract);
  assert.equal(CONTRACT_BY_STRATEGY_NAME["trend-continuation"], trendContinuationContract);
  assert.equal(londonBreakoutContract.strategyVersion, londonBreakoutStrategy.version);
  assert.equal(trendContinuationContract.strategyVersion, trendContinuationStrategy.version);
});
