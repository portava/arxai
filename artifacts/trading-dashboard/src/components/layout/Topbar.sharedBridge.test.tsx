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
let unlocks = { mt5: true, simulator: false };
vi.mock("@/hooks/useFeatureUnlock", () => ({ useAllUnlocks: () => unlocks }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: null }), useLogout: () => ({ mutate: () => {}, isPending: false }) }));
vi.mock("@/hooks/useViewMode", () => ({ useViewMode: () => ({ canToggle: false, viewMode: "user", setViewMode: () => {} }) }));

import { Topbar } from "./Topbar";

const SHARED_HEALTHY = {
  connected: false, mode: "NOT_CONNECTED", route: "SHARED_MASTER",
  sharedMasterBridge: { availability: "HEALTHY", connected: true, message: "The shared bridge is reporting.", snapshotAgeSeconds: 3 },
  lastHeartbeatAt: null,
};

afterEach(() => { cleanup(); mt5Reply = {}; botReply = {}; unlocks = { mt5: true, simulator: false }; });

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
