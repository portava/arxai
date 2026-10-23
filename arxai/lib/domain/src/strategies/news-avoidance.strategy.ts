import type { Strategy, StrategyResult } from "./strategy.types";
import { noSignal } from "./strategy.types";

const NAME = "news-avoidance";

// News Avoidance — meta-strategy. Doesn't generate entry signals; emits an
// AVOID action when a HIGH/MEDIUM news window is active for the symbol.
// The scanner runs this first; if it emits AVOID, every other strategy's
// signal for the same tick is suppressed by the orchestrator.
const LOCKOUT_BEFORE_MS = 15 * 60 * 1000;
const LOCKOUT_AFTER_MS  = 15 * 60 * 1000;

export const newsAvoidanceStrategy: Strategy = {
  name: NAME,
  label: "News Avoidance",
  version: "1.0.0",
  evaluate(input): StrategyResult {
    const now = input.now.getTime();
    for (const w of input.newsWindows) {
      if (w.symbol !== "*" && w.symbol !== input.symbol) continue;
      if (w.severity === "LOW") continue;
      const from = new Date(w.from).getTime() - LOCKOUT_BEFORE_MS;
      const to   = new Date(w.to).getTime()   + LOCKOUT_AFTER_MS;
      if (now >= from && now <= to) {
        return {
          strategyName: NAME,
          emitted: true,
          signal: {
            action: "AVOID",
            direction: null,
            entry: null, stopLoss: null, takeProfit: null,
            confidence: 100,    // "we are 100% sure to avoid this"
            reasons: [
              `${w.severity} news active on ${w.symbol === "*" ? "global" : w.symbol}: ${w.headline}`,
              `Lockout window ±15 min around event`,
            ],
          },
          rejectedReasons: [],
        };
      }
    }
    return noSignal(NAME, "No active news lockout");
  },
};

// Helper for orchestrators: returns true when news-avoidance has emitted
// AVOID, meaning all other strategies should be suppressed.
export function isNewsLockoutActive(result: StrategyResult): boolean {
  return result.strategyName === NAME
      && result.emitted
      && result.signal?.action === "AVOID";
}
