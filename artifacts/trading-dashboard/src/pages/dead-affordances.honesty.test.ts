// Controls that look live must do something; copy must not promise data that
// no code path produces.
//
//   Mirror Lock       `mirrorLocked` was read only by the toggle's own styling
//                     and the "Inspection mode" badge; the component comment
//                     admitted "the symbol/timeframe come from the parent
//                     regardless". Unlocking it to inspect a different
//                     instrument did nothing — the chart still followed the
//                     shared bus. Removed (button, badge and mirrorLockDefault).
//
//   Analytics         "Consistency Score" said the assistant "needs more closed
//                     trades to calculate consistency accurately" — nothing
//                     computes a consistency score, so it never arrives.
//                     "Account Timeline" / "Account Alerts" said "No account
//                     events recorded yet." / "No account alerts right now." —
//                     both read as a live empty state; neither reads anything.
//                     The Timeline tab's nine filter chips were write-only
//                     state over an empty list.
//
//   My Trades         "Near Stop Loss" / "Near Take Profit" were hardcoded "—"
//                     beside four working tiles, so the user read "no positions
//                     near stop loss" from a field that never computed. Both
//                     are now derived from entry/current/level already on the
//                     card. "Live Activity" was a permanent literal.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { proximityToLevel, NEAR_LEVEL_THRESHOLD } from "@/pages/my-trades";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");

function code(rel: string): string {
  return readFileSync(resolve(SRC, rel), "utf8")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

const chart = code("components/charts/ARXNativeChart.tsx");
const analytics = code("pages/analytics.tsx");
const myTrades = code("pages/my-trades.tsx");

describe("the dead Mirror Lock control is gone", () => {
  it("has no toggle, badge or prop", () => {
    expect(chart).not.toMatch(/mirrorLocked/);
    expect(chart).not.toMatch(/mirrorLockDefault/);
    expect(chart).not.toMatch(/arx-mirror-lock/);
    expect(chart).not.toMatch(/arx-mirror-inspection/);
    expect(chart).not.toMatch(/Inspection mode/);
  });

  it("keeps the mirror status bar, which reads real feed state", () => {
    expect(chart).toMatch(/arx-mirror-layer/);
    expect(chart).toMatch(/getMirrorStatus/);
  });
});

describe("analytics stub cards say they are not built", () => {
  it("does not promise a consistency score that will arrive with more trades", () => {
    expect(analytics).not.toMatch(/Score updates as more trades close/);
    expect(analytics).toMatch(/Not built yet/);
  });

  it("does not present un-read cards as live empty states", () => {
    expect(analytics).not.toMatch(/No account events recorded yet/);
    expect(analytics).not.toMatch(/No account alerts right now/);
    expect(analytics).toMatch(/reads no event source/);
    expect(analytics).toMatch(/reads no alert source/);
  });

  it("the Timeline tab's inert filter chips are gone", () => {
    expect(analytics).not.toMatch(/"Risk Events", "Reviews"/);
    expect(analytics).not.toMatch(/No account timeline events yet/);
  });
});

describe("my-trades computes near-SL / near-TP instead of printing a dash", () => {
  it("the tiles read the computed values", () => {
    expect(myTrades).not.toMatch(/label="Near Stop Loss" value="—"/);
    expect(myTrades).not.toMatch(/label="Near Take Profit" value="—"/);
    expect(myTrades).toMatch(/value=\{sum\.nearSL \?\? "—"\}/);
    expect(myTrades).toMatch(/value=\{sum\.nearTP \?\? "—"\}/);
  });

  it("proximityToLevel measures travel from entry toward the level", () => {
    // Long from 100 with a stop at 90; price 92 is 80% of the way to the stop.
    expect(proximityToLevel(100, 92, 90)).toBeCloseTo(0.8, 5);
    expect(proximityToLevel(100, 100, 90)).toBe(0);
    expect(proximityToLevel(100, 90, 90)).toBe(1);
    // Short from 100 with a target at 110 behaves the same way by direction.
    expect(proximityToLevel(100, 108, 110)).toBeCloseTo(0.8, 5);
  });

  it("clamps rather than reporting impossible progress", () => {
    expect(proximityToLevel(100, 80, 90)).toBe(1);
    expect(proximityToLevel(100, 110, 90)).toBe(0);
  });

  it("returns 0 when entry and level coincide — nothing to measure", () => {
    expect(proximityToLevel(100, 105, 100)).toBe(0);
  });

  it("80% is the near threshold", () => {
    expect(NEAR_LEVEL_THRESHOLD).toBe(0.8);
  });

  it("the Live Activity placebo is replaced by real rows", () => {
    expect(myTrades).not.toMatch(/Live activity will appear as positions update/);
    expect(myTrades).toMatch(/recentlyOpened/);
  });
});
