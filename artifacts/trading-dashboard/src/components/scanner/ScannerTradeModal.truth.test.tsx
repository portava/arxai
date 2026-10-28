import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
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
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }));
}

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
