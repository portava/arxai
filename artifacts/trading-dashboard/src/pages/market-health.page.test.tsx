// THEME G-FINISH — Market Health reads the live router, not the simulator.
//
// BEFORE
//   The page rendered a composite "TRADEABLE" / "CAUTION" verdict from
//   `/api/market/health`, which is built entirely out of
//   `marketSimulator.quote()` behind `ACTIVE_PROVIDER = "SIMULATOR"` and a
//   hardcoded `MT5_BRIDGE_CONNECTED = false`. Bid/ask, spread bps, ATR,
//   volatility ratio, session state and news events were ALL simulated — and
//   the page turned those simulated numbers into a tradeability verdict shown
//   to real traders. A page whose entire job is answering "is this feed good
//   enough to trade?" was answering it from invented data.
//
// AFTER
//   It consumes `useScannerTruth`, which composes the one honest market query
//   (GET /api/chart/candles) and resolves it through the shared
//   `resolveScannerTruth` contract. Scanner, chart, Ruby reads and this page
//   now share one evaluator, so they cannot disagree about feed liveness.
//
//   The real "Market Data Provider" card (/api/me/market-data/status) and its
//   refresh action are kept — those were never simulated.
//
// DROPPED, deliberately: spread-bps / ATR / volatility / session cards (no
// live-router equivalent — showing nothing beats showing invented values), the
// simulator news block (News Risk has its own real page), and the hardcoded
// "MT5 bridge deferred" badge (replaced by the real brokerFeedActive).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");

function read(rel: string): string {
  return readFileSync(resolve(SRC, rel), "utf8");
}

const page = read("pages/market-health.tsx");
/** Comments stripped — the header documents the simulator it replaced. */
const code = page
  .split("\n")
  .filter((line) => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join("\n");

describe("G-FINISH — the simulator feed is gone", () => {
  it("no longer calls /api/market/health", () => {
    expect(code).not.toMatch(/\/api\/market\/health/);
  });

  it("renders no simulator-derived tradeability verdict", () => {
    // The old labels came straight out of marketDataLayer.marketHealth().
    expect(code).not.toMatch(/TRADEABLE/);
    expect(code).not.toMatch(/SPREAD_TOO_HIGH|SPREAD_ACCEPTABLE/);
    expect(code).not.toMatch(/HIGH_VOLATILITY|LOW_LIQUIDITY/);
  });

  it("no longer renders a hardcoded MT5-deferred badge", () => {
    expect(code).not.toMatch(/mt5BridgeConnected/);
    expect(code).not.toMatch(/bridge deferred/i);
  });
});

describe("G-FINISH — it reads the shared live-router truth", () => {
  it("consumes useScannerTruth", () => {
    expect(code).toMatch(/useScannerTruth\(/);
  });

  it("that hook reads the one honest candles query", () => {
    const hook = read("hooks/useScannerTruth.ts");
    expect(hook).toMatch(/fetchChartCandles/);
    expect(hook).toMatch(/resolveScannerTruth/);
  });

  it("shows the resolved data verdict and its detail", () => {
    expect(code).toMatch(/truth\.strip\.data\.verdict/);
    expect(code).toMatch(/truth\.strip\.data\.detail/);
  });

  it("shows real quote, candle and consistency truth", () => {
    expect(code).toMatch(/truth\.quote\./);
    expect(code).toMatch(/truth\.candles\./);
    expect(code).toMatch(/truth\.consistency\./);
  });

  it("reports broker-feed and entry-validity from the truth, not a constant", () => {
    expect(code).toMatch(/truth\.brokerFeedActive/);
    expect(code).toMatch(/truth\.actionable/);
    expect(code).toMatch(/truth\.isLivePrice/);
  });
});

describe("G-FINISH — the real provider card is preserved", () => {
  it("still reads /api/me/market-data/status", () => {
    expect(code).toMatch(/\/api\/me\/market-data\/status/);
  });

  it("still offers the explicit provider refresh", () => {
    expect(code).toMatch(/\/api\/me\/market-data\/refresh/);
  });

  it("still surfaces provider rate-limiting honestly", () => {
    expect(code).toMatch(/rateLimitStatus/);
    expect(code).toMatch(/badge-provider-rate-limited/);
  });
});

describe("G-FINISH — absence is stated, not papered over", () => {
  it("says why the spread/volatility/session panels are gone", () => {
    expect(page).toMatch(/removed with the simulator/i);
  });

  it("points news risk at its real page rather than keeping a copy", () => {
    expect(code).toMatch(/\/news-risk/);
  });

  it("shows nothing rather than a guess when the read fails", () => {
    expect(page).toMatch(/rather than a guessed verdict/i);
  });

  it("places no trades", () => {
    expect(code).not.toMatch(/execute|dispatch|placeOrder/i);
  });
});
