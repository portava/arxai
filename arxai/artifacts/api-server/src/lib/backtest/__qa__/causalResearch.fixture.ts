import { RESEARCH_STRATEGY_VERSION, type ResearchBar, type ResearchInput, type ResearchConfig } from "@workspace/domain/backtest/research";
export const STEP = 60000;
export function researchBars(closes: number[]): ResearchBar[] {
  return closes.map((close, i) => ({ openTimeMs: i * STEP, open: close, high: close + .01, low: close - .01, close }));
}
export function input(bars = researchBars([100, 101, 102, 103, 104, 105, 106, 107, 108])): ResearchInput {
  return { symbol: "TEST", priceBasis: "MID", intervalMs: STEP, asOfMs: bars.at(-1)!.openTimeMs + STEP,
    source: { kind: "generated", reference: "controlled-causal-fixture-v1" }, bars };
}
export function config(overrides: Partial<ResearchConfig> = {}): ResearchConfig {
  return { strategy: { version: RESEARCH_STRATEGY_VERSION, lookbackBars: 1, thresholdPriceUnits: 0,
    stopDistancePriceUnits: 3, targetDistancePriceUnits: 3, maxHoldingBars: 2 },
    costs: { fullSpreadPriceUnits: 0, adverseSlippagePerFillPriceUnits: 0, feePerFillPriceUnits: 0 },
    maxEntryGapMs: 0, splits: { trainEndExclusive: 4, validationEndExclusive: 6 }, ...overrides };
}
/** Controlled prices, not financial return evidence. Same input for both paths. */
export function workload(count: number): ResearchInput {
  const bars = Array.from({ length: count }, (_, i) => {
    const open = 100 + Math.sin(i / 11) * 2, close = 100 + Math.sin((i + 1) / 11) * 2;
    return { openTimeMs: i * STEP, open, high: Math.max(open, close) + .2, low: Math.min(open, close) - .2, close };
  });
  return input(bars);
}
export function workloadConfig(count: number): ResearchConfig {
  return config({ strategy: { version: RESEARCH_STRATEGY_VERSION, lookbackBars: 50, thresholdPriceUnits: .1,
    stopDistancePriceUnits: 1, targetDistancePriceUnits: 2, maxHoldingBars: 10 },
    costs: { fullSpreadPriceUnits: .02, adverseSlippagePerFillPriceUnits: .01, feePerFillPriceUnits: .005 },
    splits: { trainEndExclusive: Math.floor(count * .6), validationEndExclusive: Math.floor(count * .8) } });
}
