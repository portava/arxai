export * from "./strategyContract.types";
export * from "./contractFeatures.engine";
export * from "./contractCompiler.engine";
export * from "./frozenReplay.engine";
export * from "./behavioralDiff.engine";
export { londonBreakoutContract } from "./londonBreakout.contract";
export { trendContinuationContract } from "./trendContinuation.contract";

// Canonical registry of extracted contracts. A strategy listed here has its
// hand-written engine pinned by a declarative contract; the CI lane
// test:strategy-contract-compiler proves replay-equivalence and fails loudly
// on any drift between the two.
import type { StrategyContract } from "./strategyContract.types";
import { londonBreakoutContract } from "./londonBreakout.contract";
import { trendContinuationContract } from "./trendContinuation.contract";

export const CONTRACT_REGISTRY: ReadonlyArray<StrategyContract> = [
  londonBreakoutContract,
  trendContinuationContract,
];

export const CONTRACT_BY_STRATEGY_NAME: Record<string, StrategyContract> = Object.fromEntries(
  CONTRACT_REGISTRY.map((c) => [c.strategyName, c]),
);
