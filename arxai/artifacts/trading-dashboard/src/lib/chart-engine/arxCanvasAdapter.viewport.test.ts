import { describe, expect, it } from "vitest";
import { defaultVisibleBarsForWidth } from "./arxCanvasAdapter";

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
});
