import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import type {
  TradeHealthAssessment,
  TradeHealthResponse,
} from "@workspace/api-client-react";

// Task #600 scanner-truth regression — assertions (6) + (7).
//
// (6) A position on a symbol OTHER than the selected chart symbol can NEVER
//     render as selected-symbol ("This symbol") trade health.
// (7) Account-wide exposure (positions on other symbols) is clearly labeled as
//     such whenever it is shown.
//
// The server is the single source of truth for the match (`matchesChartSymbol`,
// the same normalization the symbolMatch handshake uses); the panel only filters
// on that flag and never re-derives a frontend symbol match. This is a pure
// render proof: the data hook is fully mocked, so it exercises the real
// component split (`assessments.filter(a => a.matchesChartSymbol)`) and nothing
// else. The empty/error/no-symbol states are covered alongside so a regression
// that collapses the split is caught here.

const mockUseGetMeTradeHealth = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useGetMeTradeHealth: (...args: unknown[]) => mockUseGetMeTradeHealth(...args),
  getGetMeTradeHealthQueryKey: () => ["get-me-trade-health"],
}));

import { TradeHealthPanel } from "./TradeHealthPanel";

function assessment(over: Partial<TradeHealthAssessment> = {}): TradeHealthAssessment {
  return {
    ticket: "T-1",
    symbol: "EURUSD",
    side: "BUY",
    accountMode: "DEMO",
    matchesChartSymbol: true,
    entryPrice: 1.085,
    state: "healthy",
    headline: "Trade is tracking your plan.",
    reasons: [],
    alert: false,
    tpProgress: { known: false, progressPct: null, note: "No take-profit set." },
    slDistance: {
      known: false,
      distancePrice: null,
      bufferRemainingPct: null,
      note: "No stop set.",
    },
    breakEven: { suggested: false, note: "" },
    partialClose: { suggested: false, note: "" },
    styleMatch: { detectedStyle: "scalp", note: "Matches your scalp style." },
    alternatives: [],
    handshake: { overallStatus: "PASS", checks: [], userFacingMessage: "", warnings: [] },
    ...over,
  } as TradeHealthAssessment;
}

function resp(over: Partial<TradeHealthResponse> = {}): TradeHealthResponse {
  return {
    evaluatedAt: "2026-06-08T12:00:00Z",
    chartSymbol: "EURUSD",
    assessments: [],
    conflicts: [],
    correlations: [],
    overtrading: [],
    overlays: [],
    summary: "Open positions.",
    safetyMode: "paper_only",
    liveLocked: true,
    readOnlyMode: true,
    allowOrderExecution: false,
    ...over,
  } as TradeHealthResponse;
}

function hookState(over: Record<string, unknown>) {
  return { data: undefined, isLoading: false, isError: false, ...over };
}

beforeEach(() => mockUseGetMeTradeHealth.mockReset());
afterEach(() => cleanup());

describe("(6)+(7) Trade Health splits this-symbol from account-wide exposure", () => {
  it("(6) a position on another symbol never appears under 'This symbol'", () => {
    // EURUSD is the selected chart symbol; V75 is an open position on a DIFFERENT
    // symbol. The server marks the match; the panel must honor it.
    const eur = assessment({ ticket: "EUR-1", symbol: "EURUSD", matchesChartSymbol: true });
    const v75 = assessment({
      ticket: "V75-1",
      symbol: "Volatility 75 Index",
      matchesChartSymbol: false,
    });
    mockUseGetMeTradeHealth.mockReturnValue(
      hookState({ data: resp({ chartSymbol: "EURUSD", assessments: [eur, v75] }) }),
    );
    render(<TradeHealthPanel chartSymbol="EURUSD" />);

    const thisSymbol = screen.getByTestId("trade-health-this-symbol");
    // The selected-symbol position is here…
    expect(within(thisSymbol).getByTestId("trade-health-card-EUR-1")).toBeTruthy();
    // …and the other-symbol position is NOT — it can never read as this-symbol health.
    expect(within(thisSymbol).queryByTestId("trade-health-card-V75-1")).toBeNull();

    const accountExposure = screen.getByTestId("trade-health-account-exposure");
    expect(within(accountExposure).getByTestId("trade-health-card-V75-1")).toBeTruthy();
    expect(within(accountExposure).queryByTestId("trade-health-card-EUR-1")).toBeNull();
  });

  it("(7) account-wide exposure is clearly labeled when shown", () => {
    const eur = assessment({ ticket: "EUR-1", symbol: "EURUSD", matchesChartSymbol: true });
    const v75 = assessment({
      ticket: "V75-1",
      symbol: "Volatility 75 Index",
      matchesChartSymbol: false,
    });
    mockUseGetMeTradeHealth.mockReturnValue(
      hookState({ data: resp({ chartSymbol: "EURUSD", assessments: [eur, v75] }) }),
    );
    render(<TradeHealthPanel chartSymbol="EURUSD" />);

    const accountExposure = screen.getByTestId("trade-health-account-exposure");
    const txt = accountExposure.textContent ?? "";
    // Explicitly labeled account-wide, and explicitly NOT this-symbol health.
    expect(txt).toMatch(/Account exposure/i);
    expect(txt).toMatch(/on other symbol/i);
    expect(txt).toMatch(/not on\s+EURUSD/i);
  });

  it("(7) the account-wide block is hidden when every position is this-symbol", () => {
    const a = assessment({ ticket: "EUR-1", symbol: "EURUSD", matchesChartSymbol: true });
    const b = assessment({ ticket: "EUR-2", symbol: "EURUSD", matchesChartSymbol: true });
    mockUseGetMeTradeHealth.mockReturnValue(
      hookState({ data: resp({ chartSymbol: "EURUSD", assessments: [a, b] }) }),
    );
    render(<TradeHealthPanel chartSymbol="EURUSD" />);

    expect(screen.getByTestId("trade-health-this-symbol")).toBeTruthy();
    // No other-symbol positions ⇒ no account-exposure section at all.
    expect(screen.queryByTestId("trade-health-account-exposure")).toBeNull();
  });

  it("renders the honest empty state with no open positions", () => {
    mockUseGetMeTradeHealth.mockReturnValue(
      hookState({ data: resp({ assessments: [] }) }),
    );
    render(<TradeHealthPanel chartSymbol="EURUSD" />);
    expect(screen.getByTestId("trade-health-empty")).toBeTruthy();
    expect(screen.queryByTestId("trade-health-this-symbol")).toBeNull();
  });
});

describe("(Task #604) Trade Health header count badge is symbol-aware", () => {
  // The header count badge must name the this-symbol / account-wide split using
  // the SAME server-derived `matchesChartSymbol` flag the body sections use, so a
  // future refactor can never silently revert it to the misleading bare count.
  // All four branches of the badge copy are asserted here off the
  // `trade-health-open-count` testid.

  it("no selected symbol → bare '{total} open'", () => {
    const a = assessment({ ticket: "A-1", symbol: "EURUSD", matchesChartSymbol: false });
    const b = assessment({ ticket: "A-2", symbol: "GBPUSD", matchesChartSymbol: false });
    // No chartSymbol selected anywhere ⇒ the panel renders all positions plainly
    // and the badge falls back to the bare count.
    mockUseGetMeTradeHealth.mockReturnValue(
      hookState({ data: resp({ chartSymbol: null, assessments: [a, b] }) }),
    );
    render(<TradeHealthPanel chartSymbol={null} />);
    expect(screen.getByTestId("trade-health-open-count").textContent).toBe("2 open");
  });

  it("all on symbol → '{n} on {symbol}'", () => {
    const a = assessment({ ticket: "EUR-1", symbol: "EURUSD", matchesChartSymbol: true });
    const b = assessment({ ticket: "EUR-2", symbol: "EURUSD", matchesChartSymbol: true });
    mockUseGetMeTradeHealth.mockReturnValue(
      hookState({ data: resp({ chartSymbol: "EURUSD", assessments: [a, b] }) }),
    );
    render(<TradeHealthPanel chartSymbol="EURUSD" />);
    expect(screen.getByTestId("trade-health-open-count").textContent).toBe(
      "2 on EURUSD",
    );
  });

  it("none on symbol → '{total} open · none on {symbol}'", () => {
    const a = assessment({
      ticket: "GBP-1",
      symbol: "GBPUSD",
      matchesChartSymbol: false,
    });
    const b = assessment({
      ticket: "V75-1",
      symbol: "Volatility 75 Index",
      matchesChartSymbol: false,
    });
    mockUseGetMeTradeHealth.mockReturnValue(
      hookState({ data: resp({ chartSymbol: "EURUSD", assessments: [a, b] }) }),
    );
    render(<TradeHealthPanel chartSymbol="EURUSD" />);
    expect(screen.getByTestId("trade-health-open-count").textContent).toBe(
      "2 open · none on EURUSD",
    );
  });

  it("mixed → '{n} on {symbol} · {total} account-wide'", () => {
    const eur = assessment({ ticket: "EUR-1", symbol: "EURUSD", matchesChartSymbol: true });
    const gbp = assessment({
      ticket: "GBP-1",
      symbol: "GBPUSD",
      matchesChartSymbol: false,
    });
    const v75 = assessment({
      ticket: "V75-1",
      symbol: "Volatility 75 Index",
      matchesChartSymbol: false,
    });
    mockUseGetMeTradeHealth.mockReturnValue(
      hookState({ data: resp({ chartSymbol: "EURUSD", assessments: [eur, gbp, v75] }) }),
    );
    render(<TradeHealthPanel chartSymbol="EURUSD" />);
    expect(screen.getByTestId("trade-health-open-count").textContent).toBe(
      "1 on EURUSD · 3 account-wide",
    );
  });
});

// ── Task #609 — survives a truthy-but-partial (half-loaded) payload ──────────
//
// Sibling hardening to SelectedMarketPanel (Task #608): a response that is
// present (truthy) but only partly populated — an assessment row missing its
// nested tpProgress / slDistance / breakEven / partialClose / styleMatch blocks
// or its reasons / alternatives lists, a list field that arrived as a non-array,
// or an array carrying a null row — must NOT throw the panel into the route
// error boundary. The panel degrades each missing piece to its honest "—" /
// hidden state and still renders the card. These are pure render proofs (the
// data hook is fully mocked); no displayed value changes for a well-formed
// payload (covered by the suites above).
describe("Task #609 — TradeHealthPanel survives a half-loaded payload", () => {
  it("renders a card for an assessment missing every nested block, without crashing", () => {
    // A truthy row with ONLY its top-level scalars — every nested object/list the
    // card dereferences is absent (e.g. a half-streamed row).
    const partial = {
      ticket: "P-1",
      symbol: "EURUSD",
      side: "BUY",
      accountMode: "DEMO",
      matchesChartSymbol: true,
      state: "healthy",
      headline: "Partial row.",
    } as unknown as TradeHealthAssessment;
    mockUseGetMeTradeHealth.mockReturnValue(
      hookState({ data: resp({ chartSymbol: "EURUSD", assessments: [partial] }) }),
    );
    expect(() =>
      render(<TradeHealthPanel chartSymbol="EURUSD" />),
    ).not.toThrow();
    // The card still renders with its honest fallbacks…
    const card = screen.getByTestId("trade-health-card-P-1");
    expect(card).toBeTruthy();
    expect(card.textContent).toContain("Partial row.");
    // …and the target-progress fallback shows the honest dash, not a crash.
    expect(card.textContent).toContain("—");
  });

  it("tolerates list fields that arrived as non-arrays and rows that are null", () => {
    // `assessments` carries a null entry; `conflicts`/`correlations`/`overtrading`
    // arrived as non-array junk. None of this may throw.
    const ok = assessment({ ticket: "OK-1", symbol: "EURUSD", matchesChartSymbol: true });
    const bad = {
      ...resp({ chartSymbol: "EURUSD" }),
      assessments: [ok, null],
      conflicts: "oops",
      correlations: undefined,
      overtrading: { not: "an array" },
    } as unknown as TradeHealthResponse;
    mockUseGetMeTradeHealth.mockReturnValue(hookState({ data: bad }));
    expect(() =>
      render(<TradeHealthPanel chartSymbol="EURUSD" />),
    ).not.toThrow();
    // The well-formed row still renders; the null row is silently dropped.
    expect(screen.getByTestId("trade-health-card-OK-1")).toBeTruthy();
  });

  it("renders the loading and error states without crashing", () => {
    mockUseGetMeTradeHealth.mockReturnValue(hookState({ isLoading: true }));
    const { rerender } = render(<TradeHealthPanel chartSymbol="EURUSD" />);
    expect(screen.getByTestId("trade-health-panel")).toBeTruthy();

    mockUseGetMeTradeHealth.mockReturnValue(hookState({ isError: true }));
    rerender(<TradeHealthPanel chartSymbol="EURUSD" />);
    expect(screen.getByTestId("trade-health-error")).toBeTruthy();
  });
});
