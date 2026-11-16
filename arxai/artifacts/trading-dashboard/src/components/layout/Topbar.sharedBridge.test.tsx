// Topbar MT5 pill vs the shared master bridge. /mt5/status reports
// `connected` for the user's OWN mt5_connection only; a SHARED_MASTER_MT5 user
// with no connection of their own gets connected:false, mode NOT_CONNECTED and
// sharedMasterBridge {connected:true} while the master bridge is healthy. The
// MT5 Bridge page reads the shared bridge; the topbar read only `connected`
// and said "MT5: OFF" / "MT5 connected: no" / "Mode: Mock".
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

let mt5Reply: { data?: unknown; isError?: boolean; dataUpdatedAt?: number } = {};
let botReply: { data?: unknown; isError?: boolean; dataUpdatedAt?: number } = {};
vi.mock("@workspace/api-client-react", () => ({
  useGetMt5Status: () => mt5Reply,
  useGetBotStatus: () => botReply,
  getGetMt5StatusQueryKey: () => ["mt5-status"],
  getGetBotStatusQueryKey: () => ["bot-status"],
}));
vi.mock("./SymbolPicker", () => ({ SymbolPicker: () => null }));
vi.mock("@/components/alerts/NotificationBell", () => ({ NotificationBell: () => null }));
// Codex line: the header also carries the one-click mode toggle (its own
// query); not under test here, same stub as Topbar.session.test.
vi.mock("@/components/oneclick/OneClickModeToggle", () => ({ OneClickModeToggle: () => null }));
let unlocks = { mt5: true, simulator: false };
vi.mock("@/hooks/useFeatureUnlock", () => ({ useAllUnlocks: () => unlocks }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: null }), useLogout: () => ({ mutate: () => {}, isPending: false }) }));
let viewerIsAdmin = false;
vi.mock("@/hooks/useViewMode", () => ({ useViewMode: () => ({ canToggle: false, viewMode: "user", setViewMode: () => {}, effectiveIsAdmin: viewerIsAdmin }) }));

import { Topbar } from "./Topbar";

const SHARED_HEALTHY = {
  connected: false, mode: "NOT_CONNECTED", route: "SHARED_MASTER",
  sharedMasterBridge: { availability: "HEALTHY", connected: true, message: "The shared bridge is reporting.", snapshotAgeSeconds: 3 },
  lastHeartbeatAt: null,
};

afterEach(() => { cleanup(); mt5Reply = {}; botReply = {}; unlocks = { mt5: true, simulator: false }; viewerIsAdmin = false; });

const pill = (id: string) => screen.getByTestId(`status-pill-${id}`).textContent ?? "";
function drawerText() {
  fireEvent.click(screen.getByTestId("topbar-status-row"));
  return screen.getByTestId("status-drawer-body").textContent ?? "";
}

describe("Topbar MT5 pill — shared master bridge", () => {
  it("a shared-master user with a healthy master bridge is not shown as MT5 OFF", () => {
    mt5Reply = { data: SHARED_HEALTHY };
    render(<Topbar />);
    expect(pill("mt5")).not.toContain("OFF");
    expect(pill("mt5")).toContain("ON");
    expect(pill("mode")).not.toContain("Mock");
    expect(screen.getByTestId("badge-mt5-connection").textContent).toBe("connected");
    const drawer = drawerText();
    expect(drawer).not.toMatch(/MT5 connected\s*no/);
    expect(drawer).toMatch(/shared/i);
  });

  it("a stale shared master bridge is not ON", () => {
    mt5Reply = { data: { ...SHARED_HEALTHY, sharedMasterBridge: { availability: "STALE", connected: false, message: "The shared bridge heartbeat is stale.", snapshotAgeSeconds: 400 } } };
    render(<Topbar />);
    expect(pill("mt5")).not.toContain("ON");
    expect(pill("mt5")).toMatch(/stale/i);
  });

  it("a user with no bridge at all still reads OFF", () => {
    mt5Reply = { data: { connected: false, mode: "NOT_CONNECTED", route: "NONE", sharedMasterBridge: null, lastHeartbeatAt: null } };
    render(<Topbar />);
    expect(pill("mt5")).toContain("OFF");
    expect(pill("mode")).not.toContain("Mock");
  });

  it("a user whose routing could not be read is not shown OFF / 'no' / Not connected", () => {
    mt5Reply = { data: { connected: false, mode: "NOT_CONNECTED", route: "NONE", sharedMasterBridge: null, routeReadFailed: true, lastHeartbeatAt: null } };
    render(<Topbar />);
    expect(pill("mt5")).not.toContain("OFF");
    expect(pill("mt5")).toMatch(/unknown/i);
    expect(pill("mode")).not.toMatch(/Not connected/);
    expect(pill("mode")).toMatch(/unknown/i);
    expect(screen.getByTestId("badge-mt5-connection").textContent).toBe("unknown");
    const drawer = drawerText();
    expect(drawer).not.toMatch(/MT5 connected\s*no\b/);
    expect(drawer).toMatch(/could not be read/i);
  });

  it("a failed status request reads unknown, not OFF", () => {
    mt5Reply = { data: undefined, isError: true };
    render(<Topbar />);
    expect(pill("mt5")).not.toContain("OFF");
    expect(pill("mt5")).toMatch(/unknown/i);
    expect(drawerText()).toMatch(/could not be loaded/i);
  });
});

// React Query keeps the last data when a refetch fails (isError true, data
// still cached). The 5 s polls used to keep showing that cached "ON" /
// "yes (shared MT5 bridge)" with no sign it could not be refreshed.
describe("Topbar MT5 pill — status polls that start failing", () => {
  const READ_AT = new Date("2026-11-03T12:00:01Z").getTime();

  it("cached ON after a failed refresh is not shown as ON; the drawer says when it was last read", () => {
    mt5Reply = { data: SHARED_HEALTHY, isError: true, dataUpdatedAt: READ_AT };
    render(<Topbar />);
    expect(pill("mt5")).not.toContain("ON");
    expect(pill("mt5")).toMatch(/not refreshed/i);
    expect(pill("mode")).not.toMatch(/Shared bridge/);
    expect(pill("mode")).toMatch(/unknown/i);
    expect(screen.getByTestId("badge-mt5-connection").textContent).toBe("unknown");
    const drawer = drawerText();
    expect(drawer).not.toMatch(/yes \(shared MT5 bridge\)/);
    expect(drawer).toMatch(/could not be refreshed/i);
    expect(drawer).toContain(new Date(READ_AT).toLocaleTimeString());
  });

  it("a cached own-EA heartbeat is labelled as of the last read, not current", () => {
    const hb = "2026-11-03T11:59:58Z";
    mt5Reply = { data: { connected: true, mode: "LIVE_LOCKED", route: "OWN_CONNECTION", lastHeartbeatAt: hb }, isError: true, dataUpdatedAt: READ_AT };
    render(<Topbar />);
    expect(pill("mt5")).not.toContain("ON");
    const drawer = drawerText();
    expect(drawer).not.toMatch(/yes \(your own EA\)/);
    expect(drawer).toMatch(/Last heartbeat \(as of last read\)/);
  });

  it("a cached bot state after a failed refresh is not shown as current", () => {
    mt5Reply = { data: SHARED_HEALTHY };
    botReply = { data: { isRunning: true, isPaused: false }, isError: true, dataUpdatedAt: READ_AT };
    render(<Topbar />);
    expect(pill("bot")).not.toMatch(/Running/);
    expect(pill("bot")).toMatch(/not refreshed/i);
    // fix-17 renamed the drawer row to "Saved bot setting" (a saved preference, not an engine state).
    expect(drawerText()).toMatch(/Saved bot setting.*could not be refreshed/i);
  });

  it("a successful poll still reads ON", () => {
    mt5Reply = { data: SHARED_HEALTHY, isError: false, dataUpdatedAt: READ_AT };
    render(<Topbar />);
    expect(pill("mt5")).toContain("ON");
  });
});

// The MT5 status query only runs once MT5 is turned on for the user
// (useAllUnlocks().mt5, from "Connect MT5" in Getting Started). With it off,
// no request is made, yet the drawer said "MT5 mode: Checking" / "MT5
// connected: checking" for a check that never runs.
describe("Topbar status drawer — MT5 status not requested", () => {
  it("does not claim a check is in progress when the MT5 query is disabled", () => {
    unlocks = { mt5: false, simulator: false };
    mt5Reply = { data: undefined, isError: false };
    render(<Topbar />);
    expect(screen.queryByTestId("status-pill-mt5")).toBeNull();
    const drawer = drawerText();
    expect(drawer).not.toMatch(/checking/i);
    expect(drawer).not.toMatch(/MT5 mode/);
    expect(drawer).toMatch(/MT5 status\s*not checked/);
  });

  it("with MT5 turned on and the first read in flight, 'checking' is still said", () => {
    mt5Reply = { data: undefined, isError: false };
    render(<Topbar />);
    expect(drawerText()).toMatch(/MT5 connected\s*checking/);
  });
});

// Only the admin-only Getting Started checklist turns MT5 on in this header
// (dashboard.tsx renders it inside "System Health · Admin"). A regular trader
// was told to press "Connect MT5" on a dashboard checklist they never see; the
// "Connect MT5" buttons they do see open My MT5 and do not change the header.
describe("Topbar status drawer — what turns MT5 status on, per viewer", () => {
  it("a regular trader is not sent to a checklist they cannot see", () => {
    unlocks = { mt5: false, simulator: false };
    viewerIsAdmin = false;
    render(<Topbar />);
    const drawer = drawerText();
    expect(drawer).toMatch(/MT5 status\s*not checked/);
    expect(drawer).not.toMatch(/checklist/i);
    expect(drawer).toMatch(/My MT5/);
    expect(screen.getByTestId("topbar-mt5-not-checked").querySelector('a[href="/my-mt5"]')).not.toBeNull();
  });

  it("an admin is told where the checklist is", () => {
    unlocks = { mt5: false, simulator: false };
    viewerIsAdmin = true;
    render(<Topbar />);
    expect(drawerText()).toMatch(/"Connect MT5" in the welcome checklist.*System Health · Admin/);
  });
});

// With MT5 off in the header its status query is disabled, but another page
// (MT5 Bridge polls the same query key) can fill the shared cache. A disabled
// observer still returns that cached answer and never refreshes it, so the
// drawer showed Account, Broker and a plain "Last heartbeat" — frozen at
// whenever that page last read it — right under "MT5 status: not checked".
describe("Topbar status drawer — cached status while the header does not read it", () => {
  const CACHED = {
    connected: true, mode: "LIVE_LOCKED", route: "OWN_CONNECTION",
    lastHeartbeatAt: "2026-11-03T09:15:00Z",
    accountSnapshot: { account: "5550123", broker: "QA Broker", server: "QA-Demo", balance: 1000, equity: 1000, currency: "USD" },
  };

  it("shows no account, broker or heartbeat from a cache the header does not refresh", () => {
    unlocks = { mt5: false, simulator: false };
    mt5Reply = { data: CACHED, isError: false, dataUpdatedAt: Date.now() - 3_600_000 };
    render(<Topbar />);
    const drawer = drawerText();
    expect(drawer).toMatch(/MT5 status\s*not checked/);
    expect(drawer).not.toMatch(/Account/);
    expect(drawer).not.toContain("5550123");
    expect(drawer).not.toMatch(/Broker/);
    expect(drawer).not.toMatch(/Last heartbeat/);
  });

  it("shows no saved bot setting from a cache the header does not refresh", () => {
    unlocks = { mt5: false, simulator: false };
    botReply = { data: { isRunning: true, isPaused: false, lastScanAt: "2026-11-03T09:15:00Z" }, isError: false };
    render(<Topbar />);
    expect(screen.queryByTestId("status-pill-bot")).toBeNull();
    const drawer = drawerText();
    expect(drawer).not.toMatch(/Saved bot setting/);
    expect(drawer).not.toMatch(/Last scan recorded/);
  });

  it("with MT5 on, the polled account and heartbeat still show", () => {
    mt5Reply = { data: CACHED, isError: false, dataUpdatedAt: Date.now() };
    render(<Topbar />);
    const drawer = drawerText();
    expect(drawer).toContain("5550123");
    expect(drawer).toMatch(/Last heartbeat/);
  });
});

// The server answers availability UNKNOWN when the shared bridge's allocation
// view could not be read. The pill said Unknown, but the screen-reader marker
// said "disconnected", a state nobody observed.
describe("Topbar MT5 marker — shared bridge that could not be read", () => {
  it("availability UNKNOWN reads unknown, not disconnected", () => {
    mt5Reply = { data: { ...SHARED_HEALTHY, sharedMasterBridge: { availability: "UNKNOWN", connected: false, message: "Shared MT5 bridge status could not be read.", snapshotAgeSeconds: null } } };
    render(<Topbar />);
    expect(pill("mt5")).toMatch(/unknown/i);
    expect(screen.getByTestId("badge-mt5-connection").textContent).toBe("unknown");
    const drawer = drawerText();
    expect(drawer).not.toMatch(/MT5 connected\s*no\b/);
    expect(drawer).toMatch(/could not be read/);
  });

  it("a shared-master answer with no bridge object reads unknown, not disconnected", () => {
    mt5Reply = { data: { ...SHARED_HEALTHY, sharedMasterBridge: null } };
    render(<Topbar />);
    expect(screen.getByTestId("badge-mt5-connection").textContent).toBe("unknown");
  });

  it("a bridge read as unavailable still reads disconnected", () => {
    mt5Reply = { data: { ...SHARED_HEALTHY, sharedMasterBridge: { availability: "UNAVAILABLE", connected: false, message: "Shared bridge unavailable.", snapshotAgeSeconds: 2 } } };
    render(<Topbar />);
    expect(screen.getByTestId("badge-mt5-connection").textContent).toBe("disconnected");
  });
});
