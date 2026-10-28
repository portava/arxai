// Market centers (Forex, Synthetic, Indices, Stocks) — their static copy must
// not describe the Scanner's data more strongly than the market-data router
// serves it. The router chain is mt5_broker first, then a third-party vendor
// (assistant_real) for forex/indices/stocks and Deriv's public feed for
// synthetics, so "real broker data" and "fully tradable" were not true without
// an MT5 bridge, and a row without a current live feed is never trade-ready.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import ForexCenter from "./forex-center";
import SyntheticCenter from "./synthetic-center";

afterEach(() => cleanup());

describe("Forex and Synthetic centers — Scanner data source", () => {
  it("Forex Center does not claim the Scanner uses real broker data or is fully wired", () => {
    render(<ForexCenter />);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/real broker data/i);
    expect(text).not.toMatch(/fully (wired|tradable)/i);
    expect(text).toMatch(/MT5 broker feed when your bridge is connected/);
    expect(text).toMatch(/third-party market-data vendor/);
  });

  it("Synthetic Center does not claim real broker data or that synthetics are fully tradable", () => {
    render(<SyntheticCenter />);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/real broker data/i);
    expect(text).not.toMatch(/fully (wired|tradable)/i);
    expect(text).toMatch(/MT5 broker feed when your bridge is connected/);
    expect(text).toMatch(/Deriv's public price feed/);
  });
});
