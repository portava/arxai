import { describe, expect, it } from "vitest";
import {
  defaultVisibleBarsForWidth,
  rebaseUserVisibleRange,
  shouldRefitSparseInitialWindow,
} from "./arxCanvasAdapter";

describe("ARX Canvas initial viewport sizing", () => {
  it("keeps a width-responsive default window bounded and readable", () => {
    expect(defaultVisibleBarsForWidth(320, true)).toBe(49);
    expect(defaultVisibleBarsForWidth(480, false)).toBe(64);
    expect(defaultVisibleBarsForWidth(900, false)).toBe(120);
    expect(defaultVisibleBarsForWidth(2000, false)).toBe(150);
  });

  it("does not request more bars than the configured desktop or mobile ceiling", () => {
    expect(defaultVisibleBarsForWidth(5000, true)).toBe(80);
    expect(defaultVisibleBarsForWidth(0, false)).toBe(55);
  });

  it("refits an untouched sparse first response when the full window arrives", () => {
    expect(shouldRefitSparseInitialWindow({
      userInteracted: false, linked: false, fitted: true, previousBars: 4, nextBars: 200,
    })).toBe(true);
  });

  it("does not reframe a window the user has navigated or a linked chart controls", () => {
    expect(shouldRefitSparseInitialWindow({
      userInteracted: true, linked: false, fitted: true, previousBars: 4, nextBars: 200,
    })).toBe(false);
    expect(shouldRefitSparseInitialWindow({
      userInteracted: false, linked: true, fitted: true, previousBars: 4, nextBars: 200,
    })).toBe(false);
    expect(shouldRefitSparseInitialWindow({
      userInteracted: false, linked: false, fitted: false, previousBars: 4, nextBars: 200,
    })).toBe(false);
  });

  it("rebases a user's visible range across same-market source resets, but waits for enough bars", () => {
    expect(rebaseUserVisibleRange({ from: 40, to: 100 }, 200, 200)).toEqual({ from: 40, to: 100 });
    expect(rebaseUserVisibleRange({ from: 40, to: 100 }, 200, 2)).toBeNull();
    expect(rebaseUserVisibleRange({ from: 40, to: 100 }, 200, 180)).toEqual({ from: 20, to: 80 });
  });
});
