// Topbar MT5 pill vs the shared master bridge. /mt5/status reports
// `connected` for the user's OWN mt5_connection only; a SHARED_MASTER_MT5 user
// with no connection of their own gets connected:false, mode NOT_CONNECTED and
// sharedMasterBridge {connected:true} while the master bridge is healthy. The
// MT5 Bridge page reads the shared bridge; the topbar read only `connected`
// and said "MT5: OFF" / "MT5 connected: no" / "Mode: Mock".
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

let mt5Reply: { data?: unknown; isError?: boolean } = {};
vi.mock("@workspace/api-client-react", () => ({
  useGetMt5Status: () => mt5Reply,
  useGetBotStatus: () => ({ data: undefined }),
  getGetMt5StatusQueryKey: () => ["mt5-status"],
  getGetBotStatusQueryKey: () => ["bot-status"],
}));
vi.mock("./SymbolPicker", () => ({ SymbolPicker: () => null }));
vi.mock("@/components/alerts/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("@/hooks/useFeatureUnlock", () => ({ useAllUnlocks: () => ({ mt5: true, simulator: false }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: null }), useLogout: () => ({ mutate: () => {}, isPending: false }) }));
vi.mock("@/hooks/useViewMode", () => ({ useViewMode: () => ({ canToggle: false, viewMode: "user", setViewMode: () => {} }) }));

import { Topbar } from "./Topbar";

const SHARED_HEALTHY = {
  connected: false, mode: "NOT_CONNECTED", route: "SHARED_MASTER",
  sharedMasterBridge: { availability: "HEALTHY", connected: true, message: "The shared bridge is reporting.", snapshotAgeSeconds: 3 },
  lastHeartbeatAt: null,
};

afterEach(() => { cleanup(); });

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

  it("a failed status request reads unknown, not OFF", () => {
    mt5Reply = { data: undefined, isError: true };
    render(<Topbar />);
    expect(pill("mt5")).not.toContain("OFF");
    expect(pill("mt5")).toMatch(/unknown/i);
    expect(drawerText()).toMatch(/could not be loaded/i);
  });
});
