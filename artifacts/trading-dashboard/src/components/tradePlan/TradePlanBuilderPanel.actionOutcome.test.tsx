// Trade Plan Builder — what a failed save / validate / cancel may claim.
//
// The server stores the change before it can still fail: POST /cancel sets
// CANCELED and then awaits the vault write; POST /validate commits READY /
// INVALIDATED and then awaits the vault write; a response can also be lost
// after the commit. So a 5xx or a network failure does not mean "not
// cancelled" / "not validated" / "unchanged" — the outcome is unknown, and the
// status shown must be re-read from the server. A 4xx is the server refusing
// before it changes anything, so "not cancelled" is true there.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TradePlanBuilderPanel } from "./TradePlanBuilderPanel";

const PLAN = {
  id: 7, symbol: "EURUSD", directionBias: "BUY", strategyId: "breakout", marketCondition: "TRENDING",
  entryConditions: null, invalidationConditions: null, stopLossPlan: null, takeProfitPlan: null,
  entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12, lotSize: 0.1, riskAmount: 10, maxLossAllowed: 20,
  rewardToRiskTarget: 2, confidenceLevel: 60, status: "DRAFT", aiSummary: null, checklist: null,
  executionConfirmationId: null,
};

/** The server applies `action`'s change, then answers `status` (or drops the connection). */
function mountServer(action: "PATCH" | "validate" | "cancel", answer: number | "network", appliedStatus: string) {
  let stored = { ...PLAN };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/trade-plans?")) return new Response(JSON.stringify({ plans: [stored] }), { status: 200 });
    const hit =
      (action === "PATCH" && url === "/api/trade-plans/7" && init?.method === "PATCH") ||
      (action === "validate" && url === "/api/trade-plans/7/validate") ||
      (action === "cancel" && url === "/api/trade-plans/7/cancel");
    if (hit) {
      stored = { ...stored, status: appliedStatus };
      if (answer === "network") throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ error: "Failed" }), { status: answer });
    }
    return new Response("not found", { status: 404 });
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={qc}><TradePlanBuilderPanel /></QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("TradePlanBuilderPanel — a 5xx or network failure is an unconfirmed outcome", () => {
  it("cancel 500 after the server stored CANCELED: says it could not confirm, and the shown status is re-read", async () => {
    mountServer("cancel", 500, "CANCELED");
    fireEvent.click(await screen.findByText("Cancel plan"));
    const err = await screen.findByTestId("trade-plan-action-error");
    expect(err.textContent).toContain("HTTP 500");
    expect(err.textContent).toMatch(/could not confirm whether the plan was cancelled/i);
    expect(err.textContent).not.toMatch(/was not cancelled/i);
    await waitFor(() => expect(screen.getAllByText("CANCELED").length).toBeGreaterThan(0));
    expect(screen.queryByText("DRAFT")).toBeNull();
  });

  it("validate 500 after the server committed READY: no 'unchanged' claim, and READY is shown", async () => {
    mountServer("validate", 500, "READY");
    fireEvent.click(await screen.findByRole("button", { name: "Validate plan" }));
    const err = await screen.findByTestId("trade-plan-action-error");
    expect(err.textContent).toContain("HTTP 500");
    expect(err.textContent).toMatch(/could not confirm whether the plan was validated/i);
    expect(err.textContent).not.toMatch(/not validated/i);
    expect(err.textContent).not.toMatch(/unchanged/i);
    // The re-read READY is shown, but not as a green READY: this validate's
    // outcome is unknown, so the badge says the READY is unconfirmed.
    await waitFor(() => expect(screen.getByTestId("trade-plan-status-active").textContent).toBe("READY (unconfirmed)"));
    expect(screen.getByTestId("trade-plan-status-7").textContent).toBe("READY (unconfirmed)");
  });

  it("validate with the response lost in transit: could not confirm, status re-read", async () => {
    mountServer("validate", "network", "INVALIDATED");
    fireEvent.click(await screen.findByRole("button", { name: "Validate plan" }));
    const err = await screen.findByTestId("trade-plan-action-error");
    expect(err.textContent).toMatch(/could not confirm/i);
    expect(err.textContent).not.toMatch(/unchanged/i);
    await waitFor(() => expect(screen.getAllByText("INVALIDATED").length).toBeGreaterThan(0));
  });

  it("save 500: says it could not confirm the changes were saved", async () => {
    mountServer("PATCH", 500, "DRAFT");
    fireEvent.click(await screen.findByText("Save changes"));
    const err = await screen.findByTestId("trade-plan-action-error");
    expect(err.textContent).toContain("HTTP 500");
    expect(err.textContent).toMatch(/could not confirm whether your changes were saved/i);
    expect(err.textContent).not.toMatch(/were not saved/i);
  });
});

describe("TradePlanBuilderPanel — a 4xx is a refusal before any change", () => {
  it("cancel 409: the server refused, the plan was not cancelled", async () => {
    mountServer("cancel", 409, "DRAFT");
    fireEvent.click(await screen.findByText("Cancel plan"));
    const err = await screen.findByTestId("trade-plan-action-error");
    expect(err.textContent).toContain("HTTP 409");
    expect(err.textContent).toMatch(/refused/i);
    expect(err.textContent).toMatch(/not cancelled/i);
  });

  it("validate 409: the server refused, status and checklist unchanged", async () => {
    mountServer("validate", 409, "DRAFT");
    fireEvent.click(await screen.findByRole("button", { name: "Validate plan" }));
    const err = await screen.findByTestId("trade-plan-action-error");
    expect(err.textContent).toContain("HTTP 409");
    expect(err.textContent).toMatch(/refused/i);
    expect(err.textContent).toMatch(/not validated/i);
  });
});

// POST /trade-plans inserts the DRAFT plan and then awaits the vault write,
// which has no catch: a failed vault write answers 500 after the plan was
// stored, and a lost response has the same effect. The create used to say "A
// new plan was not created" and re-read the list only on success, so the plan
// that was stored stayed unlisted.
describe("TradePlanBuilderPanel — create", () => {
  function mountCreate(answer: number | "network", stores: boolean) {
    const plans = [{ ...PLAN }];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/trade-plans?")) return new Response(JSON.stringify({ plans }), { status: 200 });
      if (url === "/api/trade-plans" && init?.method === "POST") {
        if (stores) plans.unshift({ ...PLAN, id: 8, symbol: null });
        if (answer === "network") throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify({ error: "Failed" }), { status: answer });
      }
      return new Response("not found", { status: 404 });
    }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={qc}><TradePlanBuilderPanel /></QueryClientProvider>);
  }

  it("create 500 after the server stored the plan: could not confirm, and the plan list is re-read", async () => {
    mountCreate(500, true);
    await screen.findByTestId("trade-plan-status-7");
    fireEvent.click(await screen.findByText("+ New trade plan"));
    const err = await screen.findByTestId("trade-plan-create-error");
    expect(err.textContent).toContain("HTTP 500");
    expect(err.textContent).toMatch(/could not confirm whether a plan was created/i);
    expect(err.textContent).not.toMatch(/not created/i);
    await waitFor(() => expect(screen.getByTestId("trade-plan-status-8")).toBeTruthy());
  });

  it("create with the response lost in transit: could not confirm", async () => {
    mountCreate("network", true);
    fireEvent.click(await screen.findByText("+ New trade plan"));
    const err = await screen.findByTestId("trade-plan-create-error");
    expect(err.textContent).toMatch(/could not confirm whether a plan was created/i);
    await waitFor(() => expect(screen.getByTestId("trade-plan-status-8")).toBeTruthy());
  });

  it("create 400: the server refused, no plan was created", async () => {
    mountCreate(400, false);
    fireEvent.click(await screen.findByText("+ New trade plan"));
    const err = await screen.findByTestId("trade-plan-create-error");
    expect(err.textContent).toContain("HTTP 400");
    expect(err.textContent).toMatch(/refused/i);
    expect(err.textContent).toMatch(/no plan was created/i);
  });
});
