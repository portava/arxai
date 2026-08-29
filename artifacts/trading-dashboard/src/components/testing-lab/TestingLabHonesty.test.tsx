// Testing Lab surface-honesty guards (audit ranks 41, 68, 69).
//
// What was wrong:
//   41. A run over fabricated candles was promoted to "Ready for review" in the
//       Strategy Results tab off a green VERIFIED that the metrics alone had
//       granted, next to its own grey SYNTHETIC badge.
//   68. The backtest summary card was titled "AI review" with a "Refresh review"
//       button, over a pure deterministic template — no model, and the button
//       provably could not change the text. The Comparison card was titled
//       "{Eleanor} recommendation", hardcoding the default assistant name over a
//       four-branch if/else.
//   69. Comparison and Strategy Results read the admin-gated forward-testing
//       endpoint and let the 403 fall through to `?? 0`, so a non-admin was told
//       there were no results when results existed and were simply not visible.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ResultsHistoryTab } from "./ResultsHistoryTab";
import { ComparisonTab } from "./ComparisonTab";
import { AIBacktestReviewCard } from "@/components/backtesting/AIBacktestReviewCard";
import type { BacktestRunRow } from "./types";

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function run(over: Partial<BacktestRunRow>): BacktestRunRow {
  return {
    id: 1, strategyId: "trendContinuation", symbol: "XAUUSD", timeframe: "M5",
    totalTrades: 42, winRate: 0.6, profitFactor: 1.8, netProfitLoss: 123.4,
    status: "COMPLETED", dataSource: "synthetic", isVerified: "SYNTHETIC_NOT_VERIFIABLE",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

/** Route-aware fetch stub: backtest runs + a forward-testing response. */
function stubFetch(opts: { runs: BacktestRunRow[]; forwardStatus: number; forwardBody?: unknown }) {
  const f = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/backtest-runs")) {
      return { ok: true, status: 200, json: async () => ({ runs: opts.runs }) } as Response;
    }
    if (url.includes("/api/forward-testing")) {
      return {
        ok: opts.forwardStatus >= 200 && opts.forwardStatus < 300,
        status: opts.forwardStatus,
        json: async () => opts.forwardBody ?? { error: "Forbidden" },
      } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
  vi.stubGlobal("fetch", f);
  return f;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Strategy Results readiness verdict (rank 41)", () => {
  it("a synthetic run is never 'Ready for review', however good its metrics", async () => {
    stubFetch({ runs: [run({ dataSource: "synthetic", isVerified: "SYNTHETIC_NOT_VERIFIABLE" })], forwardStatus: 200, forwardBody: { shadowTradesTracked: 0 } });
    wrap(<ResultsHistoryTab />);
    expect(await screen.findByText(/Synthetic — not verifiable/i)).toBeTruthy();
    expect(screen.queryByText(/Ready for review/i)).toBeNull();
  });

  it("a run over real broker bars can still reach 'Ready for review'", async () => {
    stubFetch({ runs: [run({ dataSource: "broker", isVerified: "VERIFIED" })], forwardStatus: 200, forwardBody: { shadowTradesTracked: 0 } });
    wrap(<ResultsHistoryTab />);
    expect(await screen.findByText(/Ready for review/i)).toBeTruthy();
  });

  it("a run with an unknown dataSource is treated as not verifiable, not as verified", async () => {
    const r = run({ isVerified: "VERIFIED" });
    delete (r as { dataSource?: string }).dataSource;
    stubFetch({ runs: [r], forwardStatus: 200, forwardBody: { shadowTradesTracked: 0 } });
    wrap(<ResultsHistoryTab />);
    expect(await screen.findByText(/Synthetic — not verifiable/i)).toBeTruthy();
  });
});

describe("Forward-test access denial is not emptiness (rank 69)", () => {
  it("Strategy Results says the results are not readable, not that there are none", async () => {
    stubFetch({ runs: [], forwardStatus: 403 });
    wrap(<ResultsHistoryTab />);
    expect(await screen.findByText(/not readable by this session/i)).toBeTruthy();
    expect(screen.queryByText(/No forward-test results yet/i)).toBeNull();
  });

  it("Comparison refuses to compute a drift verdict it cannot see one side of", async () => {
    stubFetch({ runs: [run({})], forwardStatus: 403 });
    wrap(<ComparisonTab />);
    expect(await screen.findByText(/Forward side not readable/i)).toBeTruthy();
    expect(screen.getByText(/unknown here, not zero/i)).toBeTruthy();
  });
});

describe("Attribution and refreshability (rank 68)", () => {
  it("the Comparison verdict is not attributed to the assistant", async () => {
    stubFetch({ runs: [run({})], forwardStatus: 200, forwardBody: { shadowTradesTracked: 0, totalShadowDecisions: 0, winRate: 0, avgR: 0, maxDrawdownR: 0 } });
    const { container } = wrap(<ComparisonTab />);
    expect(await screen.findByText(/Comparison verdict/i)).toBeTruthy();
    expect(container.textContent).not.toMatch(/Eleanor/);
    expect(container.textContent).not.toMatch(/recommendation/i);
    expect(container.textContent).toMatch(/No model wrote this/i);
  });

  it("the run summary card is not called an AI review and offers no refresh", async () => {
    stubFetch({ runs: [], forwardStatus: 200 });
    const { container } = wrap(<AIBacktestReviewCard runId={1} />);
    expect(await screen.findByText(/Run summary/i)).toBeTruthy();
    expect(screen.queryByText(/AI review/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /refresh review/i })).toBeNull();
    expect(container.textContent).toMatch(/fixed template/i);
  });
});
