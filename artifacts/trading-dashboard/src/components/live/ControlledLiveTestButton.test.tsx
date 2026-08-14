import {
  describe, it, expect, beforeEach, afterEach, vi,
} from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ControlledLiveTestButton } from "./ControlledLiveTestButton";

/**
 * UI coverage for the "EA too old to report close fill — upgrade to v1.28"
 * nudge on the OWNER-only Live Test Cycle panel.
 *
 * The shared boundary (`eaTooOldForCloseFill`, see
 * lib/domain/src/safety-contracts/eaCloseFill.ts) is unit-tested separately,
 * and the Trade Logs P/L cell has its own UI test (PnlCell.test.tsx). This
 * file guards the Live Test Cycle panel's OWN conditional render + copy, which
 * could regress independently of those two sites.
 *
 * The nudge is rendered as `data-testid="cycle-ea-upgrade-hint-<cycleId>"`
 * and must, for a COMPLETED cycle whose P/L could not be trusted
 * (pnlStatus !== "COMPUTED"):
 *   - show when the cycle was closed by an EA that is null / older than v1.28,
 *   - be ABSENT for v1.28+ (boundary: major 1, minor < 28),
 *   - never appear when the P/L is trusted (pnlStatus === "COMPUTED").
 *
 * The panel loads its cycle from GET /api/me/live/test-cycle/current, so we
 * stub fetch to return a seeded completed cycle. useTradingMode is mocked
 * because the panel reads `shouldShowAdminDiagnostics` from it.
 */

const h = vi.hoisted(() => ({
  mode: { shouldShowAdminDiagnostics: false } as { shouldShowAdminDiagnostics: boolean },
}));

vi.mock("../../hooks/useTradingMode", () => ({
  useTradingMode: () => h.mode,
}));

type CycleOverrides = {
  cycleId: string;
  pnlStatus?: "PENDING" | "COMPUTED" | "UNKNOWN" | null;
  reportedEaVersion?: string | null;
  status?: string;
  realizedPlUsd?: number | null;
  dataQualityFlag?: string | null;
};

function makeCycle(o: CycleOverrides) {
  return {
    cycleId: o.cycleId,
    status: o.status ?? "COMPLETED",
    symbol: "EURUSD",
    side: "BUY",
    requestedVolume: 0.01,
    stopLoss: 1.05,
    takeProfit: null,
    openCommandId: "open-cmd",
    openBrokerTicket: "TICKET-1",
    openFillPrice: 1.1,
    openRejectionReason: null,
    closeCommandId: "close-cmd",
    closeFillPrice: null,
    closeRejectionReason: null,
    realizedPlUsd: o.realizedPlUsd ?? null,
    pnlStatus: o.pnlStatus === undefined ? "UNKNOWN" : o.pnlStatus,
    dataQualityFlag: o.dataQualityFlag ?? "MISSING_CLOSE_FILL_PRICE",
    reportedEaVersion: o.reportedEaVersion === undefined ? null : o.reportedEaVersion,
    preflightStartedAt: null,
    openQueuedAt: null,
    eaPickedOpenAt: null,
    brokerOpenAt: null,
    positionDetectedAt: null,
    closeQueuedAt: null,
    eaPickedCloseAt: null,
    brokerCloseAt: null,
    positionRemovedAt: null,
    completedAt: "2026-05-29T00:00:00.000Z",
    blockGate: null,
    blockReason: null,
    manualResolveNote: null,
  };
}

function stubCurrentCycle(cycle: ReturnType<typeof makeCycle>) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/me/live/test-cycle/current")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cycle }),
      } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }) as typeof fetch;
}

const realFetch = global.fetch;

beforeEach(() => {
  h.mode = { shouldShowAdminDiagnostics: false };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  global.fetch = realFetch;
});

describe("ControlledLiveTestButton — Live Test Cycle EA upgrade nudge", () => {
  it("shows the nudge for a COMPLETED UNKNOWN-P/L cycle with a null EA version", async () => {
    stubCurrentCycle(makeCycle({ cycleId: "ltc-null", reportedEaVersion: null }));
    render(<ControlledLiveTestButton />);

    expect(await screen.findByTestId("cycle-ea-upgrade-hint-ltc-null")).toBeTruthy();
    expect(
      screen.getByText("See the v1.28 install steps on the MT5 Setup page").getAttribute("href"),
    ).toBe("/mt5-setup#ea-v128-install");
  });

  it("shows the nudge for a COMPLETED UNKNOWN-P/L cycle closed by EA v1.27", async () => {
    stubCurrentCycle(makeCycle({ cycleId: "ltc-127", reportedEaVersion: "1.27" }));
    render(<ControlledLiveTestButton />);

    expect(await screen.findByTestId("cycle-ea-upgrade-hint-ltc-127")).toBeTruthy();
  });

  it("hides the nudge for a COMPLETED UNKNOWN-P/L cycle closed by EA v1.28 (boundary)", async () => {
    stubCurrentCycle(makeCycle({ cycleId: "ltc-128", reportedEaVersion: "1.28" }));
    render(<ControlledLiveTestButton />);

    // Wait for the cycle to render (its "P/L unavailable" banner is shown for
    // any non-COMPUTED completed cycle) before asserting the nudge is absent.
    await screen.findByText(/P\/L unavailable because the/);
    expect(screen.queryByTestId("cycle-ea-upgrade-hint-ltc-128")).toBeNull();
  });

  it("hides the nudge for newer EA versions (v1.29, v2.0)", async () => {
    stubCurrentCycle(makeCycle({ cycleId: "ltc-129", reportedEaVersion: "1.29" }));
    render(<ControlledLiveTestButton />);
    await screen.findByText(/P\/L unavailable because the/);
    expect(screen.queryByTestId("cycle-ea-upgrade-hint-ltc-129")).toBeNull();
    cleanup();

    stubCurrentCycle(makeCycle({ cycleId: "ltc-20", reportedEaVersion: "2.0" }));
    render(<ControlledLiveTestButton />);
    await screen.findByText(/P\/L unavailable because the/);
    expect(screen.queryByTestId("cycle-ea-upgrade-hint-ltc-20")).toBeNull();
  });

  it("does not render the nudge for a trusted (COMPUTED) P/L cycle", async () => {
    stubCurrentCycle(
      makeCycle({
        cycleId: "ltc-ok",
        pnlStatus: "COMPUTED",
        realizedPlUsd: -1.25,
        reportedEaVersion: null,
        dataQualityFlag: null,
      }),
    );
    render(<ControlledLiveTestButton />);

    // The cycle still renders its status panel; wait for its unique id to
    // appear, then assert no nudge.
    await screen.findByText("ltc-ok");
    expect(screen.queryByTestId("cycle-ea-upgrade-hint-ltc-ok")).toBeNull();
    expect(screen.queryByText(/P\/L unavailable because the/)).toBeNull();
  });

  it("only shows the reported-version diagnostic to operators", async () => {
    h.mode = { shouldShowAdminDiagnostics: true };
    stubCurrentCycle(makeCycle({ cycleId: "ltc-diag", reportedEaVersion: "1.27" }));
    render(<ControlledLiveTestButton />);

    expect(await screen.findByTestId("cycle-ea-upgrade-hint-ltc-diag")).toBeTruthy();
    // Operator diagnostic line surfaces the dataQualityFlag + reportedEaVersion.
    expect(screen.getByText(/dataQualityFlag=/)).toBeTruthy();
  });

  it("hides the operator diagnostic line from non-operators", async () => {
    h.mode = { shouldShowAdminDiagnostics: false };
    stubCurrentCycle(makeCycle({ cycleId: "ltc-nodiag", reportedEaVersion: "1.27" }));
    render(<ControlledLiveTestButton />);

    expect(await screen.findByTestId("cycle-ea-upgrade-hint-ltc-nodiag")).toBeTruthy();
    expect(screen.queryByText(/dataQualityFlag=/)).toBeNull();
  });
});
