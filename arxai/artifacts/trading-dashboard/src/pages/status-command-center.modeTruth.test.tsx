// Regression: Status Command Center rendered two mode authorities side by side
// with no reconciliation. The header MODE pill reads the account-mode envelope
// ("Live (Shared Master MT5)") while the Runtime Status card's "Mode" row
// printed the legacy diagnostic-summary mode (ctx.tradingMode.toUpperCase(),
// e.g. "SIMULATOR"). For every LIVE_SHARED user one of them was wrong.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { collectRuntimeContext } from "@/assistant/runtimeContext";

let tradingMode: Record<string, unknown> = {};
vi.mock("@/assistant/useRuntimeContext", () => ({
  useRuntimeContext: () => collectRuntimeContext({
    route: "/status-command-center",
    bridge: { bridgeMode: "deferred", liveTradingEnabled: false, brokerExecutionEnabled: false, brokerReadOnly: true, heartbeatPresent: false, heartbeatAgeSeconds: null, paperOnly: true } as never,
  }),
}));
vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => tradingMode }));

import StatusCommandCenter from "./status-command-center";

function liveShared() {
  return {
    isLoading: false, isError: false, isLiveShared: true, isLiveArmed: false,
    envelope: { currentAccountMode: "LIVE_SHARED", cleanModeLabel: "Live (Shared Master MT5)" },
    cleanModeLabel: "Live (Shared Master MT5)", cleanBlockedReason: null, cleanUserMessage: "",
  };
}

afterEach(() => cleanup());

describe("Status Command Center mode truth", () => {
  it("the runtime card's Mode agrees with the header's account mode", () => {
    tradingMode = liveShared();
    render(<StatusCommandCenter />);
    const header = screen.getByTestId("scc-summary");
    expect(header.textContent).toMatch(/MODE: Live \(Shared Master MT5\)/);
    const card = screen.getByTestId("scc-runtime-card");
    const mode = within(card).getByTestId("scc-runtime-mode");
    expect(mode.textContent).toBe("Live (Shared Master MT5)");
  });

  it("the legacy diagnostic-summary mode is labelled as such, not as the account mode", () => {
    tradingMode = liveShared();
    render(<StatusCommandCenter />);
    const card = screen.getByTestId("scc-runtime-card");
    const diag = within(card).getByTestId("scc-runtime-diagnostic-mode");
    expect(diag.textContent).toMatch(/SIMULATOR/);
    expect(card.textContent).toMatch(/Bridge diagnostic mode/);
  });

  it("while the account mode is unresolved the card says so instead of showing the diagnostic mode", () => {
    tradingMode = { isLoading: true, isError: false, isLiveShared: false, envelope: null, cleanModeLabel: "Loading…" };
    render(<StatusCommandCenter />);
    const mode = within(screen.getByTestId("scc-runtime-card")).getByTestId("scc-runtime-mode");
    expect(mode.textContent).not.toMatch(/SIMULATOR|PAPER/);
    expect(mode.textContent).toMatch(/not resolved/i);
    expect(screen.getByTestId("scc-summary").textContent).not.toMatch(/MODE: (SIMULATOR|PAPER)/);
  });
});
