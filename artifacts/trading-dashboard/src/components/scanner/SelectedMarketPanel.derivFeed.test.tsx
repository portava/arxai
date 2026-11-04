// The Synthetic chip's feed note was driven by the socket flags only:
//   (a) socket open but no recent tick (CONNECTED_AWAITING_FEED /
//       HISTORY_READY_AWAITING_LIVE_TICK / AUTH_FAILED) read
//       "Live feed connected for synthetic indices.";
//   (b) a failing connection (connected:false, healthSummary "failed") read
//       "Connecting to live feed for synthetic indices…" forever.
// The server already reports hasRecentTick / feedReadinessState /
// healthSummary; the note must follow them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setChartSymbol } from "@/lib/use-chart-symbol";

vi.mock("@/hooks/useScannerTruth", () => ({ useScannerTruth: () => ({ truth: null }) }));
vi.mock("@/hooks/useScannerTimeframe", () => ({ useScannerTimeframe: () => ["5m", vi.fn()] }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));
vi.mock("@/components/live/TradabilityBadge", () => ({ TradabilityBadge: () => null }));
vi.mock("@/components/live/LiveTradeTicket", () => ({ LiveTradeTicket: () => null }));
import { SelectedMarketPanel } from "./SelectedMarketPanel";

let derivReply: () => Promise<Response>;
let client: QueryClient;
beforeEach(() => {
  localStorage.clear(); setChartSymbol("EURUSD");
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["me"], { id: 7 });
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (String(url).includes("/deriv/status")) return derivReply();
    return new Promise<Response>(() => {}); // selected-market read stays pending
  }));
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); });

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

async function syntheticNote(): Promise<string> {
  render(<QueryClientProvider client={client}><SelectedMarketPanel /></QueryClientProvider>);
  await waitFor(() => expect(client.getQueryState(["deriv-status"])?.status).toBe("success"));
  fireEvent.click(screen.getByTestId("category-chip-synthetic"));
  return screen.queryByTestId("deriv-feed-note")?.textContent ?? "";
}

describe("Selected Market — synthetic feed note follows the feed, not the socket flag", () => {
  for (const state of ["CONNECTED_AWAITING_FEED", "HISTORY_READY_AWAITING_LIVE_TICK", "AUTH_FAILED"]) {
    it(`an open socket with no recent tick (${state}) is not "Live feed connected"`, async () => {
      derivReply = () => json({ configured: true, connected: true, hasRecentTick: false, feedReadinessState: state, healthSummary: state === "AUTH_FAILED" ? "degraded" : "warming", lastTickAgeMs: null });
      const note = await syntheticNote();
      expect(note).not.toContain("Live feed connected");
      expect(note).not.toMatch(/receiving live ticks/);
      expect(note).toContain("no recent live tick");
    });
  }

  it("a failing connection is not 'Connecting…'", async () => {
    derivReply = () => json({ configured: true, connected: false, hasRecentTick: false, feedReadinessState: "CONNECTING", healthSummary: "failed", errorMessage: "ECONNREFUSED" });
    const note = await syntheticNote();
    expect(note).not.toMatch(/Connecting/i);
    expect(note).toContain("connection is failing");
  });

  it("a connection still opening without an error says connecting", async () => {
    derivReply = () => json({ configured: true, connected: false, hasRecentTick: false, feedReadinessState: "CONNECTING", healthSummary: "warming", errorMessage: null });
    expect(await syntheticNote()).toMatch(/Connecting/);
  });

  it("says live only when the server reports a recent tick, with its age", async () => {
    derivReply = () => json({ configured: true, connected: true, hasRecentTick: true, feedReadinessState: "LIVE_FEED", healthSummary: "healthy", lastTickAgeMs: 2400 });
    const note = await syntheticNote();
    expect(note).toContain("receiving live ticks");
    expect(note).toContain("2s old");
  });

  it("a status request that failed says the status could not be loaded", async () => {
    derivReply = () => json({ error: "AUTH_REQUIRED" }, 401);
    const note = await syntheticNote();
    expect(note).toContain("could not be loaded");
    expect(note).not.toMatch(/Connecting|connected/i);
  });
});
