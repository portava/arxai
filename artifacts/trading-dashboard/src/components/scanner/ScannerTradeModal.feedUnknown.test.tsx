import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Regression: when GET /api/chart/candles failed, useScannerTruth returned
// truth null and the modal showed no feed warning and no acknowledgement, so
// "Send to Demo Broker" proceeded while the feed state was unknown.

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
let candlesFailed = false;
vi.mock("@/hooks/useScannerTruth", () => ({
  useScannerTruth: () => ({ truth, feedStatus: null, isLoading: false, isError: candlesFailed, refetch: () => {} }),
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
  candlesFailed = false;
  bridgeReplies = [];
  lastBridgeReply = { kind: "pending" };
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ScannerTradeModal — failed feed read", () => {
  it("renders a feed-unknown warning with an acknowledgement checkbox", () => {
    candlesFailed = true;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(ui(true, client));
    const warn = screen.getByTestId("scanner-trade-feed-warning");
    expect(warn.textContent?.toLowerCase()).toContain("couldn't");
    expect(warn.querySelector('button[role="checkbox"]')).not.toBeNull();
  });
  it("no warning while the feed read is simply still loading", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(ui(true, client));
    expect(screen.queryByTestId("scanner-trade-feed-warning")).toBeNull();
  });
});
