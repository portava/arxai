import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, act, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Render proof that the scanner trade modal describes what it actually knows:
// the demo-bridge readiness line, the "Current price" field's basis, the price
// precision of derived text, and the pending-order disclosure. Every network
// surface is stubbed; the modal's own logic is real.

vi.mock("@/components/live/LiveTradeTicket", () => ({ LiveTradeTicket: () => null }));
vi.mock("@/components/live/LiveSharedTradeTicket", () => ({ LiveSharedTradeTicket: () => null }));
vi.mock("@/components/live/MasterLiveAccessGuard", () => ({
  useMasterLiveAccess: () => ({ canTrade: false, loaded: true }),
}));
vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({ isLoading: false, isLiveShared: false }),
}));
vi.mock("@/components/trading/HistoricalCheckPanel", () => ({ HistoricalCheckPanel: () => null }));
vi.mock("@/components/trading/NewsRiskCheckPanel", () => ({ NewsRiskCheckPanel: () => null }));
vi.mock("./RubySetupReason", () => ({ RubySetupReason: () => null }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: () => {} }) }));
vi.mock("@/lib/trade-affordance", () => ({
  resolveTradeAffordance: () => ({ requireAck: false, warningTitle: null, warningDetail: null }),
}));

type TruthStub = {
  candles: {
    lastClose: number | null;
    pricePrecision: number | null;
    lastTime: string | null;
    sourceLabel: string;
  };
  displayStatus: string;
  isLivePrice: boolean;
  actionable: boolean;
} | null;
let truth: TruthStub = null;
vi.mock("@/hooks/useScannerTruth", () => ({
  useScannerTruth: () => ({ truth, feedStatus: null, isLoading: false, isError: false, refetch: () => {} }),
}));

import { ScannerTradeModal } from "./ScannerTradeModal";

type BridgeReply = { kind: "ok"; bridge: Record<string, unknown> } | { kind: "status"; status: number } | { kind: "throw" } | { kind: "pending" };
let bridgeReplies: BridgeReply[] = [];
let lastBridgeReply: BridgeReply = { kind: "pending" };

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("/api/me/demo-bridge-debug")) {
      const reply = bridgeReplies.shift() ?? lastBridgeReply;
      lastBridgeReply = reply;
      if (reply.kind === "throw") throw new Error("network down");
      if (reply.kind === "pending") return new Promise<Response>(() => {});
      if (reply.kind === "status") return { ok: false, status: reply.status, json: async () => ({}) } as Response;
      return { ok: true, status: 200, json: async () => ({ bridge: reply.bridge }) } as Response;
    }
    if (u.includes("/api/me/pending-order-draft")) {
      return { ok: true, status: 200, json: async () => draftReply } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }));
}
let draftReply: Record<string, unknown> = {};

const READY_BRIDGE = {
  connectionId: 41, accountLoginMasked: "***1234", accountType: "demo", eaVersionReported: "1.27",
  heartbeatAgeSeconds: 2, heartbeatFresh: true, heartbeatFreshStrict: true, eaVersionAtLeast: true,
  bridgeReady: true, bridgeBlockers: [], gateBlockers: [], armed: true,
  eaInputs: { readOnlyMode: false, enableDemoExecution: true, reportedAt: null },
};

const SIGNAL = { symbol: "EURUSD", timeframe: "5m", recommendedAction: "BUY", bias: "BUY" };

function ui(open: boolean, client: QueryClient, signal: Record<string, unknown> = SIGNAL) {
  return (
    <QueryClientProvider client={client}>
      <ScannerTradeModal open={open} onClose={() => {}} signal={signal as never} defaultSide="BUY" />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  truth = null;
  bridgeReplies = [];
  lastBridgeReply = { kind: "pending" };
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const readiness = () => screen.getByTestId("scanner-bridge-readiness").textContent ?? "";

describe("ScannerTradeModal — demo bridge readiness line", () => {
  it("says the check failed (state unknown) when the bridge-status request returns an error", async () => {
    bridgeReplies = [{ kind: "status", status: 500 }];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(ui(true, client));
    await waitFor(() => expect(readiness()).toMatch(/could not be checked/i));
    expect(readiness()).not.toContain("No demo bridge connected");
    expect(readiness()).not.toContain("NOT ready");
  });

  it("says the check failed when the bridge-status request throws", async () => {
    bridgeReplies = [{ kind: "throw" }];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(ui(true, client));
    await waitFor(() => expect(readiness()).toMatch(/could not be checked/i));
    expect(readiness()).not.toContain("No demo bridge connected");
  });

  it("does not show a previous open's 'ready' snapshot when the modal re-opens", async () => {
    bridgeReplies = [{ kind: "ok", bridge: READY_BRIDGE }];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(ui(true, client));
    await waitFor(() => expect(readiness()).toContain("Active demo bridge ready"));
    rerender(ui(false, client));
    bridgeReplies = [{ kind: "pending" }];
    await act(async () => { rerender(ui(true, client)); });
    expect(readiness()).toContain("Checking active demo bridge");
    expect(readiness()).not.toContain("Active demo bridge ready");
  });
});

describe("ScannerTradeModal — 'Current price' states its basis", () => {
  const USDJPY = { symbol: "USDJPY", timeframe: "5m", recommendedAction: "BUY", bias: "BUY", entry: 156.2 };
  const staleTruth = (lastClose: number): TruthStub => ({
    candles: { lastClose, pricePrecision: 3, lastTime: "2026-10-27T10:00:00.000Z", sourceLabel: "ARX market data" },
    displayStatus: "STALE", isLivePrice: false, actionable: false,
  });
  const priceInput = () => screen.getByTestId("scanner-trade-current-price") as HTMLInputElement;
  const basis = () => screen.getByTestId("scanner-trade-current-price-basis").textContent ?? "";

  it("labels a stale last close as not a live price, with its candle time and source", async () => {
    truth = staleTruth(156.305);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(ui(true, client, USDJPY));
    await waitFor(() => expect(priceInput().value).toBe("156.305"));
    expect(basis()).toMatch(/not a live price/i);
    expect(basis()).toContain("10:00:00 UTC");
    expect(basis()).toContain("ARX market data");
    expect(basis()).toMatch(/does not update/i);
  });

  it("flags the field as a snapshot once the feed's close moves on", async () => {
    truth = staleTruth(156.305);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(ui(true, client, USDJPY));
    await waitFor(() => expect(priceInput().value).toBe("156.305"));
    truth = staleTruth(156.41);
    rerender(ui(true, client, USDJPY));
    expect(basis()).toContain("Latest close is now 156.410");
  });

  it("says the value is the signal's entry level when no feed price exists", () => {
    truth = null;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(ui(true, client, USDJPY));
    expect(priceInput().value).toBe("156.2");
    expect(basis()).toMatch(/signal's entry level, not a current price/);
  });
});

describe("ScannerTradeModal — derived prices use the instrument's precision", () => {
  const liveTruth = (lastClose: number, pricePrecision: number): TruthStub => ({
    candles: { lastClose, pricePrecision, lastTime: "2026-10-27T10:00:00.000Z", sourceLabel: "MT5 broker" },
    displayStatus: "LIVE", isLivePrice: true, actionable: true,
  });
  const risk = () => screen.getByTestId("scanner-trade-risk-px").textContent;
  const reward = () => screen.getByTestId("scanner-trade-reward-px").textContent;

  it("USDJPY (3 dp): seeds 150.123 and prints risk/reward at 3 dp, not 5", async () => {
    truth = liveTruth(150.123, 3);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(ui(true, client, { symbol: "USDJPY", timeframe: "5m", recommendedAction: "BUY", bias: "BUY", stopLoss: 149.95, takeProfit: 150.5 }));
    await waitFor(() => expect((screen.getByTestId("scanner-trade-current-price") as HTMLInputElement).value).toBe("150.123"));
    expect(risk()).toBe("0.173");
    expect(reward()).toBe("0.377");
  });

  it("XAUUSD (2 dp): risk/reward print 2 decimals", async () => {
    truth = liveTruth(2370.5, 2);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(ui(true, client, { symbol: "XAUUSD", timeframe: "5m", recommendedAction: "BUY", bias: "BUY", stopLoss: 2365, takeProfit: 2380 }));
    await waitFor(() => expect((screen.getByTestId("scanner-trade-current-price") as HTMLInputElement).value).toBe("2370.5"));
    expect(risk()).toBe("5.50");
    expect(reward()).toBe("9.50");
  });
});

describe("ScannerTradeModal — pending-order disclosure comes from the server", () => {
  const LIMIT_SIGNAL = { symbol: "EURUSD", timeframe: "5m", recommendedAction: "BUY", bias: "BUY", entry: 1.1, stopLoss: 1.09, takeProfit: 1.13 };

  it("does not assert the EA cannot execute pending orders; shows the reason the server measured", async () => {
    draftReply = {
      ok: true, draftId: 5, executable: false, pendingStatus: "BLOCKED_BY_PAPER_LOCK",
      reason: "Pending order saved as a validated draft; it has not been sent to your broker. Your connected EA (EA v1.50) reports pending-order support, but ARX is paper-only: the queue does not deliver pending orders to the broker.",
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(ui(true, client, LIMIT_SIGNAL));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "BUY_LIMIT" } });
    const disclosure = screen.getByTestId("scanner-trade-pending-disclosure").textContent ?? "";
    expect(disclosure).not.toMatch(/does not yet execute pending orders/);
    expect(disclosure).toMatch(/never sends a pending order to your broker/);

    fireEvent.click(screen.getByTestId("scanner-trade-submit")); // Review
    fireEvent.click(screen.getByTestId("scanner-trade-submit")); // Save Draft
    const reason = await screen.findByTestId("scanner-trade-draft-reason");
    expect(reason.textContent).toContain("reports pending-order support");
    expect(screen.getByTestId("scanner-trade-result").textContent).toContain("BLOCKED_BY_PAPER_LOCK");
  });
});
