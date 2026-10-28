// Owner screenshot 2026-10-27 (V75 1m, Deriv public data, admin with trading
// blocked): the header said ELEANOR "Full read / Eleanor can give a full, live
// read." and TRADE HEALTH "Live-confirmed / Live-confirmed 1m read with enough
// recent closed candles." while Eleanor's own read for the SAME symbol+timeframe
// was a STRUCTURAL_ONLY read whose Risk line said "Exact entry, stop, and target
// levels withheld — Live feed is delayed …".
//
// This is a render proof of the header against the lifted store read, in both
// the fixed wire shape (readLayer "STRUCTURAL_ONLY") and the pre-fix scrubbed
// shape (readLayer ""), asserting the Ruby cell reads "Limited read" with the
// server's withheld reason and the Trade Health chip is capped DOWN to the
// server's own contract verdict. It also locks that the cap never upgrades.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { evaluateTradeHealthReadiness } from "@workspace/domain/market";
import type { ScannerTruth } from "@/lib/scannerTruth";
import type { ChartRead } from "@/lib/rubyReadPanelState";

const WITHHELD_REASON =
  "Live feed is delayed — read uses the last confirmed bars, not the current candle.";

function serverStructuralRead(readLayer: string, tradeHealthFreshness: string): ChartRead {
  return {
    bias: "Mixed",
    htfBias: "No clear edge",
    confidence: "Low",
    supportZone: "33250.6 – 33273.2",
    resistanceZone: "33639.4 – 33662.0",
    cautions: [
      `Exact entry, stop, and target levels withheld — ${WITHHELD_REASON}`,
      "Read is from closed candles only — current-candle/entry confirmation pending.",
    ],
    gated: false,
    dataQuality: "ok",
    readLayer,
    liveSetupWithheld: true,
    canReadStructure: true,
    canShowLiveTradeSetup: false,
    tradeHealthFreshness,
    tradeHealthLabel: "Historical read only",
    tradeHealthTrustLine: "Historical/closed-candle M1 structural read — feed not confirmed for live entry.",
    basis: "VERIFIED",
    blockedReason: WITHHELD_REASON,
  } as unknown as ChartRead;
}

// What the client composed for the owner's state: a live-confirmed 1m read.
function clientLiveConfirmed(): ScannerTruth["readiness"] {
  return evaluateTradeHealthReadiness({
    symbol: "V75",
    timeframe: "1m",
    freshnessVerdict: "LIVE",
    availableClosedCandles: 200,
    minimumRequiredCandles: 150,
    readLayer: "FULL",
    structureConfidence: "MEDIUM",
  });
}

let currentReadiness: ScannerTruth["readiness"] = clientLiveConfirmed();
let storedRead: ChartRead | null = null;
const storeKeys: string[] = [];

function makeTruth(): ScannerTruth {
  return {
    strip: {
      data: { verdict: "Live", detail: "Live, confirmed candles." },
      ruby: { detail: "Eleanor can give a full, live read." },
      trading: { verdict: "Blocked", detail: "Trading is restricted on your account." },
    },
    candles: { lastClose: 33588.01, sourceTechnical: "test", count: 200, minRequired: 150, status: "CONFIRMED" },
    consolidated: {
      rubyReadStatus: "FULL_READ",
      scannerActionability: "WAIT_FOR_CONFIRMATION",
      userMessage: "This read is fresh enough for a live entry.",
      internalReasonCode: "FEED_OK",
    },
    dataHealth: { sourceNote: "Deriv public data." },
    readiness: currentReadiness,
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
vi.mock("@/components/scanner/rubyReadStore", () => ({
  useRubyReadStore: () => ({
    get: (s: string, t: string) => {
      storeKeys.push(`${s}|${t}`);
      return storedRead;
    },
    set: () => {},
  }),
}));

import { ScannerHeaderSummary } from "./ScannerHeaderSummary";

afterEach(() => {
  cleanup();
  currentReadiness = clientLiveConfirmed();
  storedRead = null;
  storeKeys.length = 0;
});

describe("ScannerHeaderSummary — a STRUCTURAL_ONLY Eleanor read caps the header (owner screenshot 2026-10-27)", () => {
  for (const [label, make] of [
    ["fixed server wire", () => serverStructuralRead("STRUCTURAL_ONLY", "HISTORICAL_ONLY")],
    ["pre-fix scrubbed wire", () => serverStructuralRead("", "")],
  ] as const) {
    it(`${label}: Eleanor cell reads "Limited read" with the server's withheld reason`, () => {
      storedRead = make();
      render(<ScannerHeaderSummary running={false} />);
      const cell = screen.getByTestId("scanner-header-ruby");
      expect(cell.textContent).toContain("Limited read");
      expect(cell.textContent).toContain(WITHHELD_REASON);
      expect(cell.textContent).not.toContain("Full read");
      expect(cell.textContent).not.toContain("full, live read");
      expect(storeKeys).toContain("V75|1m");
    });
  }

  it("Trade Health is capped to the server's less-fresh verdict (never 'Live-confirmed' beside a withheld read)", () => {
    storedRead = serverStructuralRead("STRUCTURAL_ONLY", "HISTORICAL_ONLY");
    render(<ScannerHeaderSummary running={false} />);
    const label = screen.getByTestId("scanner-header-readiness-label");
    const trust = screen.getByTestId("scanner-header-readiness-trust");
    expect(label.textContent).toBe("Historical read only");
    expect(label.className).not.toContain("text-success");
    expect(trust.textContent).toBe(
      "Historical/closed-candle M1 structural read — feed not confirmed for live entry.",
    );
    expect(trust.textContent).not.toContain("Live-confirmed");
  });

  it("with no Eleanor read the Trade Health chip is the client's own verdict, unchanged", () => {
    storedRead = null;
    render(<ScannerHeaderSummary running={false} />);
    expect(screen.getByTestId("scanner-header-readiness-label").textContent).toBe(
      currentReadiness.displayLabel,
    );
  });

  it("never upgrades: a fresher server band leaves a weaker client chip alone", () => {
    currentReadiness = evaluateTradeHealthReadiness({
      symbol: "V75",
      timeframe: "1m",
      freshnessVerdict: "LIVE_DELAYED",
      availableClosedCandles: 200,
      minimumRequiredCandles: 150,
      readLayer: "STRUCTURAL_ONLY",
    });
    storedRead = {
      gated: false,
      dataQuality: "ok",
      readLayer: "FULL",
      tradeHealthFreshness: "LIVE_CONFIRMED",
      tradeHealthLabel: "Live-confirmed",
      tradeHealthTrustLine: "Live-confirmed M1 read with enough recent closed candles.",
    } as unknown as ChartRead;
    render(<ScannerHeaderSummary running={false} />);
    const label = screen.getByTestId("scanner-header-readiness-label");
    expect(label.textContent).toBe(currentReadiness.displayLabel);
    expect(label.textContent).not.toBe("Live-confirmed");
  });
});
