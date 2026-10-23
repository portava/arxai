// autopilot-control-center.roleGate.test.tsx — render proof for the cached
// /api/me role pre-check on the admin-only Autopilot Control Center.
//
// Locks the contract:
//   1. Non-admin role → the access-denied card renders immediately and the
//      page fires ZERO autopilot API calls (no /api/autopilot/* fetches).
//   2. Role still resolving → neutral "Checking access…" shell, no API calls,
//      and NO premature access-denied (unresolved role ≠ denied).
//   3. Admin role → behavior unchanged: the page loads status/decisions/locks.
//   4. Defense in depth: for an admin whose server-side check still 403s
//      (e.g. effective-role downgrade), the existing 403 → "Access denied"
//      error path renders.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("lucide-react", () => {
  const Stub = () => null;
  return {
    Bot: Stub, Play: Stub, Pause: Stub, StopCircle: Stub, AlertOctagon: Stub,
    Zap: Stub, ThumbsUp: Stub, ThumbsDown: Stub, Brain: Stub, ShieldAlert: Stub,
  };
});

vi.mock("@/hooks/useProductRole", () => ({
  useProductRole: vi.fn(),
}));

import { useProductRole } from "@/hooks/useProductRole";
import AutopilotControlCenter from "./autopilot-control-center";

const mockedUseProductRole = vi.mocked(useProductRole);

function roleState(over: Partial<ReturnType<typeof useProductRole>>) {
  return {
    role: "USER" as const,
    isAdmin: false,
    isInvestor: false,
    isTrader: true,
    isLoading: false,
    homePath: "/",
    ...over,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes("/api/autopilot/status")) {
      return jsonResponse(200, {
        mode: "OFF", state: "IDLE", session: null, lastScanTs: null,
        nextScanInSec: 0, consecutiveLosses: 0, openSimulatedPositions: 0,
        dailyRiskRemainingUsd: 0, dailyTradesRemaining: 0, activeRiskLocks: [],
        mt5Connected: false, killSwitchEngaged: false, discipline: 100,
        lastDecision: null,
      });
    }
    return jsonResponse(200, { decisions: [], locks: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function autopilotCalls(): string[] {
  return fetchMock.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.includes("/api/autopilot/"));
}

describe("AutopilotControlCenter role pre-check", () => {
  it("non-admin: renders access denied with ZERO autopilot API calls", async () => {
    mockedUseProductRole.mockReturnValue(roleState({ role: "USER", isAdmin: false }));
    render(<AutopilotControlCenter />);

    expect(screen.getByText(/Access denied — Admin or Owner role required/i)).toBeTruthy();
    // Advance past the 3s polling interval — still no calls.
    await vi.advanceTimersByTimeAsync(7000);
    expect(autopilotCalls()).toEqual([]);
  });

  it("role loading: neutral shell, no API calls, no premature denial", async () => {
    mockedUseProductRole.mockReturnValue(roleState({ isLoading: true }));
    render(<AutopilotControlCenter />);

    expect(screen.getByText(/Checking access/i)).toBeTruthy();
    expect(screen.queryByText(/Access denied/i)).toBeNull();
    await vi.advanceTimersByTimeAsync(4000);
    expect(autopilotCalls()).toEqual([]);
  });

  it("admin: loads status/decisions/locks as before", async () => {
    mockedUseProductRole.mockReturnValue(roleState({ role: "ADMIN", isAdmin: true, isTrader: false }));
    render(<AutopilotControlCenter />);

    await vi.advanceTimersByTimeAsync(100);
    const calls = autopilotCalls();
    expect(calls.some((u) => u.includes("/api/autopilot/status"))).toBe(true);
    expect(calls.some((u) => u.includes("/api/autopilot/decisions"))).toBe(true);
    expect(calls.some((u) => u.includes("/api/autopilot/safety-locks"))).toBe(true);
    expect(screen.queryByText(/Access denied/i)).toBeNull();
  });

  it("admin hitting a server-side 403 still gets the honest denied card", async () => {
    mockedUseProductRole.mockReturnValue(roleState({ role: "ADMIN", isAdmin: true, isTrader: false }));
    fetchMock.mockImplementation(async () =>
      jsonResponse(403, { error: "Admin role required" }),
    );
    render(<AutopilotControlCenter />);

    // waitFor uses real timers internally and would hang under fake timers;
    // flushing the faked clock + microtasks is enough for the state update.
    await vi.advanceTimersByTimeAsync(200);
    expect(screen.getByText(/Access denied — Admin or Owner role required/i)).toBeTruthy();
  });
});
