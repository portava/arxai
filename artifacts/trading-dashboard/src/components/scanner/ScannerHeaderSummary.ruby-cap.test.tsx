// Owner screenshot 2026-10-27 (V75 1m, Deriv public data, admin with trading
// blocked): the ELEANOR tile said "Full read — Eleanor can give a full, live
// read." although (a) no chart read had been run yet — the "Full read" was only
// the client's candle-budget forecast — and (b) the SAME strip's ACTION cell said
// "Feed limited — The live feed isn't fully confirmed".
//
// Render proof against the REAL page stores (RubyReadStoreProvider +
// SelectedActionStoreProvider): the Eleanor cell may say "Full read" only once a
// FULL server read exists for this symbol+timeframe and the strip's own Action
// cell does not report a feed/data limitation.

import { describe, it, expect, afterEach, vi } from "vitest";
import { useEffect, type ReactNode } from "react";
import { render, screen, cleanup } from "@testing-library/react";
import type { ScannerTruth } from "@/lib/scannerTruth";
import type { ChartRead } from "@/lib/rubyReadPanelState";
import type { PublishedScannerAction, RubyReadStatus } from "@/lib/scannerActionability";

let rubyBase: RubyReadStatus = "FULL_READ";

function makeTruth(): ScannerTruth {
  return {
    strip: {
      data: { verdict: "Live", detail: "Live, confirmed candles." },
      ruby: {
        detail:
          rubyBase === "LIMITED_READ"
            ? "Eleanor can read structure, but the live feed isn't fully confirmed."
            : "Eleanor can give a full, live read.",
      },
      trading: { verdict: "Blocked", detail: "Trading is restricted on your account." },
    },
    candles: { lastClose: 33588.01, sourceTechnical: "test", count: 200, minRequired: 150, status: "CONFIRMED" },
    consolidated: {
      rubyReadStatus: rubyBase,
      scannerActionability: "WAIT_FOR_CONFIRMATION",
      userMessage: "Wait for confirmation.",
      internalReasonCode: "FEED_OK",
    },
    dataHealth: { sourceNote: "Deriv public data." },
    readiness: null,
  } as unknown as ScannerTruth;
}

vi.mock("@/lib/use-chart-symbol", () => ({
  useChartSymbol: () => ["V75", () => {}],
  bareSymbol: (s: string) => s,
  setChartSymbol: () => {},
}));
vi.mock("@/hooks/useScannerTimeframe", () => ({
  useScannerTimeframe: () => ["1m", () => {}],
}));
vi.mock("@/hooks/useSymbolTruth", () => ({
  useSymbolTruth: () => ({ scannerTruth: makeTruth(), verdict: null }),
}));
vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({ shouldShowAdminDiagnostics: false }),
}));

import { ScannerHeaderSummary } from "./ScannerHeaderSummary";
import { RubyReadStoreProvider, useRubyReadStore } from "./rubyReadStore";
import { SelectedActionStoreProvider, useSelectedActionStore } from "./selectedActionStore";

function Seed({
  read,
  readTf = "1m",
  action,
  children,
}: {
  read?: ChartRead | null;
  readTf?: string;
  action?: PublishedScannerAction | null;
  children?: ReactNode;
}) {
  const ruby = useRubyReadStore();
  const sel = useSelectedActionStore();
  useEffect(() => {
    if (read !== undefined) ruby.set("V75", readTf, read);
    if (action !== undefined) sel.set("V75", "1m", action);
    // seed once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <>{children}</>;
}

function renderHeader(seed: { read?: ChartRead | null; readTf?: string; action?: PublishedScannerAction | null }) {
  return render(
    <RubyReadStoreProvider>
      <SelectedActionStoreProvider>
        <Seed {...seed} />
        <ScannerHeaderSummary running={false} />
      </SelectedActionStoreProvider>
    </RubyReadStoreProvider>,
  );
}

// A read's newest closed candle time. The header expires a read past the
// timeframe's candle budget (or with no valid time), like the panel does, so
// these fixtures carry a fresh observedAt — see
// ScannerHeaderSummary.read-expiry.test.tsx for the expiry itself.
const FRESH = new Date().toISOString();

const FULL_READ: ChartRead = {
  observedAt: FRESH,
  gated: false,
  dataQuality: "ok",
  readLayer: "FULL",
  liveSetupWithheld: false,
  canShowLiveTradeSetup: true,
  bias: "Bullish",
};

const DELAYED_REASON =
  "Live feed is delayed — read uses the last confirmed bars, not the current candle.";

function eleanorCell() {
  const cell = screen.getByTestId("scanner-header-ruby");
  return cell.textContent ?? "";
}

afterEach(() => {
  cleanup();
  rubyBase = "FULL_READ";
});

describe("ScannerHeaderSummary — Eleanor cell never claims a read nobody produced", () => {
  it("(a) no chart read yet: 'Read not run', never 'Full read' / 'full, live read'", () => {
    renderHeader({});
    const text = eleanorCell();
    expect(text).toContain("Read not run");
    expect(text).toContain("No chart read yet — tap Read this chart.");
    expect(text).not.toContain("Full read");
    expect(text).not.toContain("full, live read");
  });

  it("(b) Action cell 'Feed limited' caps the cell to 'Limited read' with the shared feed copy", () => {
    renderHeader({ read: FULL_READ, action: "FEED_LIMITED" });
    const text = eleanorCell();
    expect(screen.getByTestId("scanner-header-action").textContent).toContain("Feed limited");
    expect(text).toContain("Limited read");
    expect(text).toContain("The live feed isn't fully confirmed — Eleanor reads with caution.");
    expect(text).not.toContain("Full read");
  });

  it("(b2) Action 'Analysis only' also caps it, even before any read", () => {
    renderHeader({ action: "ANALYSIS_ONLY" });
    const text = eleanorCell();
    expect(text).toContain("Limited read");
    expect(text).not.toContain("Read not run");
    expect(text).not.toContain("Full read");
  });

  it("(c) a STRUCTURAL_ONLY read caps it to 'Limited read' with the server's reason", () => {
    renderHeader({
      read: { observedAt: FRESH, gated: false, dataQuality: "ok", readLayer: "STRUCTURAL_ONLY", blockedReason: DELAYED_REASON },
    });
    const text = eleanorCell();
    expect(text).toContain("Limited read");
    expect(text).toContain(DELAYED_REASON);
  });

  it("(d) a FULL server read beside a WAIT action may say 'Full read'", () => {
    renderHeader({ read: FULL_READ });
    expect(eleanorCell()).toContain("Full read");
  });

  it("(e) CHECK_FAILED is a setup-check error, not a feed verdict: a FULL read stays 'Full read'", () => {
    renderHeader({ read: FULL_READ, action: "CHECK_FAILED" });
    expect(eleanorCell()).toContain("Full read");
  });

  it("(f) base LIMITED_READ with no read still says 'Limited read' (an honest limitation)", () => {
    rubyBase = "LIMITED_READ";
    renderHeader({});
    const text = eleanorCell();
    expect(text).toContain("Limited read");
    expect(text).not.toContain("Read not run");
  });

  it("(g) a read stored under the engine form 'M1' (scalp card 'Ask Eleanor') caps the 1m header", () => {
    renderHeader({
      read: { observedAt: FRESH, gated: false, dataQuality: "ok", readLayer: "STRUCTURAL_ONLY", blockedReason: DELAYED_REASON },
      readTf: "M1",
    });
    const text = eleanorCell();
    expect(text).toContain("Limited read");
    expect(text).toContain(DELAYED_REASON);
  });
});
