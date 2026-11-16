import { describe, expect, it } from "vitest";
import { fitPopup } from "./ToolbarPopup";

// Bounds are the clipping box the popup must stay inside (8 px gap each side).
describe("fitPopup", () => {
  it("keeps the trigger's left edge when the popup fits", () => {
    expect(fitPopup({ left: 100, right: 180 }, { left: 0, right: 1200 }, 1440)).toEqual({ alignEnd: false, left: 0, maxWidth: 416 });
  });
  it("flips to the trigger's right edge when only that fits", () => {
    expect(fitPopup({ left: 900, right: 980 }, { left: 0, right: 1200 }, 1440)).toEqual({ alignEnd: true, left: 0, maxWidth: 416 });
  });
  it("shifts and narrows inside a clipping panel narrower than the popup", () => {
    // The Tools panel case: 417 px wide, History trigger in its middle.
    const placement = fitPopup({ left: 1095, right: 1235 }, { left: 990, right: 1407 }, 1440);
    expect(placement.alignEnd).toBe(false);
    expect(placement.maxWidth).toBe(401);
    expect(1095 + placement.left).toBe(998);
    expect(1095 + placement.left + placement.maxWidth).toBeLessThanOrEqual(1407 - 8);
  });
});
