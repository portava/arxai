import { describe, it, expect } from "vitest";
import {
  allLayers,
  visibleOverlays,
  structureMarkerLayer,
  SCENARIO_LAYERS,
} from "./layers";
import type { ChartOverlay } from "@/lib/chart-overlays";
const overlays: ChartOverlay[] = [
  {
    id: "position",
    type: "line",
    symbol: "V75",
    label: "Entry",
    source: "position",
    price: 100,
  },
  {
    id: "signal",
    type: "line",
    symbol: "V75",
    label: "SL",
    source: "signal",
    price: 90,
  },
  {
    id: "gap",
    type: "zone",
    symbol: "V75",
    label: "Gap",
    source: "signal",
    priceMin: 95,
    priceMax: 96,
    metadata: { strategy: "HTF_TREND_FVG_PULLBACK" },
  },
  {
    id: "ruby",
    type: "zone",
    symbol: "V75",
    label: "Support",
    source: "ruby",
    priceMin: 90,
    priceMax: 92,
  },
];
describe("Smart chart layer visibility", () => {
  it("hides and restores supplied overlays without modifying their sources or levels", () => {
    expect(visibleOverlays(overlays, allLayers(false))).toEqual([]);
    expect(visibleOverlays(overlays, allLayers(true))).toEqual(overlays);
    expect(overlays[0].price).toBe(100);
  });
  it("controls FVG separately from scanner signals and positions", () => {
    const layers = { ...allLayers(true), fvg: false, positions: false };
    expect(visibleOverlays(overlays, layers).map((x) => x.id)).toEqual([
      "signal",
      "ruby",
    ]);
  });
  it("keeps structure events and the three scenario switches independently addressable", () => {
    expect(structureMarkerLayer("break")).toBe("breaks");
    expect(structureMarkerLayer("retest")).toBe("retests");
    expect(structureMarkerLayer("reclaim")).toBe("reclaims");
    expect(structureMarkerLayer("failure")).toBe("structureEvents");
    expect(new Set(Object.values(SCENARIO_LAYERS)).size).toBe(3);
  });
});
