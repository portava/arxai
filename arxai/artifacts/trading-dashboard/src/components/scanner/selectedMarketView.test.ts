// Render-state contract for the selected-market panel (Task #518, acceptance
// test #6). The panel draws exactly one of three branches off this pure
// resolver. The bug we lock down: numeric entry/stop/target rendered when the
// stale-level guard withheld them, or zeros styled as levels when there is no
// confirmed feed.

import { describe, it, expect } from "vitest";
import {
  resolveSelectedMarketView,
  WITHHELD_FALLBACK_REASON,
  type SelectedMarketViewInput,
} from "./selectedMarketView";

function input(overrides: Partial<SelectedMarketViewInput> = {}): SelectedMarketViewInput {
  return {
    levelsWithheld: false,
    levelsWithheldReason: null,
    dataState: "LIVE_CONFIRMED",
    highlights: {
      entryZone: { low: 1.15, high: 1.1505 },
      suggestedStop: 1.149,
      suggestedTakeProfit: 1.152,
      riskRewardRatio: 2,
    },
    ...overrides,
  };
}

describe("resolveSelectedMarketView", () => {
  it("withheld:true renders no numeric levels and surfaces the guard's reason", () => {
    const reason =
      "The saved entry, stop, and target are far from the current price, so they are no longer shown.";
    const view = resolveSelectedMarketView(
      input({ levelsWithheld: true, levelsWithheldReason: reason, dataState: "STALE" }),
    );
    expect(view.kind).toBe("withheld");
    if (view.kind !== "withheld") throw new Error("expected withheld");
    expect(view.reason).toBe(reason);
    // No numeric level fields exist on the withheld branch.
    expect("levels" in view).toBe(false);
  });

  it("withheld with no reason falls back to a clean sentence (never empty)", () => {
    const view = resolveSelectedMarketView(
      input({ levelsWithheld: true, levelsWithheldReason: null, dataState: "STALE" }),
    );
    expect(view.kind).toBe("withheld");
    if (view.kind !== "withheld") throw new Error("expected withheld");
    expect(view.reason).toBe(WITHHELD_FALLBACK_REASON);
  });

  it("UNAVAILABLE feed renders the waiting state, never zeros as levels", () => {
    const view = resolveSelectedMarketView(
      input({
        levelsWithheld: true,
        dataState: "UNAVAILABLE",
        highlights: {
          entryZone: null,
          suggestedStop: null,
          suggestedTakeProfit: null,
          riskRewardRatio: 0,
        },
      }),
    );
    expect(view.kind).toBe("waiting");
  });

  it("fresh in-range levels render the numbers", () => {
    const view = resolveSelectedMarketView(input());
    expect(view.kind).toBe("levels");
    if (view.kind !== "levels") throw new Error("expected levels");
    expect(view.levels.entryLow).toBe(1.15);
    expect(view.levels.entryHigh).toBe(1.1505);
    expect(view.levels.stop).toBe(1.149);
    expect(view.levels.target).toBe(1.152);
    expect(view.levels.riskReward).toBe(2);
  });
});
