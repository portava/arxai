// Trade Command Room: failed reads were shown as empty answers.
//   - a failed /api/live-intent/queue became counts.total 0 → "0 intents" and
//     "No live intents queued";
//   - a failed /api/market-scanner/opportunities became [] (or, when it threw,
//     rejected the whole load) → "No scan results yet";
//   - a failed /api/decision-stream likewise read "No decisions yet";
//   - the operator positions read that answers rows:[] with note
//     MASTER_BRIDGE_NOT_PINNED / MASTER_CONNECTION_MISSING (the master account
//     could not be read) → "No open positions".
// Each now says it could not be loaded. Successful empty reads are unchanged.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: { href?: string; children?: ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("@/components/ui/PageTabs", () => ({
  PageTabs: ({ tabs }: { tabs: Array<{ id: string; content: ReactNode }> }) => <div>{tabs.map((t) => <div key={t.id}>{t.content}</div>)}</div>,
}));
vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({ isAdmin: true, isLiveShared: false, envelope: null, canManualTrade: false, cleanModeLabel: "Demo" }),
}));
vi.mock("@/components/dashboard/trade/tradeRoomStatus", () => ({
  resolveTradeRoomStatus: () => ({
    canTrade: false, modeLabel: "Demo", gatesLabel: "Gates on", blockedLabel: "Blocked",
    connStatus: { label: "—", tone: "muted" }, rgStatus: { label: "—", tone: "muted" }, bridge: "—",
  }),
  resolveTradeRoomRoute: () => ({ heading: "Demo", onSharedRoute: false }),
}));
vi.mock("@/components/dashboard/cockpit/bridgeObservation", () => ({
  describeBridgeObservation: () => ({ kind: "not_applicable", label: "—" }),
  isOnSharedMasterRoute: () => false,
  sharedMasterRouteObserved: () => ({ onSharedRoute: false, routeCheckFailed: false }),
}));
vi.mock("@/lib/riskCapsStatus", () => ({ riskCapsStatus: () => ({ label: "—" }) }));
vi.mock("@/lib/use-chart-symbol", () => ({ useChartSymbol: () => ["EURUSD", () => undefined] }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));
vi.mock("@/components/dashboard/cockpit/CockpitHeader", () => ({ CockpitHeader: () => null }));
vi.mock("@/components/layout/Topbar", () => ({ MobileMenuTrigger: () => null }));
vi.mock("@/components/layout/AppLayout", () => ({ SidebarContent: () => null }));
vi.mock("@/components/dashboard/trade/QuickTradePanel", async (orig) => ({
  ...(await orig<typeof import("@/components/dashboard/trade/QuickTradePanel")>()),
  // A probe of what the page hands the panel (the panel's copy is tested on its own).
  QuickTradePanel: (p: { quote: unknown; quoteLoadFailed?: boolean }) => (
    <div data-testid="quick-trade-probe" data-quote={JSON.stringify(p.quote ?? null)} data-quote-failed={String(p.quoteLoadFailed === true)} />
  ),
}));
vi.mock("@/components/dashboard/trade/PreTradeHeatChecklist", () => ({ PreTradeHeatChecklist: () => null }));
vi.mock("@/components/dashboard/trade/TradePanels", async (orig) => ({
  ...(await orig<typeof import("@/components/dashboard/trade/TradePanels")>()),
  TradeHero: () => null, RiskGovernorCard: () => null, AdvancedPanel: () => null,
}));

const positions: { data: unknown; isLoading: boolean; isError: boolean } = { data: undefined, isLoading: false, isError: false };
vi.mock("@workspace/api-client-react", () => ({
  useGetMeSharedAccountSummary: () => ({ data: undefined, isLoading: false }),
  getGetMeSharedAccountSummaryQueryKey: () => ["summary"],
  useGetMeSharedAccountPositions: () => ({ ...positions, refetch: () => undefined }),
  getGetMeSharedAccountPositionsQueryKey: () => ["positions"],
}));

const { default: TradeCommandRoom } = await import("./trade-command-room");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.assign(positions, { data: undefined, isLoading: false, isError: false });
});

type Answer = { status: number; body: unknown } | "throw";
function serve(answers: { opps?: Answer; queue?: Answer; decisions?: Answer; quote?: Answer }) {
  const json = (a: Answer | undefined, fallback: unknown) => {
    if (a === "throw") throw new TypeError("Failed to fetch");
    const { status, body } = a ?? { status: 200, body: fallback };
    return new Response(JSON.stringify(body), { status });
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/market-scanner/opportunities")) return json(answers.opps, { opportunities: [] });
    if (url.includes("/live-intent/queue")) return json(answers.queue, { counts: { total: 0 } });
    if (url.includes("/decision-stream")) return json(answers.decisions, { decisions: [] });
    if (url.includes("/market/quote/")) return answers.quote ? json(answers.quote, {}) : new Response(JSON.stringify({}));
    return new Response(JSON.stringify({}));
  }));
}

describe("Trade Command Room failed reads", () => {
  it("a failed intent queue read is 'could not be loaded', not 0 intents", async () => {
    serve({ queue: { status: 500, body: { error: "Internal error" } } });
    render(<TradeCommandRoom />);
    await waitFor(() => expect(screen.getByTestId("orders-intent-error").textContent).toMatch(/could not be loaded/));
    expect(screen.getByTestId("orders-intent-count").textContent).not.toBe("0");
    expect(screen.getByTestId("trade-intent-badge").textContent).not.toMatch(/^0 intents$/);
    expect(document.body.textContent).not.toMatch(/No live intents queued/);
  });

  it("an intent queue read that throws is 'could not be loaded' too", async () => {
    serve({ queue: "throw" });
    render(<TradeCommandRoom />);
    await waitFor(() => expect(screen.getByTestId("orders-intent-error")).toBeTruthy());
    expect(document.body.textContent).not.toMatch(/No live intents queued/);
  });

  it("a failed opportunities read is 'could not be loaded', not 'No scan results yet'", async () => {
    serve({ opps: { status: 500, body: { error: "Internal error" } } });
    render(<TradeCommandRoom />);
    await waitFor(() => expect(screen.getByTestId("orders-opps-error").textContent).toMatch(/could not be loaded/));
    expect(document.body.textContent).not.toMatch(/No scan results yet/);
  });

  it("an opportunities read that throws does not take the queue count down with it", async () => {
    serve({ opps: "throw", queue: { status: 200, body: { counts: { total: 3 } } } });
    render(<TradeCommandRoom />);
    await waitFor(() => expect(screen.getByTestId("orders-intent-count").textContent).toBe("3"));
    expect(screen.getByTestId("orders-opps-error")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/No scan results yet/);
  });

  it("a failed decision stream read is not 'No decisions yet'", async () => {
    serve({ decisions: { status: 500, body: { error: "Internal error" } } });
    render(<TradeCommandRoom />);
    await waitFor(() => expect(screen.getByTestId("decision-stream-error").textContent).toMatch(/could not be loaded/));
    expect(document.body.textContent).not.toMatch(/No decisions yet/);
  });

  it("an operator positions read with MASTER_BRIDGE_NOT_PINNED is not 'No open positions'", async () => {
    positions.data = { ok: true, userId: 1, count: 0, rows: [], note: "MASTER_BRIDGE_NOT_PINNED" };
    serve({});
    render(<TradeCommandRoom />);
    const box = await screen.findByTestId("positions-unavailable");
    expect(box.textContent).toMatch(/master bridge is not pinned/i);
    expect(box.textContent).toMatch(/could not read/i);
    expect(document.body.textContent).not.toMatch(/No open positions/);
  });

  it("successful empty reads still say there is nothing", async () => {
    positions.data = { ok: true, userId: 1, count: 0, rows: [] };
    serve({});
    render(<TradeCommandRoom />);
    await waitFor(() => expect(document.body.textContent).toMatch(/No live intents queued/));
    expect(document.body.textContent).toMatch(/No scan results yet/);
    expect(document.body.textContent).toMatch(/No decisions yet/);
    expect(document.body.textContent).toMatch(/No open positions/);
    expect(screen.getByTestId("orders-intent-count").textContent).toBe("0");
  });
});

// Review finding (d019e37f): the page mapped every non-ok quote answer and
// every rejected request to a null quote, which the panel read as "No quote
// available for this symbol." Only 404 {error:"Unknown symbol"} means no quote.
describe("Trade Command Room quote read", () => {
  const probe = () => screen.getByTestId("quick-trade-probe");

  it("a 5xx quote answer reaches the panel as a failed read, not as no quote", async () => {
    serve({ quote: { status: 500, body: { error: "Internal error" } } });
    render(<TradeCommandRoom />);
    await waitFor(() => expect(probe().dataset.quoteFailed).toBe("true"));
    expect(probe().dataset.quote).toBe("null");
  });

  it("a quote request that throws reaches the panel as a failed read", async () => {
    serve({ quote: "throw" });
    render(<TradeCommandRoom />);
    await waitFor(() => expect(probe().dataset.quoteFailed).toBe("true"));
    expect(probe().dataset.quote).toBe("null");
  });

  it("the route's 404 Unknown symbol is no quote, not a failed read", async () => {
    serve({ quote: { status: 404, body: { error: "Unknown symbol" } } });
    render(<TradeCommandRoom />);
    // The queue count is set in the same pass as the quote, so the read has settled.
    await waitFor(() => expect(screen.getByTestId("orders-intent-count").textContent).toBe("0"));
    expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).includes("/market/quote/"))).toBe(true);
    expect(probe().dataset.quoteFailed).toBe("false");
    expect(probe().dataset.quote).toBe("null");
  });

  it("a quote that loads is handed to the panel with no failure", async () => {
    const q = { symbol: "EURUSD", bid: 1.1, ask: 1.1002, spread: 0.0002, mid: 1.1001, executionEnvironment: "SIMULATOR" };
    serve({ quote: { status: 200, body: q } });
    render(<TradeCommandRoom />);
    await waitFor(() => expect(JSON.parse(probe().dataset.quote ?? "null")).toEqual(q));
    expect(probe().dataset.quoteFailed).toBe("false");
  });
});
