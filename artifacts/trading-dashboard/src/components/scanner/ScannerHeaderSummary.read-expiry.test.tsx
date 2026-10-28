// The Ruby Chart Read panel marks a non-gated read expired once its newest
// closed candle (server `observedAt`) is older than the timeframe's candle
// budget, or when its time is unknown. The page store keeps the read
// indefinitely, so the header's Eleanor cell must apply the SAME expiry: an
// expired read is not a current "Full read".
//
// Render proof against the REAL RubyReadStoreProvider, with live truth mocked
// at the hook boundary.

import { describe, it, expect, afterEach, vi } from "vitest";
import { useEffect, type ReactNode } from "react";
import { render, screen, cleanup } from "@testing-library/react";
import type { ScannerTruth } from "@/lib/scannerTruth";
import { thresholdsFor } from "@/lib/scannerTruth";
import type { ChartRead } from "@/lib/rubyReadPanelState";

function makeTruth(): ScannerTruth {
  return {
    strip: {
      data: { verdict: "Live", detail: "Live, confirmed candles." },
      ruby: { detail: "Eleanor can give a full, live read." },
      trading: { verdict: "Blocked", detail: "Trading is restricted on your account." },
    },
    candles: { lastClose: 1.0842, sourceTechnical: "test", count: 200, minRequired: 150, status: "CONFIRMED" },
    consolidated: {
      rubyReadStatus: "FULL_READ",
      scannerActionability: "WAIT_FOR_CONFIRMATION",
      userMessage: "Wait for confirmation.",
      internalReasonCode: "FEED_OK",
    },
    dataHealth: { sourceNote: "Live feed." },
    readiness: null,
  } as unknown as ScannerTruth;
}

vi.mock("@/lib/use-chart-symbol", () => ({
  useChartSymbol: () => ["EURUSD", () => {}],
  bareSymbol: (s: string) => s,
  setChartSymbol: () => {},
}));
vi.mock("@/hooks/useScannerTimeframe", () => ({
  useScannerTimeframe: () => ["15m", () => {}],
}));
vi.mock("@/hooks/useSymbolTruth", () => ({
  useSymbolTruth: () => ({ scannerTruth: makeTruth(), verdict: null }),
}));
vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({ shouldShowAdminDiagnostics: false }),
}));

import { ScannerHeaderSummary } from "./ScannerHeaderSummary";
import { RubyReadStoreProvider, useRubyReadStore } from "./rubyReadStore";
import { SelectedActionStoreProvider } from "./selectedActionStore";

function Seed({ read, children }: { read: ChartRead; children?: ReactNode }) {
  const ruby = useRubyReadStore();
  useEffect(() => {
    ruby.set("EURUSD", "15m", read);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <>{children}</>;
}

function renderHeader(read: ChartRead) {
  return render(
    <RubyReadStoreProvider>
      <SelectedActionStoreProvider>
        <Seed read={read} />
        <ScannerHeaderSummary running={false} />
      </SelectedActionStoreProvider>
    </RubyReadStoreProvider>,
  );
}

const BASE_READ: ChartRead = {
  gated: false,
  dataQuality: "ok",
  readLayer: "FULL",
  liveSetupWithheld: false,
  canShowLiveTradeSetup: true,
  bias: "Bullish",
};

function eleanorCell(): string {
  return screen.getByTestId("scanner-header-ruby").textContent ?? "";
}

afterEach(() => {
  cleanup();
});

describe("ScannerHeaderSummary — an expired chart read is not a current 'Full read'", () => {
  it("a non-gated read older than the 15m candle budget reads 'Read expired'", () => {
    const old = new Date(Date.now() - thresholdsFor("15m").candleMaxAgeMs - 60_000).toISOString();
    renderHeader({ ...BASE_READ, observedAt: old });
    const text = eleanorCell();
    expect(text).not.toContain("Full read");
    expect(text).toContain("Read expired");
    expect(text).toMatch(/Re-read/);
  });

  it("a read with no observedAt is treated as expired (fail-closed, same as the panel)", () => {
    renderHeader({ ...BASE_READ });
    const text = eleanorCell();
    expect(text).not.toContain("Full read");
    expect(text).toContain("Read expired");
  });

  // The read stops being current when the next 15m candle closes (newest
  // closed candle + one interval, the shared trailing-interval rule), not after
  // the old 18-minute budget.
  it("a 15m read whose newest closed candle is 16 minutes old reads 'Read expired'", () => {
    renderHeader({ ...BASE_READ, observedAt: new Date(Date.now() - 16 * 60_000).toISOString() });
    const text = eleanorCell();
    expect(text).not.toContain("Full read");
    expect(text).toContain("Read expired");
  });

  it("a fresh read inside the budget still reads 'Full read'", () => {
    renderHeader({ ...BASE_READ, observedAt: new Date(Date.now() - 60_000).toISOString() });
    expect(eleanorCell()).toContain("Full read");
  });
});
