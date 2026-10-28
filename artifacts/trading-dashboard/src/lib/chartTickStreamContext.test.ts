import { describe, it, expect } from "vitest";
import { chartTickSource, matchesChartTickContext } from "./chartTickStreamContext";
describe("chart tick context", () => {
  it("accepts only exactly identified providers", () => {
    for (const source of ["mt5_broker", "deriv", "deriv_public"]) expect(chartTickSource(source)).toBe(source);
    for (const source of [null, undefined, "", "unknown", "deriv_public:other", "assistant_real"]) expect(chartTickSource(source)).toBeNull();
  });
  it("refuses non-object wire messages", () => {
    for (const message of [null, undefined, 5, "bad", [], true])
      expect(matchesChartTickContext(message, "deriv_public", "V75", "M5")).toBe(false);
  });
  it("keeps both source directions and symbol/timeframe boundaries separate", () => {
    for (const source of ["mt5_broker", "deriv", "deriv_public"]) {
      const frame = { source, symbol: "V75", timeframe: "M5" };
      expect(matchesChartTickContext(frame, source, "V75", "M5")).toBe(true);
      for (const other of ["mt5_broker", "deriv", "deriv_public"].filter(s => s !== source))
        expect(matchesChartTickContext(frame, other, "V75", "M5")).toBe(false);
      expect(matchesChartTickContext(frame, source, "V25", "M5")).toBe(false);
      expect(matchesChartTickContext(frame, source, "V75", "M1")).toBe(false);
      expect(matchesChartTickContext({ ...frame, source: undefined }, source, "V75", "M5")).toBe(false);
    }
  });
});
