// Regression: the Topbar pill read bot_settings.isRunning (GET /bot/status) and
// showed "Bot: Running" in the success tone on every page, and its drawer said
// "Bot state: Running". bot_settings is a saved preference that no scanner,
// trading loop or execution path reads (Bot Control says "START does not start
// a bot"), so a green "Running" is an engine state nothing measured.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const h = vi.hoisted(() => ({
  bot: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetMt5Status: () => ({ data: undefined }),
  useGetBotStatus: () => ({ data: h.bot }),
  getGetMt5StatusQueryKey: () => ["/api/mt5/status"],
  getGetBotStatusQueryKey: () => ["/api/bot/status"],
}));
vi.mock("@/hooks/useFeatureUnlock", () => ({
  useAllUnlocks: () => ({ mt5: false, paper: true, analysis: true, simulator: true }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: null }),
  useLogout: () => ({ mutate: () => {}, isPending: false }),
}));
vi.mock("@/hooks/useViewMode", () => ({ useViewMode: () => ({ canToggle: false, viewMode: "user", setViewMode: () => {} }) }));
vi.mock("./SymbolPicker", () => ({ SymbolPicker: () => null }));
vi.mock("@/components/alerts/NotificationBell", () => ({ NotificationBell: () => null }));

import { Topbar } from "./Topbar";

afterEach(() => { cleanup(); h.bot = undefined; });

const BOT = { mode: "DEMO", symbol: "EURUSD", strategy: "x", riskMode: "Balanced", isPaused: false, lastScanAt: null };

describe("Topbar shows the saved bot preference, never an engine state", () => {
  it("a saved START is 'Start requested' in a neutral tone, not a green 'Running'", () => {
    h.bot = { ...BOT, isRunning: true };
    render(<Topbar />);
    const pill = screen.getByTestId("status-pill-bot");
    expect(pill.textContent).not.toMatch(/Running/);
    expect(pill.textContent).toMatch(/Start requested/);
    expect(pill.textContent).toMatch(/saved/i);
    expect(pill.className).not.toMatch(/emerald/);

    fireEvent.click(screen.getByTestId("topbar-status-row"));
    const drawer = screen.getByTestId("status-drawer-body");
    expect(drawer.textContent).not.toMatch(/Bot state/);
    expect(drawer.textContent).not.toMatch(/Running/);
    expect(within(drawer).getByText(/Saved bot setting/)).toBeTruthy();
    expect(drawer.textContent).toMatch(/Start requested/);
    expect(drawer.textContent).toMatch(/no scanner, trading loop or execution path reads it/i);
  });

  it("pause and stop are saved requests too", () => {
    h.bot = { ...BOT, isRunning: true, isPaused: true };
    render(<Topbar />);
    expect(screen.getByTestId("status-pill-bot").textContent).toMatch(/Pause requested/);
    expect(screen.getByTestId("status-pill-bot").className).not.toMatch(/amber|emerald/);
    cleanup();
    h.bot = { ...BOT, isRunning: false };
    render(<Topbar />);
    expect(screen.getByTestId("status-pill-bot").textContent).toMatch(/Stop requested/);
    expect(screen.getByTestId("status-pill-bot").textContent).not.toMatch(/Stopped/);
  });
});
