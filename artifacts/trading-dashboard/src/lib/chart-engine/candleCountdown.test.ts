import { describe, it, expect } from "vitest";
import { candleCountdown, countdownText } from "./candleCountdown";
import { validDrawings, fibonacciLevels } from "./drawings";
describe("Interval timer and annotation validation", () => {
  it("counts down from a current observed bar and rolls an expired bar to the next interval", () => {
    const start = Date.UTC(2026, 10, 13, 12, 0);
    expect(candleCountdown("M5", start + 60000, start)).toEqual({
      remaining: 240,
      scheduled: false,
    });
    expect(candleCountdown("M5", start + 300000, start)).toEqual({
      remaining: 300,
      scheduled: true,
    });
  });
  it("aligns weekly/monthly schedules correctly and handles unsupported timeframes", () => {
    const sunday = Date.UTC(2026, 10, 15, 23, 59, 59);
    expect(candleCountdown("W1", sunday, null)?.remaining).toBe(1);
    expect(
      candleCountdown("MN1", Date.UTC(2026, 10, 30, 23, 59, 59), null)
        ?.remaining,
    ).toBe(1);
    expect(candleCountdown("invalid", sunday, null)).toBeNull();
    expect(countdownText(3661)).toBe("01:01:01");
  });
  it("rejects corrupt persisted drawings and calculates retracements in either direction", () => {
    expect(
      validDrawings([
        null,
        {
          id: "x",
          tool: "trade",
          start: { time: 1, price: 1 },
          end: { time: 2, price: 2 },
        },
      ]),
    ).toEqual([]);
    expect(
      fibonacciLevels(100, 200).find((x) => x.ratio === 0.618)?.price,
    ).toBeCloseTo(161.8);
    expect(
      fibonacciLevels(200, 100).find((x) => x.ratio === 0.618)?.price,
    ).toBeCloseTo(138.2);
  });
});
