// Trade Plan Builder truth.
//
//  - "Convert" only creates a practice confirmation request in PENDING that
//    expires 5 minutes later; the server records that as plan status
//    EXECUTED. Nothing was executed, so the plan must never be badged
//    EXECUTED, the button must not promise "Live Execution", and the request's
//    real state (waiting, expired, cancelled ...) must be read, not assumed.
//
// Real QueryClient and the real panel. fetch is stubbed per URL; the news and
// multi-timeframe cards (their own fetches, their own tests) are stubbed out.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
