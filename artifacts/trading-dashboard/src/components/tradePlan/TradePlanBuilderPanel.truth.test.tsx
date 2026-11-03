// Trade Plan Builder truth.
//
//  - "Convert" only creates a practice confirmation request in PENDING that
//    expires 5 minutes later; the server records that as plan status
//    EXECUTED. Nothing was executed, so the plan must never be badged
//    EXECUTED, the button must not promise "Live Execution", and the request's
//    real state (waiting, expired, cancelled ...) must be read, not assumed.
//
//  - Editing a validated plan makes it a DRAFT whose stored checklist and AI
//    review describe the earlier values. They must say they are out of date,
//    never "Ready — plan passes all blocking checks" / "All pre-trade checks
//    pass" next to the new prices.
//
//  - A validate the server refuses (409 news no-trade window / critical
//    portfolio risk) leaves the stored status unchanged. The refusal must be
//    shown, and an earlier READY must not keep presenting the plan as ready
//    to send.
//
//  - Validate returns whether Chart Truth was checked and, when it limited
//    the plan, a note and the confidence capped at the Chart Truth score.
//    The panel showed none of it: "Confidence 80% · Strong" stayed green.
//
// Real QueryClient and the real panel. fetch is stubbed per URL; the news and
// multi-timeframe cards (their own fetches, their own tests) are stubbed out.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../multiTimeframe", () => ({ MultiTimeframeAlignmentCard: () => null }));
vi.mock("../news", () => ({ NewsRiskCard: () => null }));

import { TradePlanBuilderPanel } from "./TradePlanBuilderPanel";

type Route = (init?: RequestInit) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
let routes: Record<string, Route> = {};
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  const handler = routes[`${method} ${url}`];
  if (!handler) throw new Error(`unexpected fetch ${method} ${url}`);
  const { status, body } = await handler(init);
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
});

function plan(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 11, symbol: "EURUSD", directionBias: "BUY", strategyId: "breakout", marketCondition: "TRENDING",
    entryConditions: null, invalidationConditions: null, stopLossPlan: null, takeProfitPlan: null,
    entryPrice: 1.1, stopLoss: 1.095, takeProfit: 1.11, lotSize: 0.1, riskAmount: 50, maxLossAllowed: 100,
    rewardToRiskTarget: 1.5, confidenceLevel: 80, status: "DRAFT", aiSummary: null, checklist: null,
    executionConfirmationId: null, createdAtIso: new Date().toISOString(), updatedAtIso: new Date().toISOString(),
    ...patch,
  };
}

function confirmation(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7, symbol: "EURUSD", direction: "BUY", lotSize: 0.1, practiceMode: true, status: "PENDING",
    executed: false, executionResult: null, executedTradeId: null,
    confirmedAtIso: null, cancelledAtIso: null, executedAtIso: null,
    expiresAtIso: new Date(Date.now() + 4 * 60_000).toISOString(),
    createdAtIso: new Date(Date.now() - 60_000).toISOString(),
    ...patch,
  };
}

let client: QueryClient;
function renderPanel() {
  return render(
    <QueryClientProvider client={client}>
      <TradePlanBuilderPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  routes = {};
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
});

describe("Trade Plan Builder — a plan sent to confirmation is not 'executed'", () => {
  it("never badges a converted plan EXECUTED; says it was sent to confirmation", async () => {
    routes["GET /api/trade-plans?limit=20"] = () => ({
      status: 200, body: { plans: [plan({ status: "EXECUTED", executionConfirmationId: 7 })] },
    });
    routes["GET /api/execution-confirmations/7"] = () => ({ status: 200, body: confirmation() });
    renderPanel();
    await screen.findByText("Plan #11");
    expect(screen.queryByText("EXECUTED")).toBeNull();
    expect(screen.getAllByText(/sent to confirmation/i).length).toBeGreaterThan(0);
    expect(await screen.findByText(/no order has been placed/i)).toBeTruthy();
    expect(screen.getByText(/waiting for your confirmation/i)).toBeTruthy();
  });

  it("an expired request says it expired and that no order was placed", async () => {
    routes["GET /api/trade-plans?limit=20"] = () => ({
      status: 200, body: { plans: [plan({ status: "EXECUTED", executionConfirmationId: 7 })] },
    });
    // The single-row read does not sweep expiry: a PENDING row past its expiry is expired.
    routes["GET /api/execution-confirmations/7"] = () => ({
      status: 200, body: confirmation({ status: "PENDING", expiresAtIso: new Date(Date.now() - 3_600_000).toISOString() }),
    });
    renderPanel();
    expect(await screen.findByText(/expired .*without being confirmed/i)).toBeTruthy();
    expect(screen.queryByText(/review and confirm/i)).toBeNull();
    expect(screen.queryByText(/waiting for your confirmation/i)).toBeNull();
  });

  it("a request whose state cannot be read says so", async () => {
    routes["GET /api/trade-plans?limit=20"] = () => ({
      status: 200, body: { plans: [plan({ status: "EXECUTED", executionConfirmationId: 7 })] },
    });
    routes["GET /api/execution-confirmations/7"] = () => ({ status: 500, body: { error: "boom" } });
    renderPanel();
    expect(await screen.findByText(/could not be loaded/i)).toBeTruthy();
  });

  it("the convert button does not promise live execution", async () => {
    routes["GET /api/trade-plans?limit=20"] = () => ({
      status: 200, body: { plans: [plan({ status: "READY" })] },
    });
    renderPanel();
    await screen.findByText("Plan #11");
    await waitFor(() => expect(screen.getByRole("button", { name: /pre-trade confirmation/i })).toBeTruthy());
    expect(screen.queryByText(/live execution/i)).toBeNull();
  });
});

describe("Trade Plan Builder — a checklist from before an edit is out of date", () => {
  const oldChecklist = {
    items: [{ key: "SL_DEFINED", label: "Stop loss is defined", status: "PASS", detail: "1.095" }],
    passCount: 9, failCount: 0, warnCount: 0, isReady: true, rewardToRisk: 2,
    checkedAtIso: new Date(Date.now() - 86_400_000).toISOString(),
  };

  it("a DRAFT with the old passing checklist is never called ready", async () => {
    routes["GET /api/trade-plans?limit=20"] = () => ({
      status: 200,
      body: { plans: [plan({
        status: "DRAFT", stopLoss: 1.2, checklist: oldChecklist, checklistStale: true,
        aiSummary: "BUY plan on EURUSD. All pre-trade checks pass. Final execution remains gated by the live-execution safety layer.",
      })] },
    });
    renderPanel();
    await screen.findByText("Plan #11");
    expect(screen.queryByText(/Ready — plan passes all blocking checks/)).toBeNull();
    expect(screen.getAllByText(/out of date/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/these results describe its earlier values/i)).toBeTruthy();
    expect(screen.getByText(/describes the plan before your last save/i)).toBeTruthy();
  });

  it("a plan edited before the server flag existed (DRAFT + old ready checklist) reads the same", async () => {
    routes["GET /api/trade-plans?limit=20"] = () => ({
      status: 200, body: { plans: [plan({ status: "DRAFT", checklist: { ...oldChecklist, checkedAtIso: undefined } })] },
    });
    renderPanel();
    await screen.findByText("Plan #11");
    expect(screen.queryByText(/Ready — plan passes all blocking checks/)).toBeNull();
    expect(screen.getAllByText(/out of date/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/these results describe its earlier values/i)).toBeTruthy();
  });

  it("a READY plan with its own checklist still says ready, with when it was checked", async () => {
    routes["GET /api/trade-plans?limit=20"] = () => ({
      status: 200, body: { plans: [plan({ status: "READY", checklist: oldChecklist, checklistStale: false })] },
    });
    renderPanel();
    await screen.findByText("Plan #11");
    expect(screen.getByText(/Ready — plan passes all blocking checks/)).toBeTruthy();
    expect(screen.getByText(/^Checked /)).toBeTruthy();
  });
});

describe("Trade Plan Builder — a refused validate is shown, not swallowed", () => {
  it("a 409 news no-trade window says the check refused the plan and the old READY no longer holds", async () => {
    routes["GET /api/trade-plans?limit=20"] = () => ({
      status: 200, body: { plans: [plan({ status: "READY", checklist: { items: [], passCount: 9, failCount: 0, warnCount: 0, isReady: true } })] },
    });
    routes["POST /api/trade-plans/11/validate"] = () => ({
      status: 409, body: { error: "NEWS_NO_TRADE_WINDOW", reason: "US Non-Farm Payrolls in 12 minutes.", riskLevel: "NO_TRADE_WINDOW" },
    });
    renderPanel();
    await screen.findByText("Plan #11");
    const send = await screen.findByRole("button", { name: /pre-trade confirmation/i });
    expect((send as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /validate plan/i }));
    expect(await screen.findByText(/US Non-Farm Payrolls in 12 minutes/)).toBeTruthy();
    expect(screen.getByText(/refused/i)).toBeTruthy();
    expect(screen.getByText(/from an earlier check/i)).toBeTruthy();
    await waitFor(() => {
      expect((screen.getByRole("button", { name: /pre-trade confirmation/i }) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it("a failed validate request says it could not be completed", async () => {
    routes["GET /api/trade-plans?limit=20"] = () => ({ status: 200, body: { plans: [plan({ status: "DRAFT" })] } });
    routes["POST /api/trade-plans/11/validate"] = () => ({ status: 500, body: { error: "Failed to validate trade plan" } });
    renderPanel();
    await screen.findByText("Plan #11");
    fireEvent.click(screen.getByRole("button", { name: /validate plan/i }));
    expect(await screen.findByText(/could not be completed/i)).toBeTruthy();
  });
});

describe("Trade Plan Builder — validate's chart check is shown", () => {
  it("a Chart Truth limit shows the note and the capped confidence, not 'Strong'", async () => {
    routes["GET /api/trade-plans?limit=20"] = () => ({ status: 200, body: { plans: [plan({ status: "DRAFT", confidenceLevel: 80 })] } });
    routes["POST /api/trade-plans/11/validate"] = () => ({
      status: 200,
      body: {
        ...plan({ status: "READY", confidenceLevel: 80 }),
        chartTruthStatus: "LIMITED", chartTruthScore: 52, effectiveConfidenceLevel: 52,
        chartQualityNote: "Chart Truth has not passed the verification threshold. Your plan is saved, but chart-based confidence is limited until the chart verifies.",
      },
    });
    renderPanel();
    await screen.findByText("Plan #11");
    expect(screen.getByText(/80%/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /validate plan/i }));
    expect(await screen.findByText(/Chart Truth has not passed the verification threshold/)).toBeTruthy();
    expect(screen.getByText(/usable 52%/)).toBeTruthy();
    expect(screen.queryByText(/Strong/)).toBeNull();
  });

  it("a validate with no chart read says Chart Truth was not checked", async () => {
    routes["GET /api/trade-plans?limit=20"] = () => ({ status: 200, body: { plans: [plan({ status: "DRAFT" })] } });
    routes["POST /api/trade-plans/11/validate"] = () => ({
      status: 200, body: { ...plan({ status: "READY" }), chartTruthStatus: "NOT_CHECKED" },
    });
    renderPanel();
    await screen.findByText("Plan #11");
    fireEvent.click(screen.getByRole("button", { name: /validate plan/i }));
    expect(await screen.findByText(/Chart Truth was not checked/i)).toBeTruthy();
  });

  it("the stored confidence is labelled as the trader's own estimate", async () => {
    routes["GET /api/trade-plans?limit=20"] = () => ({ status: 200, body: { plans: [plan({ status: "DRAFT", confidenceLevel: 80 })] } });
    renderPanel();
    await screen.findByText("Plan #11");
    expect(screen.getByText(/your confidence/i)).toBeTruthy();
  });
});
