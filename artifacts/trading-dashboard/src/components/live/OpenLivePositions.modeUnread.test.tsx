// An account whose trading mode could not be read is not "not in live mode".
//
// getUserModeScope falls back to PAPER when the account's mode read throws
// (a DB blip), and /api/me/live/positions and /api/me/positions/all then return
// no live rows with notLiveReason ACCOUNT_NOT_IN_LIVE_MODE — plus
// modeResolved:false and a plain modeScopeNote. No dashboard surface read those
// fields: an armed LIVE_SHARED trader who may hold live positions was told
// "You are not currently in live trading mode", and the position picker said
// "0" positions. The row filter (PAPER) is unchanged; only the words change.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/instantTradeRouter", () => ({ executeInstantTrade: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/positions/PositionMiniChart", () => ({ PositionMiniChart: () => null }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: null }) }));

import { OpenLivePositions } from "./OpenLivePositions";
import { PositionPickerPanel } from "@/components/positions/PositionPickerPanel";

const NOTE =
  "The account's trading mode could not be read (tried 14:05 UTC), so rows here are filtered as PAPER, the safest scope. The account may not be in PAPER mode.";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stub(body: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
}

function renderLiveCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, gcTime: 0, staleTime: 0 } } });
  return render(<QueryClientProvider client={qc}><OpenLivePositions /></QueryClientProvider>);
}

const LIVE_UNREAD = {
  items: [], count: 0, snapshotWarning: null, snapshotReliable: false,
  notLiveReason: "ACCOUNT_NOT_IN_LIVE_MODE",
  currentAccountMode: "PAPER", modeScopeApplied: true, primaryDataDomain: "paper",
  modeResolved: false, modeScopeNote: NOTE,
};

describe("OpenLivePositions when the account's mode could not be read", () => {
  it("shows the mode-scope note, not 'not currently in live trading mode', and no '0 open' count", async () => {
    stub(LIVE_UNREAD);
    renderLiveCard();
    const note = await screen.findByTestId("live-positions-mode-unread");
    expect(note.textContent).toContain(NOTE);
    expect(note.textContent).toMatch(/Do not assume you are flat/);
    expect(screen.queryByTestId("live-positions-not-live")).toBeNull();
    expect(screen.queryByTestId("live-positions-empty")).toBeNull();
    expect(document.body.textContent).not.toMatch(/not currently in live trading mode/);
    expect(screen.getByTestId("open-live-positions").textContent).toContain("(count unavailable)");
    expect(screen.getByTestId("open-live-positions").textContent).not.toContain("(0 open)");
  });

  it("a resolved PAPER account keeps the not-in-live-mode copy", async () => {
    stub({ ...LIVE_UNREAD, modeResolved: true, modeScopeNote: null });
    renderLiveCard();
    expect((await screen.findByTestId("live-positions-not-live")).textContent).toMatch(/not currently in live trading mode/);
    expect(screen.queryByTestId("live-positions-mode-unread")).toBeNull();
  });
});

const UNIFIED_UNREAD = {
  ok: true, live: [], demo: [], liveCount: 0, demoCount: 0,
  notLiveReason: "ACCOUNT_NOT_IN_LIVE_MODE",
  currentAccountMode: "PAPER", modeScopeApplied: true, primaryDataDomain: "paper",
  modeResolved: false, modeScopeNote: NOTE,
};

async function renderPicker() {
  render(<PositionPickerPanel />);
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe("PositionPickerPanel when the account's mode could not be read", () => {
  it("shows the mode-scope note instead of 'not in live mode' or 'no open positions', and no 0 count", async () => {
    stub(UNIFIED_UNREAD);
    await renderPicker();
    const note = await screen.findByTestId("positions-mode-unread");
    expect(note.textContent).toContain(NOTE);
    expect(screen.queryByTestId("positions-not-live")).toBeNull();
    expect(screen.queryByTestId("text-no-open-positions")).toBeNull();
    expect(screen.getByTestId("badge-open-positions-count").textContent).toBe("—");
  });

  it("a resolved PAPER account keeps the not-in-live-mode copy and its count", async () => {
    stub({ ...UNIFIED_UNREAD, modeResolved: true, modeScopeNote: null });
    await renderPicker();
    expect((await screen.findByTestId("positions-not-live")).textContent).toMatch(/not currently in live trading mode/);
    expect(screen.queryByTestId("positions-mode-unread")).toBeNull();
    expect(screen.getByTestId("badge-open-positions-count").textContent).toBe("0");
  });
});
