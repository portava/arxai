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
import { BacktestingTab } from "./BacktestingTab";
import { AIBacktestReviewCard } from "@/components/backtesting/AIBacktestReviewCard";
import { BacktestResultsDashboard } from "@/components/backtesting/BacktestResultsDashboard";
import { backtestVerdict } from "@/components/backtesting/verificationVerdict";
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

/**
 * Stub for the single-run detail read (`/api/backtest-runs/:id`), whose payload
 * carries the extra KPI fields the list rows do not.
 */
function stubRun(r: BacktestRunRow) {
  const detail = {
    initialBalance: 10_000, winningTrades: 25, losingTrades: 17,
    maxDrawdown: 42.5, averageRr: 1.4, expectancy: 0.3, aiSummary: null,
    ...r,
  };
  const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => detail } as Response));
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

// ── Rank 41, READ PATH ──────────────────────────────────────────────────────
//
// The write path stopped stamping VERIFIED on a synthetic run, but that only
// governs rows created after it. Every backtest_runs row written BEFORE the fix
// still carries dataSource:"synthetic" WITH isVerified:"VERIFIED", and this repo
// has no migration system to correct them — so those rows keep that pair
// indefinitely and the read surfaces have to be the gate too.
//
// The gate had been applied to ResultsHistoryTab only. BacktestingTab keyed both
// the word and the green colour off r.isVerified alone, and
// BacktestResultsDashboard's detail pill did the same. These are the two
// surfaces that still rendered the audit's exact symptom.

describe("Rank 41 read path — a stored VERIFIED on synthetic data is not displayed", () => {
  /** A row exactly as it would have been persisted before the write-path fix. */
  const legacy = () => run({ dataSource: "synthetic", isVerified: "VERIFIED" });

  it("BacktestingTab's recent-runs list refuses the legacy VERIFIED", async () => {
    stubFetch({ runs: [legacy()], forwardStatus: 200 });
    const { container } = wrap(<BacktestingTab />);
    expect(await screen.findByText(/NOT VERIFIABLE/i)).toBeTruthy();
    expect(container.textContent).not.toMatch(/\bVERIFIED\b(?!.*NOT)/);
    expect(container.querySelector(".text-success")).toBeNull();
  });

  it("BacktestingTab still shows VERIFIED for a run over real broker bars", async () => {
    stubFetch({ runs: [run({ dataSource: "broker", isVerified: "VERIFIED" })], forwardStatus: 200 });
    const { container } = wrap(<BacktestingTab />);
    expect(await screen.findByText(/^VERIFIED$/)).toBeTruthy();
    expect(container.querySelector(".text-success")).not.toBeNull();
  });

  it("BacktestResultsDashboard's detail pill refuses the legacy VERIFIED", async () => {
    stubRun(legacy());
    const { container } = wrap(<BacktestResultsDashboard runId={1} />);
    expect(await screen.findByText(/NOT VERIFIABLE/i)).toBeTruthy();
    expect(container.textContent).toMatch(/SYNTHETIC DATA/);
    expect(container.textContent).not.toMatch(/\bVERIFIED\b(?!.*NOT)/);
  });

  it("BacktestResultsDashboard shows VERIFIED only over real broker bars", async () => {
    stubRun(run({ dataSource: "broker", isVerified: "VERIFIED" }));
    wrap(<BacktestResultsDashboard runId={1} />);
    expect(await screen.findByText(/^VERIFIED$/)).toBeTruthy();
  });

  it("a run whose provenance is unrecorded is not verified either", () => {
    const r = { isVerified: "VERIFIED", status: "COMPLETED" };
    const v = backtestVerdict(r);
    expect(v.isVerified).toBe(false);
    expect(v.label).toBe("NOT VERIFIABLE");
    expect(v.title).toMatch(/does not record where its candles came from/i);
  });

  it("the shared rule never returns a verified verdict for a non-broker source", () => {
    for (const src of ["synthetic", "SYNTHETIC", "simulator", "", null, undefined]) {
      const v = backtestVerdict({ dataSource: src as string | null | undefined, isVerified: "VERIFIED" });
      expect(v.isVerified).toBe(false);
      expect(v.label).not.toBe("VERIFIED");
      expect(v.tone).not.toBe("verified");
    }
  });
});
