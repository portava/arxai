// Bot Control: /bot/status reads bot_settings, which only the /bot routes
// write and which no scanner, trading loop or execution path reads (the
// api-server guard botSettingsNoEngineReader.test.ts locks that). The page
// must present isRunning / mode as saved preferences, never as a RUNNING
// engine or an armed real-money mode, and a failed load is not "STOPPED".
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Q = { data: unknown; isLoading: boolean; isError: boolean };
const h = vi.hoisted(() => ({
  status: { data: undefined, isLoading: false, isError: false } as { data: unknown; isLoading: boolean; isError: boolean },
  mutate: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }) }));

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useGetBotStatus: () => h.status,
  useGetStrategies: () => ({ data: [], isLoading: false }),
  useUpdateBotStatus: () => ({ mutate: h.mutate, isPending: false }),
}));

const { default: BotControl } = await import("./bot-control");

const LIVE_RUNNING = {
  mode: "LIVE", symbol: "Volatility 75 Index", strategy: "Trend Continuation",
  riskMode: "Balanced", isRunning: true, isPaused: false, lastScanAt: null,
};

function renderPage(status: Partial<Q>) {
  h.status = { data: undefined, isLoading: false, isError: false, ...status };
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}><BotControl /></QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  h.mutate.mockReset();
  h.toast.mockReset();
});

describe("Bot Control truth", () => {
  it("a saved isRunning=true with no scan evidence is not shown as a RUNNING engine", () => {
    renderPage({ data: LIVE_RUNNING });
    expect(screen.queryByText("RUNNING")).toBeNull();
    const state = screen.getByTestId("bot-control-saved-state");
    expect(state.textContent).toMatch(/start requested/i);
    expect(state.className).not.toMatch(/green/);
    expect(screen.getByTestId("bot-control-last-scan").textContent).toMatch(/none recorded/i);
  });

  it("says what the controls do not do, and does not call itself the main trading engine", () => {
    renderPage({ data: LIVE_RUNNING });
    expect(document.body.textContent).not.toMatch(/control the main trading engine/i);
    const scope = screen.getByTestId("bot-control-scope").textContent ?? "";
    expect(scope).toMatch(/only save preferences/i);
    expect(scope).toMatch(/START does not start a bot/);
    expect(scope).toMatch(/LIVE does not arm live trading/);
  });

  it("LIVE is not labelled 'Real Money' and its card is not styled as a live engine", () => {
    const { container } = renderPage({ data: LIVE_RUNNING });
    expect(document.body.textContent).not.toMatch(/Real Money/i);
    expect(container.querySelector(".border-destructive.shadow-destructive\\/20")).toBeNull();
  });

  it("a save is reported as a saved preference, not 'Settings applied successfully'", () => {
    h.mutate.mockImplementation((_vars: unknown, opts: { onSuccess?: (d: unknown) => void }) => {
      opts.onSuccess?.({ ...LIVE_RUNNING, isRunning: false });
    });
    renderPage({ data: { ...LIVE_RUNNING, isRunning: false } });
    fireEvent.click(screen.getByText("START"));
    expect(h.mutate).toHaveBeenCalledTimes(1);
    const shown = JSON.stringify(h.toast.mock.calls);
    expect(shown).not.toMatch(/applied successfully/i);
    expect(shown).toMatch(/nothing was started, stopped or traded/i);
  });

  it("a failed load is 'could not be loaded', not a STOPPED bot", () => {
    renderPage({ data: undefined, isError: true });
    expect(screen.getByTestId("bot-control-error").textContent).toMatch(/could not be loaded/i);
    expect(screen.queryByText("STOPPED")).toBeNull();
    expect(screen.getByTestId("bot-control-saved-state").textContent).toMatch(/not loaded/i);
  });
});
