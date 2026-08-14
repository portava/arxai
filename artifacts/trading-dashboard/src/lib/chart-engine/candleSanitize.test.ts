// Candlestick boundary-sanitizer — unit lock.
//
// WHAT THIS LOCKS
//   `isValidCandlestickPoint` / `sanitizeCandlestickData` is the shared finite-OHLC
//   guard every candlestick feed in the dashboard must pass through before touching
//   a lightweight-charts series (setData OR update). The reason it MUST reject NaN /
//   Infinity — not just null / undefined — is the v5 candlestick colorer: a bar with
//   a non-finite OHLC field is treated as a whitespace point whose colorer calls
//   `ensureNotNull` during PAINT and throws "Value is null" on the NEXT repaint,
//   uncatchable at the call site. A bare `typeof x === "number"` check is NOT enough
//   because `typeof NaN === "number"` is true — that exact hole crashed the chart.
//   This test pins the finite-only contract so a future refactor can't reintroduce it.

import { describe, it, expect } from "vitest";
import {
  isValidCandlestickPoint,
  sanitizeCandlestickData,
} from "./candleSanitize";

const good = { time: 1_700_000_000, open: 1, high: 2, low: 0.5, close: 1.5 };

describe("isValidCandlestickPoint", () => {
  it("accepts a fully finite bar", () => {
    expect(isValidCandlestickPoint(good)).toBe(true);
  });

  it("rejects NaN in any OHLC field (the typeof-number hole)", () => {
    for (const field of ["open", "high", "low", "close"] as const) {
      expect(isValidCandlestickPoint({ ...good, [field]: NaN })).toBe(false);
    }
  });

  it("rejects Infinity / -Infinity in any OHLC field", () => {
    expect(isValidCandlestickPoint({ ...good, high: Infinity })).toBe(false);
    expect(isValidCandlestickPoint({ ...good, low: -Infinity })).toBe(false);
  });

  it("rejects a NaN or non-positive time", () => {
    expect(isValidCandlestickPoint({ ...good, time: NaN })).toBe(false);
    expect(isValidCandlestickPoint({ ...good, time: 0 })).toBe(false);
  });

  it("rejects null / undefined OHLC coerced through the point shape", () => {
    expect(
      isValidCandlestickPoint({
        ...good,
        close: null as unknown as number,
      }),
    ).toBe(false);
    expect(
      isValidCandlestickPoint({
        ...good,
        open: undefined as unknown as number,
      }),
    ).toBe(false);
  });
});

describe("sanitizeCandlestickData", () => {
  it("drops only the malformed bars and preserves order of the good ones", () => {
    const input = [
      { ...good, time: 1 },
      { ...good, time: 2, close: NaN },
      { ...good, time: 3, high: Infinity },
      { ...good, time: 4 },
    ];
    const out = sanitizeCandlestickData(input);
    expect(out.map((c) => c.time)).toEqual([1, 4]);
  });

  it("returns an empty array when every bar is non-finite", () => {
    expect(
      sanitizeCandlestickData([
        { ...good, open: NaN },
        { ...good, close: Infinity },
      ]),
    ).toEqual([]);
  });
});
