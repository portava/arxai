import type { Strategy, StrategyInput, StrategyResult } from "./strategy.types";
import { sniperEntryStrategy } from "./sniper-entry.strategy";
import { londonBreakoutStrategy } from "./london-breakout.strategy";
import { trendContinuationStrategy } from "./trend-continuation.strategy";
import { reversalHunterStrategy } from "./reversal-hunter.strategy";
import { newsAvoidanceStrategy, isNewsLockoutActive } from "./news-avoidance.strategy";

export * from "./strategy.types";
export * from "./lifecycle.types";
export * from "./lifecycle.engine";
export { sniperEntryStrategy } from "./sniper-entry.strategy";
export { londonBreakoutStrategy } from "./london-breakout.strategy";
export { trendContinuationStrategy } from "./trend-continuation.strategy";
export { reversalHunterStrategy } from "./reversal-hunter.strategy";
export { newsAvoidanceStrategy, isNewsLockoutActive } from "./news-avoidance.strategy";

// Canonical registry — order matters: news-avoidance runs first so the
// scanner can short-circuit other strategies when a news window is active.
export const STRATEGY_REGISTRY: Strategy[] = [
  newsAvoidanceStrategy,
  sniperEntryStrategy,
  londonBreakoutStrategy,
  trendContinuationStrategy,
  reversalHunterStrategy,
];

export const STRATEGY_BY_NAME: Record<string, Strategy> = Object.fromEntries(
  STRATEGY_REGISTRY.map((s) => [s.name, s]),
);

// Convenience: run every strategy in the registry against a single input,
// honoring news lockout (suppress non-news strategies when AVOID is active).
export function runAllStrategies(
  input: StrategyInput,
  registry: Strategy[] = STRATEGY_REGISTRY,
): StrategyResult[] {
  const results: StrategyResult[] = [];
  let lockedOut = false;

  for (const s of registry) {
    const r = s.evaluate(input);
    results.push(r);
    if (isNewsLockoutActive(r)) lockedOut = true;
    if (lockedOut && s.name !== "news-avoidance" && r.emitted) {
      // Replace any emitted signal with a suppression record.
      results[results.length - 1] = {
        strategyName: s.name,
        emitted: false,
        signal: null,
        rejectedReasons: [`Suppressed by news-avoidance lockout`],
      };
    }
  }
  return results;
}
