import { describe, it, expect } from "vitest";
import { formatPrice } from "./format";

// Regression: formatPrice printed every price with toFixed(2) and a missing
// price as "0.00", so a EURUSD 1.08523 entry read "1.09", a 5-pip stop and a
// 43-pip target looked identical, and a missing entry looked like a zero price.
describe("formatPrice — never rounds away quoted digits, never invents a zero", () => {
  it("keeps forex 5-digit and JPY 3-digit precision", () => {
    expect(formatPrice(1.08523)).toBe("1.08523");
    expect(formatPrice(1.0831)).toBe("1.0831");
    expect(formatPrice(150.123)).toBe("150.123");
  });
  it("distinct levels stay distinct", () => {
    const entry = formatPrice(1.08523);
    const sl = formatPrice(1.0831);
    const tp = formatPrice(1.0895);
    expect(new Set([entry, sl, tp]).size).toBe(3);
  });
  it("keeps at least two decimals for whole / 1-dp prices", () => {
    expect(formatPrice(2380)).toBe("2380.00");
    expect(formatPrice(42000.5)).toBe("42000.50");
  });
  it("a missing or non-finite price renders as a dash, not 0.00", () => {
    expect(formatPrice(null)).toBe("—");
    expect(formatPrice(undefined)).toBe("—");
    expect(formatPrice(Number.NaN)).toBe("—");
  });
});
