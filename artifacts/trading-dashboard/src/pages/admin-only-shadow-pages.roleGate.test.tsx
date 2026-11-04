// admin-only-shadow-pages.roleGate.test.tsx — render proof for the cached
// /api/me role pre-check on the SHADOW admin-only strategy-research pages that
// live in the normal-user route allowlist (Task #802).
//
// Before this task each page mounted, fired its admin-gated call, took a 403,
// and rendered blank / half-empty UI ("undefined" stats) for a non-admin
// trader. Every page now mirrors the Autopilot Control Center contract:
//   1. Non-admin role → access-denied card immediately, ZERO gated API calls.
//   2. Role still resolving → neutral "Checking access…" shell, no calls, and
//      NO premature denial (unresolved role ≠ denied).
//   3. Admin role → the gated call fires (behavior unchanged).
//   4. Defense in depth: an admin whose server-side check still 403s gets the
//      honest denied card, never blank UI.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("lucide-react", () => {
  const Stub = () => null;
  return {
    Eye: Stub, Play: Stub, StopCircle: Stub, Sparkles: Stub, Gauge: Stub,
    NotebookPen: Stub, TrendingUp: Stub, Swords: Stub, ShieldAlert: Stub,
  };
});

vi.mock("@/hooks/useProductRole", () => ({
  useProductRole: vi.fn(),
}));

import { useProductRole } from "@/hooks/useProductRole";
import ShadowMode from "./shadow-mode";
import AiReadinessScore from "./ai-readiness-score";
import ConfidenceCalibration from "./confidence-calibration";
import ShadowJournal from "./shadow-journal";
import StrategyPromotion from "./strategy-promotion";
import StrategyTournament from "./strategy-tournament";

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

function bodyFor(url: string): unknown {
  if (url.includes("/api/shadow-mode/status")) {
    return { enabled: false, startedAt: null, totalsObserved: 0, totalDecisions: 0, tracking: 0, wins: 0, losses: 0, breakevens: 0, expired: 0, rejected: 0, waits: 0 };
  }
  if (url.includes("/api/shadow-mode/decisions")) return { decisions: [] };
  if (url.includes("/api/ai-readiness-score")) return { score: 50, label: "NOT_READY", factors: {}, realBrokerReadiness: "n/a" };
  if (url.includes("/api/confidence-calibration")) return { totalSample: 0, label: "NEEDS_MORE_DATA", buckets: [] };
  if (url.includes("/api/shadow-journal")) return { entries: [] };
  if (url.includes("/api/strategy-promotion")) return { strategies: [], demotionSuggestions: [] };
  if (url.includes("/api/strategy-tournament")) return { running: false, startedAt: null, ranked: [], leaderboard: {} };
  return {};
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn(async (url: string) => jsonResponse(200, bodyFor(String(url))));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function gatedCalls(fragment: string): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes(fragment));
}

const PAGES = [
  { name: "Shadow Mode", Component: ShadowMode, gated: "/api/shadow-mode" },
  { name: "AI Readiness Score", Component: AiReadinessScore, gated: "/api/ai-readiness-score" },
  { name: "Confidence Calibration", Component: ConfidenceCalibration, gated: "/api/confidence-calibration" },
  { name: "Shadow Journal", Component: ShadowJournal, gated: "/api/shadow-journal" },
  { name: "Strategy Promotion", Component: StrategyPromotion, gated: "/api/strategy-promotion" },
  { name: "Strategy Tournament", Component: StrategyTournament, gated: "/api/strategy-tournament" },
] as const;

describe.each(PAGES)("$name admin role pre-check", ({ Component, gated }) => {
  it("non-admin: renders access denied with ZERO gated API calls", async () => {
    mockedUseProductRole.mockReturnValue(roleState({ role: "USER", isAdmin: false }));
    render(<Component />);

    expect(screen.getByText(/Access denied — Admin or Owner role required/i)).toBeTruthy();
    await vi.advanceTimersByTimeAsync(7000);
    expect(gatedCalls(gated)).toEqual([]);
  });

  it("role loading: neutral shell, no gated calls, no premature denial", async () => {
    mockedUseProductRole.mockReturnValue(roleState({ isLoading: true }));
    render(<Component />);

    expect(screen.getByText(/Checking access/i)).toBeTruthy();
    expect(screen.queryByText(/Access denied/i)).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(gatedCalls(gated)).toEqual([]);
  });

  it("admin: fires the gated call, no denial", async () => {
    mockedUseProductRole.mockReturnValue(roleState({ role: "ADMIN", isAdmin: true, isTrader: false }));
    render(<Component />);

    await vi.advanceTimersByTimeAsync(100);
    expect(gatedCalls(gated).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Access denied/i)).toBeNull();
  });

  it("admin hitting a server-side 403 still gets the honest denied card", async () => {
    mockedUseProductRole.mockReturnValue(roleState({ role: "ADMIN", isAdmin: true, isTrader: false }));
    fetchMock.mockImplementation(async () => jsonResponse(403, { error: "Forbidden", requiredRole: "ADMIN" }));
    render(<Component />);

    await vi.advanceTimersByTimeAsync(200);
    expect(screen.getByText(/Access denied — Admin or Owner role required/i)).toBeTruthy();
  });
});
