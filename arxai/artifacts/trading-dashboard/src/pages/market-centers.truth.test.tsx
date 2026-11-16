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
import IndicesCenter from "./indices-center";
import StocksCenter from "./stocks-center";

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

// The Scanner has an indices universe and the router serves indices and stocks
// (mt5_broker, then a vendor). These pages have no analytics provider; they
// must not say no index/stock feed exists anywhere, and must not list only
// forex and synthetics as wired.
describe("Indices and Stocks centers — what is actually missing", () => {
  it("Indices Center does not claim no index feed exists, and names where index prices are", () => {
    render(<IndicesCenter />);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/no live equity-index feed configured/i);
    expect(text).not.toMatch(/Forex and synthetic markets remain/i);
    expect(text).not.toMatch(/real broker data/i);
    expect(text).toMatch(/Index prices and setups are on the Scanner/);
    expect(text).toMatch(/MT5 broker feed when your bridge is connected/);
  });

  it("Stocks Center does not claim no stock feed is configured or that only forex and synthetics are wired", () => {
    render(<StocksCenter />);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/no live stock-market feed configured/i);
    expect(text).not.toMatch(/Forex and synthetic markets remain fully wired/i);
    expect(text).toMatch(/does not load stock prices or signals/);
    expect(text).toMatch(/The Scanner does not scan stocks/);
  });
});
