// Truth fix for the scanner trade modal's stop-loss check: it never passed a
// pip size, so the assessor guessed one from the symbol name (anything starting
// with "V" → 0.1). For "Volatility 75 Index" at 300000 a 0.5 stop was called
// "too close to entry" and moved to an invented 0.8 "broker minimum + spread
// buffer". The pip size, stop level and spread now come from the broker's
// reported symbol spec; without a spec the modal says the distance could not
// be checked and does not show an R:R it cannot vouch for.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

type Spec = Record<string, unknown> | null;
let specResolution: unknown = null;

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: unknown[] }) => {
    if (Array.isArray(opts.queryKey) && opts.queryKey[0] === "mt5-symbol-spec") return { data: specResolution };
    return { data: { ok: true, isOwnerUnrestricted: false, templateName: null } };
  },
}));
vi.mock("@/components/live/MasterLiveAccessGuard", () => ({
  useMasterLiveAccess: () => ({ canTrade: false, loaded: true }),
}));
vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => ({ isLoading: false, isLiveShared: false }) }));
vi.mock("@/hooks/useScannerTruth", () => ({ useScannerTruth: () => ({ truth: null }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));
vi.mock("@/components/live/LiveTradeTicket", () => ({ LiveTradeTicket: () => null }));
vi.mock("@/components/live/LiveSharedTradeTicket", () => ({ LiveSharedTradeTicket: () => null }));
vi.mock("@/components/trading/HistoricalCheckPanel", () => ({ HistoricalCheckPanel: () => null }));
vi.mock("@/components/trading/NewsRiskCheckPanel", () => ({ NewsRiskCheckPanel: () => null }));
vi.mock("./RubySetupReason", () => ({ RubySetupReason: () => null }));

import { ScannerTradeModal } from "./ScannerTradeModal";

const v75Signal = {
  symbol: "Volatility 75 Index", timeframe: "15m", bias: "BUY", recommendedAction: "BUY",
  entry: 300000, stopLoss: 299999.5, takeProfit: 300010, suggestedLot: 0.02, confidenceScore: 70,
} as unknown as Parameters<typeof ScannerTradeModal>[0]["signal"];

function resolved(matched: Spec) {
  return { ok: true, brokerSymbol: "Volatility 75 Index", matched };
}

beforeEach(() => {
  specResolution = null;
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ ok: false }) } as Response)));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function flush() { await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); }); }

function rrText(): string {
  const label = screen.getByText("Risk / Reward", { selector: "span" });
  return label.parentElement?.textContent ?? "";
}

describe("ScannerTradeModal — stop-loss check uses the broker spec", () => {
  // Round 3: a synthetics spec's point is a price step, not a pip — using it
  // as the pip made the 8-pip floor 0.0008 on a 300000 price and let R:R
  // 20.00 vouch for a 0.5 stop. The stop is still not blocked or moved.
  it("with the broker spec (point 0.0001) a 0.5 stop on V75 is not 'too close', is not called checked, and no R:R is vouched for", async () => {
    specResolution = resolved({ digits: 4, point: 0.0001, category: "Synthetics", freshness: "FRESH", stopsLevel: null, spreadPoints: null });
    render(<ScannerTradeModal open onClose={() => {}} signal={v75Signal} defaultSide="BUY" />);
    await flush();
    const body = document.body.textContent ?? "";
    expect(body).not.toContain("too close to entry");
    // The old guessed 0.1 pip (0.8 floor) plus a float miss on the min-safe
    // candidate blocked this stop outright while still showing R:R 20.00.
    expect(body).not.toContain("A valid stop loss is required");
    expect(body).not.toContain("Validation errors");
    expect(body).toContain("distance from entry could not be checked: the broker spec gives Synthetics symbols a 0.0001 price step but no pip size");
    expect(body).toContain("R:R not shown: the broker spec gives Synthetics symbols a 0.0001 price step but no pip size");
    expect(rrText()).not.toContain("20.00");
  });

  it("BTCUSD with a FRESH crypto spec: a 50-cent stop on 65000 gets no positive 'beyond an 8-pip floor' advice and no R:R 1000", async () => {
    specResolution = { ok: true, brokerSymbol: "BTCUSD", matched: { digits: 2, point: 0.01, category: "Crypto", freshness: "FRESH", stopsLevel: null, spreadPoints: 10 } };
    const btcSignal = { ...v75Signal, symbol: "BTCUSD", entry: 65000, stopLoss: 64999.5, takeProfit: 65500 } as typeof v75Signal;
    render(<ScannerTradeModal open onClose={() => {}} signal={btcSignal} defaultSide="BUY" />);
    await flush();
    const body = document.body.textContent ?? "";
    expect(body).not.toMatch(/8-pip floor|pip 0\.01 from the broker spec/);
    expect(body).toContain("distance from entry could not be checked");
    expect(rrText()).not.toMatch(/1000/);
    expect(rrText()).toContain("—");
  });

  it("without a broker spec it says the distance could not be checked, invents no adjustment, and shows no R:R", async () => {
    specResolution = { ok: false, reasonCode: "SYMBOL_NOT_FOUND", requested: "Volatility 75 Index" };
    render(<ScannerTradeModal open onClose={() => {}} signal={v75Signal} defaultSide="BUY" />);
    await flush();
    const body = document.body.textContent ?? "";
    expect(body).not.toContain("too close to entry");
    expect(body).not.toMatch(/broker minimum/i);
    expect(body).not.toContain("A valid stop loss is required");
    expect(body).toContain("distance from entry could not be checked");
    expect(body).toContain("the broker's pip size for Volatility 75 Index is not available");
    expect(rrText()).not.toContain("20.00");
    expect(rrText()).toContain("—");
  });
});
