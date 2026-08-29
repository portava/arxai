import type { Strategy, StrategyInput, StrategyResult } from "../strategies/strategy.types";
import { isTradeSignal } from "./strategyContract.types";
import type {
  ContractDecision,
  ContractRule,
  ContractViolation,
  GeneratedInvariantTest,
  NamedRule,
  ReplayEquivalenceReport,
  ReplayMismatch,
  StrategyContract,
} from "./strategyContract.types";
import { readFeature } from "./contractFeatures.engine";
import type { StrategyProposedSignal } from "../strategies/strategy.types";

// ═══════════════════════════════════════════════════════════════════════════
// Contract compiler — capability #13.
//
// compileContract(contract) turns a declarative StrategyContract into:
//   1. decide(input)            — the contract's OWN decision, computed from
//                                 rules-as-data over the independent feature
//                                 library (fail-closed: any UNKNOWN feature
//                                 in an eligibility/invalidation rule ⇒
//                                 NO_EMIT with a typed reason).
//   2. invariantTests           — generated invariant tests: one per
//                                 eligibility rule ("must not emit when this
//                                 rule fails"), one per invalidation rule,
//                                 one per exit rule, plus universal
//                                 structural invariants every contract gets.
//   3. checkResult(input,result)— run every generated invariant against a
//                                 hand-written engine's actual output.
//   4. replayEquivalence(...)   — frame-by-frame agreement between the
//                                 contract's decision and the engine over a
//                                 frozen dataset. ANY disagreement ⇒ verdict
//                                 MISMATCH with an exact inventory. The
//                                 caller's test MUST fail on MISMATCH — the
//                                 report never softens a disagreement.
// ═══════════════════════════════════════════════════════════════════════════

type RuleEval =
  | { readonly outcome: "SATISFIED" }
  | { readonly outcome: "FAILED"; readonly detail: string }
  | { readonly outcome: "UNKNOWN"; readonly feature: string; readonly reason: string };

function fmt(v: unknown): string {
  return v === null ? "null" : typeof v === "string" ? v : String(v);
}

export function evaluateRule(
  rule: ContractRule,
  input: StrategyInput,
  signal: StrategyProposedSignal | null,
): RuleEval {
  const fv = readFeature(rule.feature, input, signal);

  // IS_NULL / NOT_NULL are about computed-absent values; an UNCOMPUTABLE
  // feature is still UNKNOWN, never "null".
  if (!fv.ok) return { outcome: "UNKNOWN", feature: rule.feature, reason: fv.reason };
  const v = fv.value;

  const failed = (detail: string): RuleEval => ({ outcome: "FAILED", detail });
  const sat: RuleEval = { outcome: "SATISFIED" };

  switch (rule.op) {
    case "IS_NULL": return v === null ? sat : failed(`${rule.feature}=${fmt(v)} expected null`);
    case "NOT_NULL": return v !== null ? sat : failed(`${rule.feature} is null`);
    case "EQ": return v === rule.value ? sat : failed(`${rule.feature}=${fmt(v)} expected ${fmt(rule.value)}`);
    case "NEQ": return v !== rule.value ? sat : failed(`${rule.feature}=${fmt(v)} expected ≠ ${fmt(rule.value)}`);
    case "IN":
      return v !== null && typeof v !== "boolean" && rule.values.includes(v)
        ? sat
        : failed(`${rule.feature}=${fmt(v)} not in [${rule.values.join(", ")}]`);
    case "NOT_IN":
      return v !== null && typeof v !== "boolean" && rule.values.includes(v)
        ? failed(`${rule.feature}=${fmt(v)} in forbidden [${rule.values.join(", ")}]`)
        : sat;
    case "GT": case "GTE": case "LT": case "LTE": case "APPROX": {
      if (typeof v !== "number") {
        return { outcome: "UNKNOWN", feature: rule.feature, reason: `NON_NUMERIC_VALUE_${fmt(v)}` };
      }
      switch (rule.op) {
        case "GT": return v > rule.value ? sat : failed(`${rule.feature}=${v} expected > ${rule.value}`);
        case "GTE": return v >= rule.value ? sat : failed(`${rule.feature}=${v} expected ≥ ${rule.value}`);
        case "LT": return v < rule.value ? sat : failed(`${rule.feature}=${v} expected < ${rule.value}`);
        case "LTE": return v <= rule.value ? sat : failed(`${rule.feature}=${v} expected ≤ ${rule.value}`);
        case "APPROX":
          return Math.abs(v - rule.value) <= rule.tolerance
            ? sat
            : failed(`${rule.feature}=${v} expected ≈ ${rule.value} ±${rule.tolerance}`);
      }
    }
  }
}

// ── The contract's own decision ─────────────────────────────────────────────
export function decideFromContract(contract: StrategyContract, input: StrategyInput): ContractDecision {
  const reasons: string[] = [];
  const unknownFeatures: string[] = [];
  let emit = true;

  for (const nr of contract.eligibility) {
    const e = evaluateRule(nr.rule, input, null);
    if (e.outcome === "SATISFIED") continue;
    emit = false;
    if (e.outcome === "FAILED") reasons.push(`ELIGIBILITY_FAILED ${nr.id}: ${e.detail}`);
    else {
      unknownFeatures.push(`${e.feature}:${e.reason}`);
      reasons.push(`ELIGIBILITY_UNKNOWN ${nr.id}: feature ${e.feature} unreadable (${e.reason}) — fail closed`);
    }
  }

  for (const nr of contract.invalidation) {
    const e = evaluateRule(nr.rule, input, null);
    if (e.outcome === "FAILED") continue; // invalidation NOT triggered
    emit = false;
    if (e.outcome === "SATISFIED") reasons.push(`INVALIDATION_TRIGGERED ${nr.id}: ${nr.describe}`);
    else {
      unknownFeatures.push(`${e.feature}:${e.reason}`);
      reasons.push(`INVALIDATION_UNKNOWN ${nr.id}: feature ${e.feature} unreadable (${e.reason}) — fail closed`);
    }
  }

  if (!emit) return { decision: "NO_EMIT", direction: null, reasons, unknownFeatures };

  const dirV = readFeature(contract.directionFeature, input, null);
  if (!dirV.ok) {
    unknownFeatures.push(`${contract.directionFeature}:${dirV.reason}`);
    return {
      decision: "NO_EMIT", direction: null,
      reasons: [`DIRECTION_UNKNOWN ${contract.directionFeature} unreadable (${dirV.reason}) — fail closed`],
      unknownFeatures,
    };
  }
  if (dirV.value !== "BUY" && dirV.value !== "SELL") {
    return {
      decision: "NO_EMIT", direction: null,
      reasons: [`NO_DIRECTION ${contract.directionFeature}=${fmt(dirV.value)}`],
      unknownFeatures,
    };
  }
  return { decision: "EMIT", direction: dirV.value, reasons: ["ALL_ELIGIBILITY_RULES_SATISFIED"], unknownFeatures };
}

// ── Generated invariant tests ───────────────────────────────────────────────
function eligibilityInvariant(contract: StrategyContract, nr: NamedRule): GeneratedInvariantTest {
  const testId = `${contract.contractId}/eligibility/${nr.id}`;
  return {
    testId,
    describe: `must not emit a trade when eligibility rule fails: ${nr.describe}`,
    check: (input, result) => {
      if (!isTradeSignal(result.signal)) return null;
      const e = evaluateRule(nr.rule, input, result.signal);
      if (e.outcome === "SATISFIED") return null;
      const detail = e.outcome === "FAILED"
        ? e.detail
        : `feature ${e.feature} unreadable (${e.reason}) — emission with unknown eligibility is a violation`;
      return { testId, detail };
    },
  };
}

function invalidationInvariant(contract: StrategyContract, nr: NamedRule): GeneratedInvariantTest {
  const testId = `${contract.contractId}/invalidation/${nr.id}`;
  return {
    testId,
    describe: `must not emit a trade when breaker holds: ${nr.describe}`,
    check: (input, result) => {
      if (!isTradeSignal(result.signal)) return null;
      const e = evaluateRule(nr.rule, input, result.signal);
      if (e.outcome === "FAILED") return null; // breaker not triggered
      const detail = e.outcome === "SATISFIED"
        ? `breaker holds (${nr.describe}) yet the engine emitted`
        : `feature ${e.feature} unreadable (${e.reason}) — emission with unknown breaker state is a violation`;
      return { testId, detail };
    },
  };
}

function exitRuleInvariant(contract: StrategyContract, nr: NamedRule): GeneratedInvariantTest {
  const testId = `${contract.contractId}/exit/${nr.id}`;
  return {
    testId,
    describe: `emitted trade must satisfy exit invariant: ${nr.describe}`,
    check: (input, result) => {
      if (!isTradeSignal(result.signal)) return null;
      const e = evaluateRule(nr.rule, input, result.signal);
      if (e.outcome === "SATISFIED") return null;
      const detail = e.outcome === "FAILED" ? e.detail : `feature ${e.feature} unreadable (${e.reason})`;
      return { testId, detail };
    },
  };
}

function structuralInvariants(contract: StrategyContract): GeneratedInvariantTest[] {
  const id = (s: string) => `${contract.contractId}/structural/${s}`;
  const tests: GeneratedInvariantTest[] = [
    {
      testId: id("emitted-flag-consistent"),
      describe: "emitted=true iff a signal object is present",
      check: (_input, result) => {
        if (result.emitted === (result.signal !== null)) return null;
        return { testId: id("emitted-flag-consistent"), detail: `emitted=${result.emitted} but signal ${result.signal === null ? "absent" : "present"}` };
      },
    },
    {
      testId: id("action-direction-consistent"),
      describe: "trade action must equal direction; non-trade actions carry no direction",
      check: (_input, result) => {
        const s = result.signal;
        if (s === null) return null;
        if (s.action === "BUY" || s.action === "SELL") {
          if (s.direction !== s.action) {
            return { testId: id("action-direction-consistent"), detail: `action=${s.action} direction=${fmt(s.direction)}` };
          }
          return null;
        }
        return s.direction === null ? null
          : { testId: id("action-direction-consistent"), detail: `action=${s.action} carries direction=${fmt(s.direction)}` };
      },
    },
    {
      testId: id("prices-finite"),
      describe: "emitted trade prices must be finite numbers",
      check: (_input, result) => {
        const s = result.signal;
        if (!isTradeSignal(s)) return null;
        for (const [k, v] of [["entry", s.entry], ["stopLoss", s.stopLoss], ["takeProfit", s.takeProfit]] as const) {
          if (v !== null && !Number.isFinite(v)) return { testId: id("prices-finite"), detail: `${k}=${String(v)}` };
        }
        return null;
      },
    },
  ];

  if (contract.exit.stopRequired) {
    tests.push({
      testId: id("stop-required"),
      describe: "every emitted trade must carry a stop on the loss side of entry (no-stop trading is forbidden)",
      check: (input, result) => {
        const s = result.signal;
        if (!isTradeSignal(s)) return null;
        if (s.stopLoss === null || s.entry === null) {
          return { testId: id("stop-required"), detail: `stop=${fmt(s.stopLoss)} entry=${fmt(s.entry)}` };
        }
        const e = evaluateRule({ op: "EQ", feature: "stopOnLossSide", value: true }, input, s);
        if (e.outcome === "SATISFIED") return null;
        return { testId: id("stop-required"), detail: e.outcome === "FAILED" ? e.detail : `stopOnLossSide unreadable (${e.reason})` };
      },
    });
  }
  if (contract.exit.takeProfitRequired) {
    tests.push({
      testId: id("take-profit-required"),
      describe: "every emitted trade must carry a take-profit on the profit side of entry",
      check: (input, result) => {
        const s = result.signal;
        if (!isTradeSignal(s)) return null;
        if (s.takeProfit === null || s.entry === null) {
          return { testId: id("take-profit-required"), detail: `tp=${fmt(s.takeProfit)} entry=${fmt(s.entry)}` };
        }
        const e = evaluateRule({ op: "EQ", feature: "tpOnProfitSide", value: true }, input, s);
        if (e.outcome === "SATISFIED") return null;
        return { testId: id("take-profit-required"), detail: e.outcome === "FAILED" ? e.detail : `tpOnProfitSide unreadable (${e.reason})` };
      },
    });
  }

  tests.push({
    testId: id("confidence-bounds"),
    describe: `emitted confidence must lie in [${contract.confidence.min}, ${contract.confidence.max}]`,
    check: (_input, result) => {
      const s = result.signal;
      if (!isTradeSignal(s)) return null;
      if (s.confidence >= contract.confidence.min && s.confidence <= contract.confidence.max) return null;
      return { testId: id("confidence-bounds"), detail: `confidence=${s.confidence} outside [${contract.confidence.min}, ${contract.confidence.max}]` };
    },
  });

  tests.push({
    testId: id("direction-matches-contract"),
    describe: `emitted direction must equal the contract's direction feature (${contract.directionFeature})`,
    check: (input, result) => {
      const s = result.signal;
      if (!isTradeSignal(s)) return null;
      const dv = readFeature(contract.directionFeature, input, s);
      if (!dv.ok) return { testId: id("direction-matches-contract"), detail: `${contract.directionFeature} unreadable (${dv.reason})` };
      if (dv.value === s.direction) return null;
      return { testId: id("direction-matches-contract"), detail: `engine direction=${fmt(s.direction)} contract ${contract.directionFeature}=${fmt(dv.value)}` };
    },
  });

  return tests;
}

export function generateInvariantTests(contract: StrategyContract): GeneratedInvariantTest[] {
  return [
    ...structuralInvariants(contract),
    ...contract.eligibility.map((nr) => eligibilityInvariant(contract, nr)),
    ...contract.invalidation.map((nr) => invalidationInvariant(contract, nr)),
    ...contract.exit.rules.map((nr) => exitRuleInvariant(contract, nr)),
  ];
}

// ── Compiled contract ───────────────────────────────────────────────────────
export interface CompiledContract {
  readonly contract: StrategyContract;
  readonly invariantTests: GeneratedInvariantTest[];
  decide(input: StrategyInput): ContractDecision;
  checkResult(input: StrategyInput, result: StrategyResult): ContractViolation[];
  replayEquivalence(strategy: Strategy, frames: ReadonlyArray<StrategyInput>): ReplayEquivalenceReport;
}

export function compileContract(contract: StrategyContract): CompiledContract {
  const invariantTests = generateInvariantTests(contract);

  const checkResult = (input: StrategyInput, result: StrategyResult): ContractViolation[] => {
    const out: ContractViolation[] = [];
    for (const t of invariantTests) {
      const v = t.check(input, result);
      if (v !== null) out.push(v);
    }
    return out;
  };

  const replayEquivalence = (
    strategy: Strategy,
    frames: ReadonlyArray<StrategyInput>,
  ): ReplayEquivalenceReport => {
    const mismatches: ReplayMismatch[] = [];
    const reasons: string[] = [];
    let agreements = 0;
    let engineEmissions = 0;
    let contractEmissions = 0;

    if (strategy.name !== contract.strategyName) {
      reasons.push(`STRATEGY_NAME_MISMATCH engine=${strategy.name} contract=${contract.strategyName}`);
    }
    if (strategy.version !== contract.strategyVersion) {
      reasons.push(`STRATEGY_VERSION_MISMATCH engine=${strategy.version} contract=${contract.strategyVersion}`);
    }

    frames.forEach((input, frameIndex) => {
      const atIso = input.now.toISOString();
      const result = strategy.evaluate(input);
      const engineTrades = isTradeSignal(result.signal);
      const decision = decideFromContract(contract, input);
      const violations = checkResult(input, result);
      let frameAgrees = true;

      if (engineTrades) engineEmissions++;
      if (decision.decision === "EMIT") contractEmissions++;

      if (engineTrades && decision.decision === "NO_EMIT") {
        frameAgrees = false;
        mismatches.push({ frameIndex, atIso, kind: "ENGINE_EMITS_CONTRACT_FORBIDS", details: decision.reasons });
      } else if (!engineTrades && decision.decision === "EMIT") {
        frameAgrees = false;
        mismatches.push({
          frameIndex, atIso, kind: "ENGINE_SILENT_WHERE_CONTRACT_EMITS",
          details: [
            `contract expects ${fmt(decision.direction)} emission`,
            ...result.rejectedReasons.map((r) => `engine said: ${r}`),
          ],
        });
      } else if (engineTrades && decision.decision === "EMIT" && result.signal !== null
                 && result.signal.direction !== decision.direction) {
        frameAgrees = false;
        mismatches.push({
          frameIndex, atIso, kind: "DIRECTION_MISMATCH",
          details: [`engine=${fmt(result.signal.direction)} contract=${fmt(decision.direction)}`],
        });
      }

      if (violations.length > 0) {
        frameAgrees = false;
        mismatches.push({
          frameIndex, atIso, kind: "INVARIANT_VIOLATION",
          details: violations.map((v) => `${v.testId}: ${v.detail}`),
        });
      }

      if (frameAgrees) agreements++;
    });

    const verdict = mismatches.length === 0 && reasons.length === 0 ? "EQUIVALENT" : "MISMATCH";
    if (verdict === "EQUIVALENT") {
      reasons.push(`engine and contract agreed on all ${frames.length} frames (${engineEmissions} emissions)`);
    }
    return {
      contractId: contract.contractId,
      strategyName: contract.strategyName,
      strategyVersion: contract.strategyVersion,
      framesEvaluated: frames.length,
      agreements,
      engineEmissions,
      contractEmissions,
      mismatches,
      verdict,
      reasons,
    };
  };

  return { contract, invariantTests, decide: (input) => decideFromContract(contract, input), checkResult, replayEquivalence };
}
