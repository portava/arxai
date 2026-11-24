import { fireEvent, render, screen, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { AtiShadowReports } from "./AtiShadowReports";

const session = vi.hoisted(() => ({ user: { id: 11 } }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => session }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); session.user.id = 11; });
const asOf = "2026-11-24T12:00:00.000Z";
const run = { id: "2c3b8b68-945a-4477-b463-189d9b8d6aa1", startedAt: asOf, symbol: "V75", timeframe: "M5", setup: "TREND_CONTINUATION", challengerVersion: "challenger-v1" };
const simulation = { settledPairs: 0, baseline: { totalR: null }, challenger: { totalR: null }, pairedDifferenceR: null };
const costs = { commandCount: 0, reconciledDealCount: 0, triggeredExits: 0, deals: [] };
const report = { ...run, agentId: 9, asOf, endsAt: asOf, baselineVersion: "current-v1", eligibleEntries: 0, assumedCosts: null,
  counts: { observations: 13, paired: 13, different: 0, sourceChanged: 0, noObservedFeed: 1, ungraded: 0, unresolved: 0 },
  simulations: { quoteSideOnly: simulation, withAssumedCosts: null, withMeasuredCosts: null, withMeasuredSlippage: null },
  costs: { demo: costs, live: costs } };
const panel = (client: QueryClient) => <QueryClientProvider client={client}><AtiShadowReports agentId={9} /></QueryClientProvider>;
const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
test("owner-scoped report opens on demand at a fixed cutoff and clears on identity change", async () => {
  const get = vi.fn(async (url: string) => url.includes("?asOf=") ? ok(report) : ok({ runs: session.user.id === 11 ? [run] : [], next: null, asOf }));
  vi.stubGlobal("fetch", get);
  const client = new QueryClient(); const view = render(panel(client));
  expect(get).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /ATI shadow reports/ }));
  await screen.findByText("No eligible entries. This run has no return comparison.");
  expect(screen.getAllByText("Command execution costs are unknown.")).toHaveLength(2);
  expect(screen.getByRole("link", { name: /full report/ }).getAttribute("href")).toBe(`/api/self-trade-ai/agents/9/ati-shadow-runs/${run.id}?asOf=${encodeURIComponent(asOf)}`);
  expect(get.mock.calls.map(([url]) => url)).toEqual(["/api/self-trade-ai/agents/9/ati-shadow-runs", `/api/self-trade-ai/agents/9/ati-shadow-runs/${run.id}?asOf=${encodeURIComponent(asOf)}&view=summary`]);
  session.user.id = 12; view.rerender(panel(client));
  await screen.findByText(/No shadow runs are available/);
  expect(screen.queryByText("current-v1")).toBeNull();
});
test("renders negative paired performance, observed zero charges and unknown fields independently", async () => {
  const result = { ...report, eligibleEntries: 2, simulations: { ...report.simulations, quoteSideOnly: { settledPairs: 2, baseline: { totalR: 1 }, challenger: { totalR: -1 }, pairedDifferenceR: -2 } },
    costs: { ...report.costs, demo: { ...costs, commandCount: 2, reconciledDealCount: 1, deals: [{ commandId: "A", deal: "42", spread: 0.1, movement: null, slippage: 0,
      charges: { currency: "USD", commission: 0, fee: -0.02, swap: null } }] } } };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("?asOf=") ? ok(result) : ok({ runs: [run], asOf, next: null })));
  render(panel(new QueryClient())); fireEvent.click(screen.getByRole("button", { name: /ATI shadow reports/ }));
  await screen.findByText("Current total R");
  expect(within(screen.getByText("Quote side only").closest("tr")!).getByText("-2")).toBeTruthy();
  fireEvent.click(screen.getByText("Command deal costs"));
  const row = screen.getByText("42").closest("tr")!;
  expect(within(row).getByText("0 USD")).toBeTruthy(); expect(within(row).getByText("-0.02 USD")).toBeTruthy();
  expect(within(row).getAllByText("Unknown")).toHaveLength(2);
});
