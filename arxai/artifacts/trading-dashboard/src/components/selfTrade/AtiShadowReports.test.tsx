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
test("retains both decisions and the recorded chart-readiness reason for each fleet group", async () => {
  const pilot = { ...report, fleetCohorts: [{ revision: "v1", settings: "abc", source: "deriv_public", verified: true,
    matchingBars: 3, eligibleEntries: 0, settledPairs: 0, pairedDifferenceR: null, decisionBreakdown: [
      { bars: 2, baselineOutcome: "WAIT", baselineReason: "Market data stale", challengerOutcome: "WAIT", challengerReason: "Market data stale",
        handshake: { ready: false, blocked: ["CHART_TRUTH_BLOCKED"], degraded: [] }, chartConfirmation: { allowed: false, reason: "Broker alignment unavailable" } },
      { bars: 1, baselineOutcome: "WAIT", baselineReason: null, challengerOutcome: "BLOCKED", challengerReason: "Conflicting timeframe",
        handshake: null, chartConfirmation: null },
    ] }] };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("?asOf=") ? ok(pilot) : ok({ runs: [run], asOf, next: null })));
  render(panel(new QueryClient()));
  fireEvent.click(screen.getByRole("button", { name: /ATI shadow reports/ }));
  fireEvent.click(await screen.findByText(/Fleet evidence by build/));
  fireEvent.click(screen.getByText("Decision reasons"));
  const first = within(screen.getByText("Broker alignment unavailable").closest("tr")!);
  expect(first.getByText("2")).toBeTruthy(); expect(first.getAllByText("Market data stale")).toHaveLength(2);
  expect(first.getByText("Blocked · CHART_TRUTH_BLOCKED")).toBeTruthy();
  const second = within(screen.getByText("Conflicting timeframe").closest("tr")!);
  expect(second.getAllByText("Unknown")).toHaveLength(2); expect(second.getByText("Reason unavailable")).toBeTruthy();
});
test("separates the incumbent's reconciled broker costs by account mode and sample coverage", async () => {
  const metric = { coveredLots: 0, eligibleLots: 0.03, volumeWeightedMeanPriceUnits: null };
  const missingCash = { coveredPositions: 0, signedCashOnCoveredPositions: null };
  const scope = { decisionsWithLinkedOpeningFill: 0, reconciledPositions: 0, unresolvedPositionsWithLinkedEntry: 0,
    positionsWithOtherOpeningDecisions: 0, byEntryStrategy: [] };
  const group = { cohortKey: "123456789abc", closedPositions: 1, decisionSpread: metric, movementBeforeSubmission: metric,
    submissionSpread: metric, commandSlippage: { ...metric, coveredLots: 0.03, volumeWeightedMeanPriceUnits: 0 },
    triggerMovement: metric, signedDealCharges: [{ currency: "USD", positionsInCurrency: 1,
      fee: { coveredPositions: 1, signedCashOnCoveredPositions: -0.1 }, commission: { coveredPositions: 1, signedCashOnCoveredPositions: 0 }, swap: missingCash }] };
  const costs = { capturedEntryDecisions: 2, entriesWithoutUniqueDecision: 1, demo: scope,
    live: { ...scope, decisionsWithLinkedOpeningFill: 1, reconciledPositions: 1, byEntryStrategy: [group] } };
  const pilot = { ...report, fleetCohorts: [{ verified: true, matchingBars: 3, eligibleEntries: 3, observedIncumbentCosts: costs }] };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("?asOf=") ? ok(pilot) : ok({ runs: [run], asOf, next: null })));
  render(panel(new QueryClient())); fireEvent.click(screen.getByRole("button", { name: /ATI shadow reports/ }));
  fireEvent.click(await screen.findByText(/Fleet evidence by build/));
  fireEvent.click(screen.getByText("Broker costs for captured current-bot entries"));
  const demo = within(screen.getByText("Demo matched positions").closest("section")!);
  const live = within(screen.getByText("Live matched positions").closest("section")!);
  expect(demo.getByText("Round-trip costs are unknown.")).toBeTruthy();
  expect(live.getByText("commission 0 USD (1/1 positions) · fee -0.1 USD (1/1 positions) · swap unknown (0/1 positions)")).toBeTruthy();
  const slippage = within(live.getByText("Command slippage").closest("tr")!);
  expect(slippage.getByText("0")).toBeTruthy(); expect(slippage.getByText("0.03 / 0.03")).toBeTruthy();
  expect(within(live.getByText("Entry decision spread").closest("tr")!).getByText("Unknown")).toBeTruthy();
});
