import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { ScalpResult } from "@workspace/api-client-react";

// RubyScalpScan — the merged Broad-scan scalp surface (surface consolidation
// item D: RubyScalpRanking + RubyScalpBuilder → ONE panel with an optional
// goal picker). This suite proves the merge kept both engines honest:
//
//   1. No goal → Scan drives the RANK path (POST /me/scalp/rank) and never
//      touches the build mutation.
//   2. Goal open with a real amount → the same button drives the BUILD path
//      with the typed target/risk — nothing is guessed or defaulted in.
//   3. Goal open but EMPTY → still the rank path: an unfilled goal must not
//      invent a target.
//   4. The rank path's honest empty ("no clean scalp") renders verbatim.
//   5. The build path's honest no-trade (`noTradeReason`) renders verbatim —
//      the engine's refusal is never papered over with a fabricated pick.
//
// Both mutations are the generated hooks over the shared scalp engine, whose
// rank/build inputs fetch a REAL live quote per symbol (the C2 fix) and read
// the flame blind (honest NONE) on the broad path — the merge changed the UI,
// not the data path.

const rankMutate = vi.fn();
const buildMutate = vi.fn();
let rankPending = false;
let buildPending = false;

vi.mock("@workspace/api-client-react", () => ({
  useCreateMeScalpRank: () => ({ mutate: rankMutate, isPending: rankPending, isError: false }),
  useCreateMeScalpBuild: () => ({ mutate: buildMutate, isPending: buildPending, isError: false }),
}));

vi.mock("@/lib/assistant-name", () => ({
  useAssistantName: () => ({ name: "Ruby" }),
}));

// The shared result card has its own suite; stub it to a symbol marker.
vi.mock("./ScalpSignalCard", () => ({
  ScalpSignalCard: ({ result }: { result: ScalpResult }) => (
    <div data-testid={`scalp-card-${result.symbol}`} />
  ),
}));

import { RubyScalpScan } from "./RubyScalpScan";

function scalpResult(over: Partial<ScalpResult> = {}): ScalpResult {
  return {
    symbol: "EURUSD",
    displayName: "EURUSD",
    direction: "BUY",
    rewardToRisk: 1.8,
    flame: null,
    ...over,
  } as unknown as ScalpResult;
}

beforeEach(() => {
  rankPending = false;
  buildPending = false;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function clickScan() {
  fireEvent.click(screen.getByTestId("scalp-rank-scan"));
}

function openGoal() {
  fireEvent.click(screen.getByTestId("scalp-goal-toggle"));
}

describe("RubyScalpScan — path selection", () => {
  it("scans the universe (rank path) when no goal is set", () => {
    render(<RubyScalpScan />);
    clickScan();
    expect(rankMutate).toHaveBeenCalledTimes(1);
    expect(buildMutate).not.toHaveBeenCalled();
    expect(rankMutate.mock.calls[0][0]).toEqual({
      data: { marketGroup: "all", mode: "ANY", limit: 8 },
    });
  });

  it("an OPEN but EMPTY goal still ranks — no invented target", () => {
    render(<RubyScalpScan />);
    openGoal();
    // Honest affordance: the panel says empty fields keep the full ranking.
    expect(screen.getByTestId("scalp-goal-inactive")).toBeTruthy();
    clickScan();
    expect(rankMutate).toHaveBeenCalledTimes(1);
    expect(buildMutate).not.toHaveBeenCalled();
  });

  it("a real goal amount switches the same button to the build path, verbatim", () => {
    render(<RubyScalpScan />);
    openGoal();
    fireEvent.change(screen.getByTestId("scalp-builder-target"), { target: { value: "25" } });
    fireEvent.change(screen.getByTestId("scalp-builder-risk"), { target: { value: "10" } });
    expect(screen.getByTestId("scalp-rank-scan").textContent).toMatch(/Find Best Scalp/);
    clickScan();
    expect(buildMutate).toHaveBeenCalledTimes(1);
    expect(rankMutate).not.toHaveBeenCalled();
    expect(buildMutate.mock.calls[0][0]).toEqual({
      data: {
        targetProfitAmount: 25,
        riskAmount: 10,
        mode: "ANY",
        marketGroup: "all",
        riskPersonality: "BALANCED",
      },
    });
  });

  it("a non-numeric goal is an honest null, not a fabricated amount", () => {
    render(<RubyScalpScan />);
    openGoal();
    fireEvent.change(screen.getByTestId("scalp-builder-target"), { target: { value: "abc" } });
    clickScan();
    // Unparseable target → goal inactive → rank path.
    expect(rankMutate).toHaveBeenCalledTimes(1);
    expect(buildMutate).not.toHaveBeenCalled();
  });
});

describe("RubyScalpScan — honest results", () => {
  it("renders the rank path's honest 'no clean scalp' empty state", () => {
    rankMutate.mockImplementation((_args, opts) => {
      opts.onSuccess({ opportunities: [], best: null, safer: null, fastest: null, scanned: 12 });
    });
    render(<RubyScalpScan />);
    clickScan();
    const empty = screen.getByTestId("scalp-rank-empty");
    expect(empty.textContent).toMatch(/scanned 12 markets and found no clean scalp/);
  });

  it("renders rank picks and routes a pick through onPick (no trade placed)", () => {
    const best = scalpResult({ symbol: "XAUUSD", displayName: "Gold" });
    rankMutate.mockImplementation((_args, opts) => {
      opts.onSuccess({ opportunities: [best], best, safer: null, fastest: null, scanned: 5 });
    });
    const onPick = vi.fn();
    render(<RubyScalpScan onPick={onPick} />);
    clickScan();
    fireEvent.click(screen.getByTestId("scalp-pick-best"));
    expect(onPick).toHaveBeenCalledWith(best);
    expect(screen.getByTestId("scalp-card-XAUUSD")).toBeTruthy();
  });

  it("renders the build path's engine no-trade reason VERBATIM", () => {
    buildMutate.mockImplementation((_args, opts) => {
      opts.onSuccess({
        primary: null,
        alternatives: [],
        scanned: 9,
        noTradeReason: "Risk too small to clear the minimum lot on any scanned market.",
      });
    });
    render(<RubyScalpScan />);
    openGoal();
    fireEvent.change(screen.getByTestId("scalp-builder-risk"), { target: { value: "1" } });
    clickScan();
    expect(screen.getByTestId("scalp-builder-none").textContent).toBe(
      "Risk too small to clear the minimum lot on any scanned market.",
    );
  });

  it("a goal-fit result renders the primary pick plus alternatives", () => {
    const primary = scalpResult({ symbol: "GBPUSD" });
    const alt = scalpResult({ symbol: "USDJPY" });
    buildMutate.mockImplementation((_args, opts) => {
      opts.onSuccess({ primary, alternatives: [alt], scanned: 6, noTradeReason: null });
    });
    render(<RubyScalpScan />);
    openGoal();
    fireEvent.change(screen.getByTestId("scalp-builder-target"), { target: { value: "20" } });
    clickScan();
    expect(screen.getByTestId("scalp-card-GBPUSD")).toBeTruthy();
    expect(screen.getByTestId("scalp-card-USDJPY")).toBeTruthy();
  });
});
