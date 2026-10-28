// Trade Plan Builder load / action failure truth.
//
// When GET /api/trade-plans fails (500, 401, network) the panel used to show
// "No plans yet." and "Create a new trade plan to begin." — the empty state —
// even though the user's saved plans (possibly READY ones) exist and simply
// could not be loaded. Save / validate / cancel / create failures were never
// shown either, so a failed save looked like it had gone through.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TradePlanBuilderPanel } from "./TradePlanBuilderPanel";

const PLAN = {
  id: 7,
  symbol: "EURUSD",
  directionBias: "BUY",
  strategyId: "breakout",
  marketCondition: "TRENDING",
  entryConditions: null,
  invalidationConditions: null,
  stopLossPlan: null,
  takeProfitPlan: null,
  entryPrice: 1.1,
  stopLoss: 1.09,
  takeProfit: 1.12,
  lotSize: 0.1,
  riskAmount: 10,
  maxLossAllowed: 20,
  rewardToRiskTarget: 2,
  confidenceLevel: 60,
  status: "DRAFT",
  aiSummary: null,
  checklist: null,
  executionConfirmationId: null,
};

type Route = (url: string, init?: RequestInit) => Response | undefined;

function mount(route: Route) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const r = route(url, init);
      if (r) return r;
      return new Response("not found", { status: 404 });
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TradePlanBuilderPanel />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TradePlanBuilderPanel — plan list load failure", () => {
  it.each([500, 401])("HTTP %s is shown as 'could not be loaded', never as 'No plans yet'", async (status) => {
    mount((url) => (url.startsWith("/api/trade-plans?") ? new Response("boom", { status }) : undefined));
    const err = await screen.findByTestId("trade-plans-load-error");
    expect(err.textContent).toMatch(/could not be loaded/i);
    expect(err.textContent).toContain(`HTTP ${status}`);
    expect(document.body.textContent).not.toContain("No plans yet.");
    expect(document.body.textContent).not.toContain("Create a new trade plan to begin.");
    const editor = screen.getByTestId("trade-plan-editor-unavailable");
    expect(editor.textContent).toMatch(/could not be loaded/i);
  });

  it("a network failure is also 'could not be loaded'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <TradePlanBuilderPanel />
      </QueryClientProvider>,
    );
    const err = await screen.findByTestId("trade-plans-load-error");
    expect(err.textContent).toMatch(/could not be loaded/i);
    expect(document.body.textContent).not.toContain("No plans yet.");
  });

  it("while loading it does not claim there are no plans", () => {
    mount((url) => (url.startsWith("/api/trade-plans?") ? undefined : undefined));
    // First render, before the request resolves.
    expect(document.body.textContent).not.toContain("No plans yet.");
    expect(document.body.textContent).not.toContain("Create a new trade plan to begin.");
  });

  it("a successful empty list still says 'No plans yet.'", async () => {
    mount((url) =>
      url.startsWith("/api/trade-plans?") ? new Response(JSON.stringify({ plans: [] }), { status: 200 }) : undefined,
    );
    expect(await screen.findByText("No plans yet.")).toBeTruthy();
    expect(screen.queryByTestId("trade-plans-load-error")).toBeNull();
  });
});

describe("TradePlanBuilderPanel — action failures are shown", () => {
  function mountWithPlan(failing: "PATCH" | "validate" | "cancel" | "create") {
    return mount((url, init) => {
      if (url.startsWith("/api/trade-plans?")) return new Response(JSON.stringify({ plans: [PLAN] }), { status: 200 });
      if (failing === "PATCH" && url === "/api/trade-plans/7" && init?.method === "PATCH") return new Response("x", { status: 500 });
      if (failing === "validate" && url === "/api/trade-plans/7/validate") return new Response("x", { status: 500 });
      if (failing === "cancel" && url === "/api/trade-plans/7/cancel") return new Response("x", { status: 403 });
      if (failing === "create" && url === "/api/trade-plans" && init?.method === "POST") return new Response("x", { status: 500 });
      return undefined;
    });
  }

  it("a failed save says the changes were not saved", async () => {
    mountWithPlan("PATCH");
    fireEvent.click(await screen.findByText("Save changes"));
    const err = await screen.findByTestId("trade-plan-action-error");
    expect(err.textContent).toMatch(/not saved/i);
    expect(err.textContent).toContain("HTTP 500");
  });

  it("a failed validation says the plan was not validated", async () => {
    mountWithPlan("validate");
    fireEvent.click(await screen.findByRole("button", { name: "Validate plan" }));
    const err = await screen.findByTestId("trade-plan-action-error");
    expect(err.textContent).toMatch(/not validated/i);
  });

  it("a failed cancel says the plan was not cancelled", async () => {
    mountWithPlan("cancel");
    fireEvent.click(await screen.findByText("Cancel plan"));
    const err = await screen.findByTestId("trade-plan-action-error");
    expect(err.textContent).toMatch(/not cancelled/i);
    expect(err.textContent).toContain("HTTP 403");
  });

  it("a failed create says no plan was created", async () => {
    mountWithPlan("create");
    fireEvent.click(await screen.findByText("+ New trade plan"));
    const err = await screen.findByTestId("trade-plan-create-error");
    expect(err.textContent).toMatch(/not created/i);
  });
});
