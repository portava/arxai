// Broker (READ ONLY): POST /broker-readonly/demo always uses the
// DEMO_PLACEHOLDER provider (api-server lib/brokerReadOnly/service.ts), which
// reads no broker: connected:false, empty arrays, latencyMs 0. The page must
// say no broker was read, not "No open positions." / "latency 0ms".
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/components/admin/AdminDiagnosticsGate", () => ({
  AdminDiagnosticsGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { default: BrokerReadOnlyPage } = await import("./broker-readonly");

const SAFETY = { safe: true, brokerModeEnv: "READ_ONLY", reason: "BROKER_MODE=READ_ONLY" };

// demoProvider's output as buildSnapshot() wraps it.
const PLACEHOLDER_SNAPSHOT = {
  connector_id: "bcon_x", mode: "READ_ONLY", provider: "demo", connected: false,
  account: null, symbols: [], openPositions: [], latestQuotes: [],
  dataQuality: {
    status: "MISSING", latencyMs: 0,
    warnings: ["DEMO_PLACEHOLDER provider — no broker adapter is connected. No account, symbol, or quote data is available."],
    errors: [],
  },
  liveTradingAllowed: false, canPlaceLiveTrade: false,
  generatedAt: new Date().toISOString(),
  providerState: "DEMO_PLACEHOLDER",
  safetyNote: "Placeholder provider: connected=false and all data empty until a real read-only adapter is configured. Nothing here is a real account figure.",
};

function stub(snapshot: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = String(url).includes("/status")
      ? { status: { safety: SAFETY } }
      : { demo: true, snapshot };
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Broker read-only truth", () => {
  it("a placeholder snapshot says no broker was read, not 'No open positions' or 'latency 0ms'", async () => {
    stub(PLACEHOLDER_SNAPSHOT);
    render(<BrokerReadOnlyPage />);
    await screen.findByText("SAFE · READ ONLY");
    fireEvent.click(screen.getAllByText("Run demo snapshot")[0]);
    const card = await screen.findByTestId("broker-snapshot-not-read");
    expect(card.textContent).toMatch(/No broker was read/);
    expect(card.textContent).toMatch(/placeholder provider/);
    expect(card.textContent).toMatch(/unknown, not zero or empty/);
    expect(card.textContent).toContain("Nothing here is a real account figure.");
    expect(screen.queryByText("No open positions.")).toBeNull();
    expect(screen.queryByText("No symbols.")).toBeNull();
    expect(document.body.textContent).not.toMatch(/latency 0ms/);
    expect(screen.queryByLabelText("status: paused")).toBeNull();
  });

  it("the empty state does not promise account, symbols, positions and quotes from the placeholder", async () => {
    stub(PLACEHOLDER_SNAPSHOT);
    render(<BrokerReadOnlyPage />);
    await screen.findByText("SAFE · READ ONLY");
    expect(document.body.textContent).not.toMatch(/to view masked account, symbols, positions and quotes/);
    expect(document.body.textContent).toMatch(/placeholder provider that reads no broker/);
  });
});
