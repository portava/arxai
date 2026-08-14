// Task #600 — the header Action cell must be synchronized on symbol AND
// timeframe, not symbol alone.
//
// THE REGRESSION THIS LOCKS: the Focus-tab scalp card reads M1 and lifts its
// setup-aware verdict ("Ready now") into the page store. The header's Action
// cell adopts that lifted verdict so the two can never disagree. But the scalp
// verdict is an M1 verdict — if the store is keyed by symbol ALONE, switching the
// chart to 15m (same symbol) leaves the header showing the stale M1 "Ready now"
// while the user looks at a 15m chart that has no such setup. The fix keys the
// lifted verdict by symbol+timeframe (mirroring rubyReadStore) and reads it back
// under the SAME coerced timeframe, so the lifted verdict only ever shows on the
// timeframe it was actually computed for; every other timeframe falls back to the
// honest data-only verdict.
//
// This is a TRUE end-to-end render proof, not a store unit test or a source scan:
// it mounts the REAL publisher (RubyScalpFocusCard → ScalpSignalCard, which is
// what actually picks the "1m" bus key) AND the REAL ScannerHeaderSummary inside
// ONE real SelectedActionStoreProvider, then asserts the header's Action cell.
// Only the page's data hooks are stubbed (symbol/timeframe/truth/mode) and the
// scalp mutation is resolved instantly — the store, the timeframe coercion, and
// BOTH the publish and consume sides are real, so a regression on EITHER side
// (publisher writing "M1", or the header dropping the timeframe arg) flips an
// assertion.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within, act } from "@testing-library/react";
import { PENDING_RESOLVE_TIMEOUT_MS } from "@/lib/scannerActionability";

import type { ScalpResult } from "@workspace/api-client-react";
import type { ScannerTruth } from "@/lib/scannerTruth";

// ── Controllable selected timeframe (the variable under test) ────────────────
let currentTimeframe = "1m";

// ── Controllable selected symbol + scalp resolve (cold-start proof) ──────────
let currentSymbol = "EURUSD";
// When false, the scalp mutation never resolves — simulating the in-flight
// window right after a symbol switch (the cold-start gap under test).
let scalpResolves = true;
// When true, the scalp mutation errors — simulating a failed setup check.
let scalpFails = false;
// When false, the symbol+timeframe-keyed truth read has not resolved yet
// (mid-switch / first load) — the ONLY window in which the header may show
// the neutral PENDING ("Checking…") state.
let truthLoaded = true;

// ── The data-only fallback verdict the header derives without a lifted card ──
// Deliberately DIFFERENT from the card's "Ready now" so the two outcomes are
// unambiguous: when the lifted verdict applies we see "Ready now"; when it does
// NOT (wrong timeframe) we see this fallback instead.
const DATA_ONLY_ACTIONABILITY = "WAIT_FOR_CONFIRMATION" as const;

function makeTruth(): ScannerTruth {
  return {
    strip: {
      data: { verdict: "Live", detail: "Live feed confirmed." },
      ruby: { detail: "" },
      trading: { verdict: "Enabled", detail: "" },
    },
    candles: {
      lastClose: 1.1,
      sourceTechnical: "test",
      count: 300,
      minRequired: 200,
      status: "CONFIRMED",
    },
    consolidated: {
      rubyReadStatus: "NO_READ",
      scannerActionability: DATA_ONLY_ACTIONABILITY,
      userMessage: "Live data is confirmed.",
      internalReasonCode: "FEED_OK",
    },
    dataHealth: { sourceNote: "ARX market data." },
  } as unknown as ScannerTruth;
}

// The scalp result the Focus card resolves. Built inside vi.hoisted so the
// (hoisted) api-client mock factory can reference it without a TDZ error. A
// clean, READY result → the engine yields the READY_NOW verdict ("Ready now")
// the header should adopt ONLY on the timeframe the scalp card actually read.
const { scalpResult } = vi.hoisted(() => {
  const flame = {
    scalpStatus: "STRONG",
    readDirection: "BUY",
    scalpScore: 80,
    flameStage: "RUN_ON",
    flameAgeCandles: 3,
    freshness: "FRESH",
    entryTiming: "CLEAN",
    chaseRisk: "LOW",
    runway: "CLEAR",
    executionQuality: "GOOD",
    htfContext: "ALIGNED",
    setupType: "CONTINUATION",
    riskPersonality: "BALANCED",
    whyNow: null,
    entryTrigger: null,
    targetIdea: null,
    invalidationIdea: null,
    decayNote: null,
    blind: false,
  };
  const result = {
    symbol: "EURUSD",
    displayName: "EUR/USD",
    assetClass: "forex",
    direction: "BUY",
    scalpType: "Momentum",
    mode: "ANY",
    status: "READY",
    qualityScore: 80,
    confidenceLabel: "Strong",
    entryType: "MARKET_BUY",
    entryZone: { from: 1.1, to: 1.1005 },
    currentPrice: 1.1002,
    takeProfit: { quick: 1.101, main: 1.102, stretch: 1.103 },
    stopLoss: 1.099,
    invalidationPrice: 1.0985,
    suggestedLot: 0.1,
    minLot: 0.01,
    maxLot: 5,
    lotStep: 0.01,
    digits: 5,
    targetProfitAmount: 20,
    estimatedProfitMainTP: 20,
    estimatedRiskAmount: 10,
    rewardToRisk: 2,
    estimatedMargin: 100,
    spreadRisk: "LOW",
    slippageRisk: "LOW",
    newsRisk: "LOW",
    timingStatus: "VALID_NOW",
    validForSeconds: 90,
    expiresAt: new Date(Date.now() + 90_000).toISOString(),
    chaseWarning: null,
    plainEnglishReason: "Clean momentum continuation.",
    riskWarning: null,
    targetRealityCheck: "REALISTIC",
    userAction: "READY_TO_REVIEW",
    canBuildTrade: true,
    canWatch: true,
    noTradeReason: null,
    flame,
    generatedAt: new Date().toISOString(),
  };
  return { scalpResult: result };
});

// ── Stub ONLY the header's data hooks; the store + coercion stay real ────────
vi.mock("@/lib/use-chart-symbol", () => ({
  useChartSymbol: () => [currentSymbol, () => {}],
  bareSymbol: (s: string) => s,
  setChartSymbol: () => {},
}));
vi.mock("@/hooks/useScannerTimeframe", () => ({
  useScannerTimeframe: () => [currentTimeframe, () => {}],
}));
vi.mock("@/hooks/useSymbolTruth", () => ({
  // The real hook is keyed by symbol+timeframe with no keepPreviousData:
  // `scannerTruth` is null exactly while the current key's read is in flight,
  // and ALWAYS the current key's resolved read when present. `truthLoaded`
  // models that gap.
  useSymbolTruth: () => ({ scannerTruth: truthLoaded ? makeTruth() : null, verdict: null }),
}));
vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({ shouldShowAdminDiagnostics: false }),
}));

// The Focus card's scalp read — override the mutation hook to resolve instantly
// with the READY result, keeping every OTHER api-client export real (the header
// reads TruthVerdict* enums from the same module).
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useCreateMeScalpFocus: () => ({
      mutate: (
        vars: { data?: { symbol?: string } },
        opts?: { onSuccess?: (d: ScalpResult) => void; onError?: (e: Error) => void },
      ) => {
        if (scalpFails) opts?.onError?.(new Error("scalp read failed"));
        else if (scalpResolves) {
          // Echo the REQUESTED symbol back (like the real API): the card
          // publishes under r.symbol, so a frozen symbol would trip the
          // stale-symbol guard on every switch.
          opts?.onSuccess?.({
            ...(scalpResult as ScalpResult),
            symbol: vars?.data?.symbol ?? (scalpResult as ScalpResult).symbol,
          });
        }
      },
      isPending: false,
      isError: false,
    }),
  };
});

// Imported AFTER the mocks so the components pick up the stubbed hooks.
import { RubyScalpFocusCard } from "./RubyScalpFocusCard";
import { ScannerHeaderSummary } from "./ScannerHeaderSummary";
import { SelectedActionStoreProvider } from "./selectedActionStore";

function sharedTree(symbol: string) {
  return (
    <SelectedActionStoreProvider>
      {/* REAL publisher — lifts its M1 ("1m") verdict into the store */}
      <RubyScalpFocusCard symbol={symbol} />
      {/* REAL consumer — its Action cell reads the lifted verdict back */}
      <ScannerHeaderSummary running={false} />
    </SelectedActionStoreProvider>
  );
}

function renderShared() {
  return render(sharedTree(currentSymbol));
}

async function actionVerdictText(): Promise<string> {
  const pill = await screen.findByTestId("scanner-header-action");
  return pill.textContent ?? "";
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  currentTimeframe = "1m";
  currentSymbol = "EURUSD";
  scalpResolves = true;
  scalpFails = false;
  truthLoaded = true;
});

describe("ScannerHeaderSummary — Action cell synchronized on symbol AND timeframe (Task #600)", () => {
  it("adopts the lifted scalp verdict ('Ready now') when the selected timeframe IS the scalp's 1m", async () => {
    currentTimeframe = "1m";
    renderShared();

    // The card publishes READY_NOW under (EURUSD, "1m"); the header reads it back
    // under the same coerced "1m" → it must show the lifted "Ready now", NOT the
    // data-only fallback. (Also proves the publisher used the bus form "1m": had
    // it published "M1", the header's get(EURUSD,"1m") would miss and this would
    // fall back to the data-only "Wait for confirmation".)
    const action = within(await screen.findByTestId("scanner-header-action"));
    expect(await action.findByText("Ready now")).toBeTruthy();
    expect(action.queryByText("Wait for confirmation")).toBeNull();
    expect(action.queryByText("Checking…")).toBeNull();
  });

  it("does NOT show the stale 1m verdict on a different timeframe — mirrors the resolved data-only verdict", async () => {
    currentTimeframe = "15m";
    renderShared();

    // The card still lifts its M1 verdict under (EURUSD, "1m"), but the header
    // is now on 15m → get(EURUSD,"15m") misses. The truth read for 15m HAS
    // resolved (truthLoaded), and its data-only verdict is the resolved
    // scanner verdict the chart badge shows for this exact key — so the
    // header must mirror it IMMEDIATELY ("Wait for confirmation"): never the
    // stale 1m "Ready now", and never a "Checking…" placeholder while the
    // chart already displays a resolved verdict (the desync bug this locks).
    const action = within(await screen.findByTestId("scanner-header-action"));
    expect(await action.findByText("Wait for confirmation")).toBeTruthy();
    expect(action.queryByText("Ready now")).toBeNull();
    expect(action.queryByText("Checking…")).toBeNull();
  });

  it("the two timeframes resolve to DIFFERENT action verdicts from the SAME lifted card", async () => {
    currentTimeframe = "1m";
    renderShared();
    const onM1 = await actionVerdictText();
    cleanup();

    currentTimeframe = "15m";
    renderShared();
    const on15m = await actionVerdictText();

    expect(onM1).toContain("Ready now");
    expect(on15m).toContain("Wait for confirmation");
    expect(onM1).not.toBe(on15m);
  });
});

// ── Cold-start honesty on SYMBOL switch (display-only pending state) ──────────
//
// The truth source is keyed by symbol+timeframe with no keepPreviousData, so
// mid-switch BOTH the lifted store AND the truth read miss the new key — the
// genuinely-unresolved gap. This proof drives the REAL publisher + consumer
// through a symbol switch with the new symbol's scalp read AND truth read
// still in flight and asserts the gap renders the neutral "Checking…" state
// only — never the previous symbol's verdict. Once the truth read resolves,
// the header must mirror its verdict immediately.
describe("ScannerHeaderSummary — symbol switch never shows a stale or fabricated verdict", () => {
  it("mid-switch (reads in flight): neutral 'Checking…', then mirrors the truth verdict when it lands", async () => {
    // Step 1 — EURUSD resolves instantly: the lifted "Ready now" shows.
    currentTimeframe = "1m";
    currentSymbol = "EURUSD";
    scalpResolves = true;
    const view = renderShared();
    const action = within(await screen.findByTestId("scanner-header-action"));
    expect(await action.findByText("Ready now")).toBeTruthy();

    // Step 2 — switch to GBPUSD while its scalp AND truth reads are in flight.
    scalpResolves = false;
    truthLoaded = false;
    currentSymbol = "GBPUSD";
    view.rerender(sharedTree("GBPUSD"));

    // The unresolved gap must be honest-neutral: "Checking…" — never the
    // stale EURUSD "Ready now", never a fabricated semantic verdict.
    const pill = await screen.findByTestId("scanner-header-action");
    expect(pill.textContent).toContain("Checking…");
    expect(screen.queryByText("Ready now")).toBeNull();
    expect(screen.queryByText("Wait for confirmation")).toBeNull();

    // Step 3 — the truth read for GBPUSD lands: the header mirrors its
    // resolved data-only verdict immediately (no timer, no lifted verdict).
    truthLoaded = true;
    view.rerender(sharedTree("GBPUSD"));
    const resolved = await screen.findByTestId("scanner-header-action");
    expect(resolved.textContent).toContain("Wait for confirmation");
    expect(resolved.textContent).not.toContain("Checking…");
  });
});

// ── Bounded pending — "Checking…" can NEVER hang forever (the stuck-verdict fix) ──
//
// PENDING now shows ONLY while NO verdict of any kind exists for the current
// key (no lifted card verdict AND the truth read hasn't resolved). If the
// truth read never lands (dead feed / failed fetch), nothing will ever
// publish — so a hard timeout converts the gap to the FINAL honest
// "No confirmation" state, and a failed scalp read resolves immediately as
// "Check failed". A RESOLVED truth verdict always renders instead of either.
describe("ScannerHeaderSummary — 'Checking…' always resolves to a final state", () => {
  it("hard timeout: 'Checking…' becomes FINAL 'No confirmation' after PENDING_RESOLVE_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    // 15m with the truth read never landing: the scalp card publishes only
    // under "1m" AND no data-only verdict ever arrives for this key —
    // exactly the forever-hang scenario.
    currentTimeframe = "15m";
    truthLoaded = false;
    renderShared();

    let pill = screen.getByTestId("scanner-header-action");
    expect(pill.textContent).toContain("Checking…");

    // Just before the deadline it is still (honestly) pending…
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_RESOLVE_TIMEOUT_MS - 100);
    });
    pill = screen.getByTestId("scanner-header-action");
    expect(pill.textContent).toContain("Checking…");

    // …and past the deadline it MUST resolve to the final honest state.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    pill = screen.getByTestId("scanner-header-action");
    expect(pill.textContent).toContain("No confirmation");
    expect(pill.textContent).not.toContain("Checking…");
    // Still no fabricated semantic verdict for a setup that was never read.
    expect(screen.queryByText("Ready now")).toBeNull();
    expect(screen.queryByText("Wait for confirmation")).toBeNull();
  });

  it("timeout timer is keyed by symbol+timeframe: a switch restarts the window (no cross-key expiry)", async () => {
    vi.useFakeTimers();
    currentTimeframe = "15m";
    truthLoaded = false;
    const view = renderShared();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_RESOLVE_TIMEOUT_MS + 100);
    });
    expect(screen.getByTestId("scanner-header-action").textContent).toContain("No confirmation");

    // Switch symbol → fresh key → a NEW bounded pending window, not an
    // instantly-expired one and not a stale expiry carried across.
    scalpResolves = false;
    currentSymbol = "GBPUSD";
    view.rerender(sharedTree("GBPUSD"));
    expect(screen.getByTestId("scanner-header-action").textContent).toContain("Checking…");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_RESOLVE_TIMEOUT_MS + 100);
    });
    expect(screen.getByTestId("scanner-header-action").textContent).toContain("No confirmation");
  });

  it("a late-resolving truth read beats expiry: 'No confirmation' is replaced by the real verdict", async () => {
    vi.useFakeTimers();
    currentTimeframe = "15m";
    truthLoaded = false;
    const view = renderShared();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_RESOLVE_TIMEOUT_MS + 100);
    });
    expect(screen.getByTestId("scanner-header-action").textContent).toContain("No confirmation");

    // The truth read finally lands (slow feed): the resolved data-only
    // verdict must render — expiry never overrides a resolved verdict.
    truthLoaded = true;
    view.rerender(sharedTree(currentSymbol));
    const pill = screen.getByTestId("scanner-header-action");
    expect(pill.textContent).toContain("Wait for confirmation");
    expect(pill.textContent).not.toContain("No confirmation");
  });

  it("failed scalp read: resolves IMMEDIATELY to FINAL 'Check failed' — no timeout needed", async () => {
    currentTimeframe = "1m";
    scalpFails = true;
    renderShared();

    const action = within(await screen.findByTestId("scanner-header-action"));
    expect(await action.findByText("Check failed")).toBeTruthy();
    expect(action.queryByText("Checking…")).toBeNull();
    expect(action.queryByText("Ready now")).toBeNull();
  });

  it("a successful re-read overwrites 'Check failed' with the real verdict", async () => {
    currentTimeframe = "1m";
    scalpFails = true;
    const view = renderShared();
    expect((await screen.findByTestId("scanner-header-action")).textContent).toContain("Check failed");

    // The retry succeeds (same symbol) — the real lifted verdict must win.
    scalpFails = false;
    scalpResolves = true;
    view.rerender(sharedTree(currentSymbol));
    // Re-render alone doesn't rerun the fetch effect (same key); simulate the
    // user's Refresh via a symbol round-trip, which re-triggers the real
    // publisher path end-to-end.
    currentSymbol = "USDJPY";
    view.rerender(sharedTree("USDJPY"));
    const action = within(await screen.findByTestId("scanner-header-action"));
    expect(await action.findByText("Ready now")).toBeTruthy();
    expect(action.queryByText("Check failed")).toBeNull();
  });
});
