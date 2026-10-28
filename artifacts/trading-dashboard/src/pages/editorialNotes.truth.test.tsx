// Regression: the Stocks Center's "static sector notes" carried undated,
// unattributed directional calls ("Technology: Bullish on AI spend cycle",
// "Semiconductors: Bullish — AI chip demand, NVDA data center dominance")
// inside a block that says it is not analysis. The Synthetic Center said the
// V25 (1s) index has "1-second candles" and a "more predictable structure";
// 1s indices tick once per second, and a random-walk index has no more
// predictable structure than any other.
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import StocksCenter from "./stocks-center";
import SyntheticCenter from "./synthetic-center";

afterEach(() => cleanup());

describe("static editorial notes make no undated market calls or wrong product claims", () => {
  it("Stocks Center sector notes carry no Bullish/Bearish view", () => {
    render(<StocksCenter />);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Bullish|Bearish/i);
    expect(text).not.toMatch(/dominance/i);
    expect(text).toMatch(/not a market view/i);
  });

  it("Synthetic Center does not call 1s indices '1-second candles' or 'more predictable'", () => {
    render(<SyntheticCenter />);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/more predictable/i);
    expect(text).not.toMatch(/1-second candles/i);
    expect(text).not.toMatch(/strong trending phases/i);
    expect(text).toMatch(/ticks once per second/i);
  });
});
