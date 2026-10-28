// Truth regression: per-user queries keyed without a user id (account mode,
// Ruby market edge, chart intelligence, trade health, …) must never show the
// previous user's data after the signed-in identity changes, whether by
// signing in on this tab or by a /api/me refetch that returns another user
// (sign-out and sign-in from another tab).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { getGetMeMarketEdgeQueryKey } from "@workspace/api-client-react";
import { useCurrentUser, useLogin } from "./useCurrentUser";
import { useTradingMode } from "./useTradingMode";

const ACCOUNT_MODE_KEY = ["me", "account-mode"] as const;
const EDGE_KEY = getGetMeMarketEdgeQueryKey({ symbol: "EURUSD", timeframe: "M15" } as never);

function user(id: number) {
  return { id, email: `u${id}@x.test`, name: null, role: "user", lastLoginAt: null, createdAt: "", updatedAt: "" };
}

function liveEnvelope(userId: number) {
  return {
    ok: true,
    userId,
    currentAccountMode: "LIVE_SHARED",
    cleanModeLabel: "Live (shared)",
    cleanUserMessage: "",
    cleanBlockedReason: null,
    role: "USER",
    isAdmin: false,
    isAdminPreviewingUserMode: false,
    adminDiagnosticsAvailable: false,
    liveExecutionArmed: true,
    userSharedMasterAssignment: { attached: true },
    accountShellStatus: { accountMode: "SHARED_MASTER_MT5", tradingMode: "LIVE", tradingModeLabel: "Live", approvalStatus: "approved", tradingStatus: "ok" },
    userAllocation: { hasAllocation: true, currentBalance: 1000, assignedStartingBalance: 1000, equity: 1000, marginUsed: 0 },
    userRiskCaps: { maxLotSize: 1, maxOpenTrades: 3, maxDailyLossAmount: 100, allowedSymbols: null, requireStopLoss: true },
    userFrozenStatus: { isFrozen: false, freezeMessage: null },
    userApprovalStatus: "approved",
    userCanManualTrade: true,
    userCanAutoTrade: true,
    aiSleeveStatus: { enabled: true, autoEnabled: false },
    demoAvailable: true,
    paperAvailable: false,
    modeSwitchOptions: [],
    adminDiagnostics: null,
  };
}

let client: QueryClient;
let meResponse: ReturnType<typeof user> | null = user(1);

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  meResponse = user(1);
  vi.stubGlobal("fetch", vi.fn((input: string) => {
    const url = String(input);
    if (url.endsWith("/api/auth/login")) {
      return Promise.resolve(new Response(JSON.stringify({ user: user(2) }), { status: 200 }));
    }
    if (url.endsWith("/api/me")) {
      return Promise.resolve(new Response(JSON.stringify({ user: meResponse }), { status: 200 }));
    }
    // Every per-user read for the new user stays in flight: the test checks
    // what is shown BEFORE user 2's own data arrives.
    return new Promise<Response>(() => undefined);
  }));
  client.setQueryData(["me"], user(1));
  client.setQueryData(ACCOUNT_MODE_KEY, liveEnvelope(1));
  client.setQueryData(EDGE_KEY, { userId: 1, read: "user 1 market edge" });
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

describe("identity change re-scopes per-user cache", () => {
  it("signing in as another user drops the previous user's account mode and market edge", async () => {
    const { result } = renderHook(() => ({ login: useLogin(), mode: useTradingMode() }), { wrapper });
    expect(result.current.mode.isLiveShared).toBe(true);
    await act(async () => {
      await result.current.login.mutateAsync({ email: "u2@x.test", password: "pw" });
    });
    expect(client.getQueryData<{ id: number }>(["me"])?.id).toBe(2);
    expect(client.getQueryData(ACCOUNT_MODE_KEY)).toBeUndefined();
    expect(client.getQueryData(EDGE_KEY)).toBeUndefined();
    await waitFor(() => expect(result.current.mode.isLiveShared).toBe(false));
    expect(result.current.mode.isLiveArmed).toBe(false);
  });

  it("a /api/me refetch that returns another user drops the previous user's data", async () => {
    const { result } = renderHook(() => ({ me: useCurrentUser(), mode: useTradingMode() }), { wrapper });
    expect(result.current.me.user?.id).toBe(1);
    expect(result.current.mode.isLiveShared).toBe(true);
    meResponse = user(2);
    await act(async () => { await result.current.me.refetch(); });
    await waitFor(() => expect(result.current.me.user?.id).toBe(2));
    expect(client.getQueryData(ACCOUNT_MODE_KEY)).toBeUndefined();
    expect(client.getQueryData(EDGE_KEY)).toBeUndefined();
    await waitFor(() => expect(result.current.mode.isLiveShared).toBe(false));
  });

  it("a /api/me refetch for the same user keeps the cache", async () => {
    const { result } = renderHook(() => ({ me: useCurrentUser(), mode: useTradingMode() }), { wrapper });
    await act(async () => { await result.current.me.refetch(); });
    expect(client.getQueryData(ACCOUNT_MODE_KEY)).toBeDefined();
    expect(client.getQueryData(EDGE_KEY)).toBeDefined();
    expect(result.current.mode.isLiveShared).toBe(true);
  });
});
