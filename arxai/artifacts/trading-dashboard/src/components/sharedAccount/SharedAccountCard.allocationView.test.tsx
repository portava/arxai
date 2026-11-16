import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SharedAccountCard } from "./SharedAccountCard";

// Render-proof for the live-allocation source-of-truth fix. A normal (non
// owner/admin) shared user's ARX Allocation section must read the canonical
// allocationView (the SAME figures the live gate enforces), NOT the static
// per-account virtual_balance. This is what made the Cockpit say "$181.58
// available / all clear" while a live submit blocked USER_ALLOCATION_EXHAUSTED.

type SummaryShape = {
  ok: boolean;
  userId: number;
  accounts: Array<Record<string, unknown>>;
  masterAccess?: boolean;
  masterMt5?: unknown;
  allocationView?: {
    assignedAllocation: number;
    availableAllocation: number;
    reservedRisk: number;
    openFloatingLoss: number;
    bridgeAvailability: string;
    bridgeMessage: string;
    hasAllocation: boolean;
    isOverAllocated: boolean;
  } | null;
};

const h = vi.hoisted(() => ({
  summary: null as SummaryShape | null,
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetMeSharedAccountSummary: () => ({
    data: h.summary,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: () => {},
  }),
  getGetMeSharedAccountSummaryQueryKey: () => ["summary"],
  useGetMeSharedAccountPositions: () => ({
    data: { rows: [], count: 0 },
    isLoading: false,
    refetch: () => {},
  }),
  getGetMeSharedAccountPositionsQueryKey: () => ["positions"],
  useGetMeSharedAccountAttributions: () => ({ data: { rows: [] } }),
  useRefreshMeSharedAccountSnapshot: () => ({ isPending: false, mutateAsync: async () => ({}) }),
}));

function normalUser(over: Partial<SummaryShape["allocationView"]> = {}) {
  h.summary = {
    ok: true,
    userId: 4,
    masterAccess: false,
    masterMt5: null,
    // Static virtual_balance is intentionally the OLD, drifted figure ($181.58)
    // so the test fails if the card ever reads it for the Available stat.
    accounts: [
      { id: 1, virtualBalance: 181.58, virtualEquity: 94.85, virtualPnl: -86.73,
        realizedPnl7d: 0, openAttributions: 2, status: "active",
        masterBrokerName: "ARX", masterAccountNumberMasked: "***", accountType: "live" },
    ],
    allocationView: {
      assignedAllocation: 181.58,
      availableAllocation: 0,
      reservedRisk: 0,
      openFloatingLoss: -86.73,
      bridgeAvailability: "HEALTHY",
      bridgeMessage: "",
      hasAllocation: true,
      isOverAllocated: true,
      ...over,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  normalUser();
});
afterEach(() => cleanup());

describe("SharedAccountCard — canonical allocationView", () => {
  it("renders Available from allocationView (0), not the static virtual_balance (181.58)", () => {
    render(<SharedAccountCard />);
    const section = screen.getByTestId("arx-allocation-section");
    const text = section.textContent ?? "";
    // Allocated reads assignedAllocation; Available reads availableAllocation.
    expect(text).toContain("Allocated");
    expect(text).toContain("Available");
    expect(text).toContain("$0.00");
    // The exhausted note explains WHY available is 0 (matches the gate copy).
    expect(screen.getByTestId("arx-allocation-exhausted-note")).toBeTruthy();
  });

  it("shows the 'no allocation assigned' note when hasAllocation is false", () => {
    normalUser({ hasAllocation: false, assignedAllocation: 0, availableAllocation: 0, isOverAllocated: false });
    render(<SharedAccountCard />);
    expect(screen.getByTestId("arx-no-allocation-note")).toBeTruthy();
    // and must NOT claim it is "exhausted" — it was never assigned
    expect(screen.queryByTestId("arx-allocation-exhausted-note")).toBeNull();
  });

  it("shows a positive Available with no warning note when headroom exists", () => {
    normalUser({ assignedAllocation: 200, availableAllocation: 190, reservedRisk: 10, openFloatingLoss: 0, isOverAllocated: false });
    render(<SharedAccountCard />);
    const text = screen.getByTestId("arx-allocation-section").textContent ?? "";
    expect(text).toContain("$190.00");
    expect(screen.queryByTestId("arx-no-allocation-note")).toBeNull();
    expect(screen.queryByTestId("arx-allocation-exhausted-note")).toBeNull();
  });
});
