import { describe, it, expect } from "vitest";
import {
  scoreScenarioQuiz, sma, calcPlacement, gradePlacement, gradeZones, scoreTradePlan,
  EMPTY_TRADE_PLAN, type PlacementScenarioRules, type TradePlanInput,
} from "./labMath";
import { SCENARIO_LABS, PLACEMENT_SCENARIOS, ZONE_SCENARIO } from "../data/labs";

describe("scoreScenarioQuiz", () => {
  const scenarios = [{ answerIndex: 0 }, { answerIndex: 2 }, { answerIndex: 1 }, { answerIndex: 3 }];
  it("counts only exact matches", () => {
    expect(scoreScenarioQuiz(scenarios, [0, 2, 0, 3])).toEqual({ correct: 3, total: 4, pct: 0.75 });
  });
  it("treats unanswered as wrong", () => {
    expect(scoreScenarioQuiz(scenarios, [0])).toEqual({ correct: 1, total: 4, pct: 0.25 });
  });
  it("handles an empty quiz", () => {
    expect(scoreScenarioQuiz([], [])).toEqual({ correct: 0, total: 0, pct: 0 });
  });
  it("every static scenario has a valid answer index and explanation", () => {
    for (const lab of Object.values(SCENARIO_LABS)) {
      expect(lab.scenarios.length).toBeGreaterThanOrEqual(5);
      for (const s of lab.scenarios) {
        expect(s.answerIndex).toBeGreaterThanOrEqual(0);
        expect(s.answerIndex).toBeLessThan(s.options.length);
        expect(s.explanation.length).toBeGreaterThan(10);
        for (const c of s.chart?.candles ?? []) {
          const [o, h, l, cl] = c;
          expect(h).toBeGreaterThanOrEqual(Math.max(o, cl));
          expect(l).toBeLessThanOrEqual(Math.min(o, cl));
        }
      }
    }
  });
});

describe("sma", () => {
  it("averages the trailing window", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
});

describe("calcPlacement", () => {
  it("computes pips and R:R for a long", () => {
    const m = calcPlacement("long", { entry: 1.1, stop: 1.098, target: 1.106 }, 0.0001);
    expect(m.riskPips).toBe(20);
    expect(m.rewardPips).toBe(60);
    expect(m.rr).toBe(3);
    expect(m.ordered).toBe(true);
  });
  it("flags wrong ordering for a short", () => {
    const m = calcPlacement("short", { entry: 1.27, stop: 1.268, target: 1.275 }, 0.0001);
    expect(m.ordered).toBe(false);
  });
  it("returns rr 0 when risk is zero", () => {
    expect(calcPlacement("long", { entry: 1.1, stop: 1.1, target: 1.11 }, 0.0001).rr).toBe(0);
  });
});

describe("gradePlacement", () => {
  const rules: PlacementScenarioRules = {
    direction: "long", pipSize: 0.0001, swingPrice: 1.0959, idealEntry: 1.0987,
    entryTolerancePips: 12, minRR: 2, maxStopBeyondSwingPips: 20,
  };
  const byId = (g: ReturnType<typeof gradePlacement>) => Object.fromEntries(g.checks.map((c) => [c.id, c.pass]));

  it("passes a stop beyond the swing with R:R >= 2", () => {
    const g = gradePlacement(rules, { entry: 1.0987, stop: 1.0952, target: 1.1057 });
    expect(g.metrics.riskPips).toBe(35);
    expect(g.metrics.rr).toBe(2);
    expect(g.passed).toBe(true);
  });
  it("fails when the stop is inside the swing", () => {
    const g = gradePlacement(rules, { entry: 1.0987, stop: 1.0965, target: 1.1057 });
    expect(byId(g).stop).toBe(false);
    expect(g.passed).toBe(false);
  });
  it("fails when the stop is needlessly far beyond the swing", () => {
    const g = gradePlacement(rules, { entry: 1.0987, stop: 1.0930, target: 1.12 });
    expect(byId(g).stop).toBe(false);
  });
  it("fails R:R below the target", () => {
    const g = gradePlacement(rules, { entry: 1.0987, stop: 1.0952, target: 1.1020 });
    expect(byId(g).rr).toBe(false);
    expect(byId(g).stop).toBe(true);
  });
  it("fails an entry far from the setup", () => {
    const g = gradePlacement(rules, { entry: 1.1010, stop: 1.0952, target: 1.1200 });
    expect(byId(g).entry).toBe(false);
  });
  it("mirrors the swing rule for shorts", () => {
    const short: PlacementScenarioRules = { ...rules, direction: "short", swingPrice: 1.2737, idealEntry: 1.2712 };
    expect(gradePlacement(short, { entry: 1.2712, stop: 1.2745, target: 1.2646 }).passed).toBe(true);
    expect(byId(gradePlacement(short, { entry: 1.2712, stop: 1.2730, target: 1.2646 })).stop).toBe(false);
  });
  it("each scenario's starting lines do NOT pass (the learner has to move them)", () => {
    for (const s of PLACEMENT_SCENARIOS) expect(gradePlacement(s, s.start).passed).toBe(false);
  });
});

describe("gradeZones", () => {
  const targets = ZONE_SCENARIO.targets;
  const tol = ZONE_SCENARIO.tolerancePips * ZONE_SCENARIO.pipSize; // 8 pips

  it("hits zones within tolerance (inclusive)", () => {
    const g = gradeZones([1.1043 + tol, 1.096 - tol], targets, tol);
    expect(g.hitIds.sort()).toEqual(["resistance", "support"]);
    expect(g.passed).toBe(true);
    expect(g.pct).toBe(1);
  });
  it("misses zones just outside tolerance", () => {
    const g = gradeZones([1.1043 + 0.0009, 1.0960], targets, tol);
    expect(g.missedIds).toEqual(["resistance"]);
    expect(g.extras.length).toBe(1);
    expect(g.extras[0]).toBeCloseTo(1.1052, 6);
    expect(g.passed).toBe(false);
  });
  it("one placed level cannot satisfy two zones", () => {
    const g = gradeZones([1.1], [{ id: "a", label: "a", price: 1.0999 }, { id: "b", label: "b", price: 1.1001 }], 0.0005);
    expect(g.hitIds.length).toBe(1);
    expect(g.missedIds.length).toBe(1);
  });
  it("allows at most one extra level to still pass", () => {
    expect(gradeZones([1.1043, 1.096, 1.1], targets, tol).passed).toBe(true);
    expect(gradeZones([1.1043, 1.096, 1.1, 1.1005], targets, tol).passed).toBe(false);
  });
});

describe("scoreTradePlan", () => {
  const full: TradePlanInput = {
    market: "EUR/USD", direction: "long",
    reason: "Uptrend with a pullback into prior resistance turned support at 1.0960.",
    entry: "1.0985", stop: "1.0950", target: "1.1060", riskPct: "1",
    invalidation: "Close below 1.0950", sessionChecked: true, newsChecked: true,
  };
  const pts = (p: TradePlanInput, id: string) => scoreTradePlan(p).items.find((i) => i.id === id)!.points;

  it("rubric max adds to 100", () => {
    expect(scoreTradePlan(EMPTY_TRADE_PLAN).items.reduce((s, i) => s + i.max, 0)).toBe(100);
  });
  it("an empty plan scores 0", () => {
    expect(scoreTradePlan(EMPTY_TRADE_PLAN).score).toBe(0);
  });
  it("a complete, consistent plan scores 100", () => {
    const r = scoreTradePlan(full);
    expect(r.score).toBe(100);
    expect(r.rr).toBeCloseTo(2.143, 2);
  });
  it("levels on the wrong side lose consistency and R:R points", () => {
    const r = scoreTradePlan({ ...full, direction: "short" });
    expect(r.items.find((i) => i.id === "consistency")!.points).toBe(0);
    expect(r.items.find((i) => i.id === "rr")!.points).toBe(0);
    expect(r.score).toBe(70);
  });
  it("tiers R:R", () => {
    expect(pts({ ...full, target: "1.1040" }, "rr")).toBe(10); // 55/35 = 1.57
    expect(pts({ ...full, target: "1.1025" }, "rr")).toBe(5);  // 40/35 = 1.14
    expect(pts({ ...full, target: "1.1000" }, "rr")).toBe(0);  // 15/35
  });
  it("tiers risk %", () => {
    expect(pts({ ...full, riskPct: "2" }, "risk")).toBe(12);
    expect(pts({ ...full, riskPct: "3" }, "risk")).toBe(6);
    expect(pts({ ...full, riskPct: "8" }, "risk")).toBe(0);
    expect(pts({ ...full, riskPct: "abc" }, "risk")).toBe(0);
  });
  it("partial reason and missing levels get partial credit", () => {
    expect(pts({ ...full, reason: "pullback to support" }, "reason")).toBe(5);
    expect(pts({ ...full, target: "" }, "levels")).toBe(10);
  });
});
