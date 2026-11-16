// Regression: the portfolio page read the legacy trades table and showed a
// green "Floating P&L $0.00" for open rows that were never marked to market,
// folded P/L-UNKNOWN closes into Realized P&L, labelled a net 24h loss
// "Daily Drawdown", and said "No exposure." with no hint that broker
// positions are not part of these figures.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let exposure: Record<string, unknown> = {};
// Query-state overrides for the read-failure tests (data, isError, times).
let exposureQ: Record<string, unknown> | null = null;
let warnQ: Record<string, unknown> = { data: [] };
vi.mock("@workspace/api-client-react", () => ({
  useGetPortfolioExposure: () => exposureQ ?? ({ data: exposure, isLoading: false }),
  useGetCorrelationWarnings: () => warnQ,
  getGetPortfolioExposureQueryKey: () => ["exp"],
  getGetCorrelationWarningsQueryKey: () => ["warn"],
}));
const { default: Portfolio } = await import("./portfolio");

const base = {
  totalOpen: 1, totalClosed: 1, floatingPnl: null, floatingPnlUnavailableReason: "1 of 1 open row not marked to market (no recorded P&L)",
  realizedPnl: 0, realizedPnlExcludedUnknown: 1, source: "LEGACY_TRADES_TABLE",
  sourceNote: "From the legacy trades table only. Broker positions are not included, so an empty view does not mean you have no open exposure.",
  exposureByMarket: {}, exposureByStrategy: {}, exposureByCurrency: [], dailyDrawdown: 0, weeklyDrawdown: 0,
};

afterEach(() => { cleanup(); exposureQ = null; warnQ = { data: [] }; });

describe("portfolio page truth", () => {
  it("shows unmeasured floating P&L as unavailable, not $0.00", () => {
    exposure = { ...base };
    render(<Portfolio />);
    expect(screen.getByTestId("floating-pnl").textContent).toBe("Unavailable");
    expect(screen.getByText(/not marked to market/)).toBeTruthy();
    expect(screen.getByText(/1 closed trade excluded: P\/L unknown/)).toBeTruthy();
  });

  it("states the source scope, and does not say 'No exposure.'", () => {
    exposure = { ...base, sourceNote: undefined };
    render(<Portfolio />);
    expect(screen.getByTestId("portfolio-source-note").textContent).toMatch(/Broker positions are not included/);
    expect(screen.queryByText("No exposure.")).toBeNull();
    expect(screen.queryByText(/Daily Drawdown/)).toBeNull();
    expect(screen.getByText(/Net Loss, Last 24h/)).toBeTruthy();
  });

  it("open rows it cannot split into currencies are not 'No currency exposure.'", () => {
    exposure = { ...base, totalOpen: 2, exposureByCurrency: [], currencyExposureUnmappedRows: 2, currencyExposureUnmappedSymbols: ["EURGBP", "XAUUSD"] };
    render(<Portfolio />);
    expect(screen.queryByText("No currency exposure.")).toBeNull();
    const note = screen.getByTestId("currency-exposure-unmapped");
    expect(note.textContent).toMatch(/2 open rows \(EURGBP, XAUUSD\) could not be split into currencies/);
  });

  it("an older server without the unmapped count still does not say 'No currency exposure.' with open rows", () => {
    exposure = { ...base, totalOpen: 1, exposureByCurrency: [] };
    render(<Portfolio />);
    expect(screen.queryByText("No currency exposure.")).toBeNull();
    expect(screen.getByTestId("currency-exposure-unmapped").textContent).toMatch(/could not be split into currencies/);
  });

  it("some rows decomposed, some not: shows the split and names the rest", () => {
    exposure = { ...base, totalOpen: 2, exposureByCurrency: [{ currency: "EUR", netLots: 1 }, { currency: "USD", netLots: -1 }], currencyExposureUnmappedRows: 1, currencyExposureUnmappedSymbols: ["EURGBP"] };
    render(<Portfolio />);
    expect(screen.getByText("EUR")).toBeTruthy();
    expect(screen.getByTestId("currency-exposure-unmapped").textContent).toMatch(/1 open row \(EURGBP\) could not be split/);
  });

  it("no open rows: says there are none in this source", () => {
    exposure = { ...base, totalOpen: 0, exposureByCurrency: [], currencyExposureUnmappedRows: 0, currencyExposureUnmappedSymbols: [] };
    render(<Portfolio />);
    expect(screen.queryByText("No currency exposure.")).toBeNull();
    expect(screen.queryByTestId("currency-exposure-unmapped")).toBeNull();
  });

  it("prints a measured floating P&L", () => {
    exposure = { ...base, floatingPnl: 12.5, floatingPnlUnavailableReason: null, realizedPnlExcludedUnknown: 0 };
    render(<Portfolio />);
    expect(screen.getByTestId("floating-pnl").textContent).toBe("$12.50");
  });

  // Regression: the page was titled "Portfolio Exposure — Risk distribution
  // across markets, strategies, and currencies" and said "No currency
  // exposure." while every figure came from a frozen table of simulated rows;
  // the trader's paper book and DEMO EA positions never appear here.
  it("says the rows are simulated and the paper book and DEMO EA positions are not included, even with an older server note", () => {
    exposure = { ...base, totalOpen: 0, totalClosed: 0, floatingPnl: 0, floatingPnlUnavailableReason: null, realizedPnlExcludedUnknown: 0 };
    render(<Portfolio />);
    const scope = screen.getByTestId("portfolio-scope").textContent ?? "";
    expect(scope).toMatch(/simulat/i);
    expect(scope).toMatch(/paper book/i);
    expect(scope).toMatch(/DEMO EA positions/);
    expect(screen.queryByText("No currency exposure.")).toBeNull();
    expect(screen.queryByText(/Risk distribution across markets/)).toBeNull();
    expect(screen.getByText(/Simulated realized P&L/)).toBeTruthy();
    // A zero 24h net loss is not painted as a loss.
    expect(screen.getByTestId("daily-net-loss").className).not.toMatch(/text-destructive/);
  });
});

// Regression: "if (isLoading || !exp) return <Skeleton/>" left the page
// loading forever when the first read failed; a failed 10 s refetch kept the
// old figures with no marker; a failed correlation read made the warnings
// card vanish, which looked the same as having no correlated positions; and
// negative P&L printed as "$-12.00".
describe("portfolio page read failures", () => {
  it("a failed first read says the exposure could not be loaded, not an endless skeleton", () => {
    const refetch = vi.fn();
    exposureQ = { data: undefined, isLoading: false, isError: true, refetch };
    const { container } = render(<Portfolio />);
    expect(screen.getByTestId("portfolio-load-error").textContent).toMatch(/could not be loaded/);
    expect(container.querySelector(".animate-pulse")).toBeNull();
    screen.getByTestId("button-retry-exposure").click();
    expect(refetch).toHaveBeenCalled();
  });

  it("a failed refetch after a good read marks the kept figures as not current, with the load time", () => {
    const loadedAt = new Date("2026-10-28T11:00:00Z").getTime();
    exposureQ = { data: { ...base }, isLoading: false, isError: true, dataUpdatedAt: loadedAt, errorUpdatedAt: loadedAt + 10_000 };
    render(<Portfolio />);
    const stale = screen.getByTestId("portfolio-stale").textContent ?? "";
    expect(stale).toMatch(/not current/);
    expect(stale).toContain(new Date(loadedAt).toLocaleTimeString());
  });

  it("a successful read shows when it was loaded and no stale marker", () => {
    exposureQ = { data: { ...base }, isLoading: false, isError: false, dataUpdatedAt: Date.now() };
    render(<Portfolio />);
    expect(screen.queryByTestId("portfolio-stale")).toBeNull();
    expect(screen.getByTestId("portfolio-loaded-at").textContent).toMatch(/Loaded at/);
  });

  it("a failed correlation read says the check could not be loaded instead of vanishing", () => {
    exposure = { ...base };
    warnQ = { data: undefined, isError: true };
    render(<Portfolio />);
    expect(screen.getByTestId("correlation-load-error").textContent).toMatch(/could not be loaded/);
    expect(screen.queryByTestId("correlation-none")).toBeNull();
  });

  // Regression (review of 7b5fbc3c): detectCorrelationWarnings checks only
  // three groups, so long EURUSD + short USDCHF (one USD bet) or long EURUSD +
  // long EURGBP returns [] — and the page said "No correlated open rows in
  // this source." An empty result is "no warning raised", with what was checked.
  it("an empty correlation result says no warning was raised and names what was checked", () => {
    exposure = { ...base };
    render(<Portfolio />);
    const text = screen.getByTestId("correlation-none").textContent ?? "";
    expect(text).not.toMatch(/No correlated open rows/);
    expect(text).toMatch(/^No correlation warning was raised for the open rows in this source\./);
    expect(text).toMatch(/Only three groups are checked: two or more long EURUSD, GBPUSD, AUDUSD or NZDUSD rows; two or more US30, NAS100 or SPX500 rows in the same direction as the first one open; and two or more JPY pairs in the same direction as the first one open\./);
    expect(text).toMatch(/Other correlations, such as long EURUSD with short USDCHF, are not checked\.$/);
  });

  it("prints a negative P&L as -$12.00, not $-12.00", () => {
    exposure = { ...base, floatingPnl: -12, floatingPnlUnavailableReason: null, realizedPnl: -12, realizedPnlExcludedUnknown: 0 };
    render(<Portfolio />);
    expect(screen.getByTestId("floating-pnl").textContent).toBe("-$12.00");
    expect(screen.getByTestId("realized-pnl").textContent).toBe("-$12.00");
    expect(document.body.textContent).not.toMatch(/\$-/);
  });
});

// Regression (review of 10f7a840): computeExposure splits currencies only for
// nine hard-coded pairs (api-server lib/portfolio/exposure.ts PAIR_CURRENCIES).
// An open EURGBP, XAUUSD or suffixed "EURUSD.m" row leaves exposureByCurrency
// empty while totalOpen is 1+, and the card said "No open forex rows in this
// source." next to "Open legacy rows 1".
describe("portfolio Net Currency Exposure coverage", () => {
  const PAIRS = "EURUSD, GBPUSD, AUDUSD, USDJPY, USDCAD, USDCHF, NZDUSD, EURJPY and GBPJPY";

  it("open rows that are not on a split pair are named as not broken down, not as no forex rows", () => {
    exposure = { ...base, totalOpen: 2, exposureByMarket: { Other: 0.2 }, exposureByCurrency: [] };
    render(<Portfolio />);
    const text = screen.getByTestId("currency-exposure-coverage").textContent ?? "";
    expect(document.body.textContent).not.toMatch(/No open forex rows/);
    expect(text).toContain(`None of the 2 open rows in this source is on one of the pairs this view splits by currency (${PAIRS})`);
    expect(text).toMatch(/currency exposure is not shown/);
  });

  it("a single unsplit open row is described in the singular", () => {
    exposure = { ...base, totalOpen: 1, exposureByMarket: { Other: 0.1 }, exposureByCurrency: [] };
    render(<Portfolio />);
    expect(screen.getByTestId("currency-exposure-coverage").textContent).toContain(
      `The 1 open row in this source is not on one of the pairs this view splits by currency (${PAIRS}), so its currency exposure is not shown.`,
    );
  });

  it("a currency split says which pairs it covers and that other symbols are left out", () => {
    exposure = { ...base, totalOpen: 2, exposureByCurrency: [{ currency: "EUR", netLots: 0.1 }, { currency: "USD", netLots: -0.1 }] };
    render(<Portfolio />);
    expect(screen.getByText("EUR")).toBeTruthy();
    expect(screen.getByTestId("currency-exposure-coverage").textContent).toBe(
      `Split by currency only for ${PAIRS}. Open rows on any other symbol are not included here.`,
    );
  });

  it("the named pairs are exactly the pairs the server splits", () => {
    const src = readFileSync(resolve(__dirname, "../../../api-server/src/lib/portfolio/exposure.ts"), "utf8");
    const block = /const PAIR_CURRENCIES[^{]*\{([\s\S]*?)\n\};/.exec(src)?.[1] ?? "";
    const serverPairs = [...block.matchAll(/^\s*([A-Z]{6}):/gm)].map((m) => m[1]);
    expect(serverPairs.length).toBeGreaterThan(0);
    expect(PAIRS.replace(" and ", ", ").split(", ")).toEqual(serverPairs);
  });

  it("with no open rows at all it says so", () => {
    exposure = { ...base, totalOpen: 0, exposureByCurrency: [] };
    render(<Portfolio />);
    expect(screen.getByTestId("currency-exposure-coverage").textContent).toBe("No open rows in this source.");
  });
});
