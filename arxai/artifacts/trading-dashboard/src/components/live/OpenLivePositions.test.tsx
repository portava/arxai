import {
  describe, it, expect, beforeEach, afterEach, vi,
} from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { OpenLivePositions } from "./OpenLivePositions";

/**
 * #4 (UI half) — A revoked / frozen live trader can still CLOSE their own open
 * positions.
 *
 * OpenLivePositions is the live-position manager. Its close affordance is
 * gated ONLY on a row having a real broker ticket (`brokerPositionId`) and no
 * in-flight close — it deliberately does NOT consult `canManualTrade`,
 * `isFrozen`, or any approval state. That structural independence is the
 * frontend guarantee that revocation / kill-switch can never hide the exit. The
 * close itself routes through the audited Global Instant Trade Router, so the
 * backend reduce-risk policy stays authoritative.
 *
 * (The complementary OPEN/MODIFY-blocked half of #4 is locked at the logic
 * layer in lib/liveActionCapabilities.test.ts.)
 *
 * Data + mutation hooks are mocked; the router/rejection helpers are stubbed so
 * no network or instant-trade side effect runs.
 */

const h = vi.hoisted(() => ({
  items: [] as Array<Record<string, unknown>>,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { items: h.items, count: h.items.length } }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));
vi.mock("@/lib/instantTradeRouter", () => ({
  executeInstantTrade: vi.fn(),
}));
vi.mock("@/lib/structuredRejection", () => ({
  structureRejection: () => ({ title: "", userMessage: "", suggestedFix: "" }),
}));

function pos(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    brokerPositionId: "777001",
    symbol: "EURUSD",
    direction: "BUY",
    lotSize: 0.1,
    entryPrice: 1.1,
    currentPrice: 1.1,
    stopLoss: null,
    takeProfit: null,
    unrealizedProfitLoss: 0,
    openedAt: null,
    status: "OPEN",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.items = [];
});
afterEach(() => {
  cleanup();
});

describe("OpenLivePositions — close controls survive revocation/freeze", () => {
  it("renders an ENABLED close button for a ticketed open position", () => {
    h.items = [pos({ id: 42, brokerPositionId: "777042" })];
    render(<OpenLivePositions />);
    const btn = screen.getByTestId("btn-close-live-42") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(false);
  });

  it("offers a 'Close all' control whenever there is at least one open position", () => {
    h.items = [pos({ id: 7, brokerPositionId: "777007" })];
    render(<OpenLivePositions />);
    expect(screen.getByTestId("btn-close-all-live")).toBeTruthy();
  });

  it("disables ONLY the per-row close when a position has no broker ticket", () => {
    // No broker ticket → nothing to close at the broker, so the row's button is
    // disabled. This is a data-integrity guard, NOT a permission gate.
    h.items = [pos({ id: 9, brokerPositionId: null })];
    render(<OpenLivePositions />);
    const btn = screen.getByTestId("btn-close-live-9") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("does not depend on any trading-mode/approval hook (close cannot be permission-hidden)", () => {
    // The component imports no useTradingMode / canManualTrade / isFrozen — a
    // ticketed row always renders its close control. Two ticketed rows → two
    // enabled close buttons regardless of any account state.
    h.items = [
      pos({ id: 1, brokerPositionId: "111" }),
      pos({ id: 2, brokerPositionId: "222" }),
    ];
    render(<OpenLivePositions />);
    expect((screen.getByTestId("btn-close-live-1") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId("btn-close-live-2") as HTMLButtonElement).disabled).toBe(false);
  });
});
