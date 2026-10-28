import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

type Replay = Record<string, unknown>;
const state: { replays: Replay[] } = { replays: [] };

function replay(outcomeId: number, symbol: string, levels: { entry: number | null; stop: number | null; target: number | null }): Replay {
  return {
    outcomeId, symbol, timeframe: "M15", verdict: "NO_TRADE_MISSED", evidenceNote: "Recorded evidence.",
    whatRubySaw: {
      direction: "BUY", decision: "NO_TRADE", confidence: 60, edge: 1.2, flameStage: null, newsNearby: false,
      plannedEntry: levels.entry, plannedStop: levels.stop, plannedTarget: levels.target,
    },
    howItMoved: { maxFavorableExcursion: 3.5, maxAdverseExcursion: 1.25, elapsedMs: 60000, dataComplete: true },
  };
}

vi.mock("@workspace/api-client-react", () => {
  const idle = { data: undefined, isLoading: false, isError: false };
  return {
    useGetAdminRubyQualityMetrics: () => idle,
    useGetAdminRubyMissedOpportunities: () => ({ data: { replays: state.replays }, isLoading: false, isError: false }),
    useGetAdminRubyThresholds: () => idle,
    useUpdateAdminRubyThresholds: () => ({ mutate: () => undefined, isPending: false }),
    useGetAdminRubyInvestorSummary: () => idle,
  };
});
vi.mock("@tanstack/react-query", async (orig) => ({ ...(await orig<object>()), useQueryClient: () => ({ invalidateQueries: () => undefined }) }));
vi.mock("@/components/admin/AdminDiagnosticsGate", () => ({
  AdminDiagnosticsGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import AdminRubyQualityPage from "./ruby-quality";

beforeEach(() => {
  try { window.localStorage.setItem("arx.pageTab.admin-ruby-quality", "missed"); } catch { /* ignore */ }
});
afterEach(() => { cleanup(); state.replays = []; try { window.localStorage.clear(); } catch { /* ignore */ } });

function kv(outcomeId: number, label: string): string {
  const card = screen.getByTestId(`missed-${outcomeId}`);
  const k = within(card).getByText(label);
  return (k.nextElementSibling as HTMLElement).textContent ?? "";
}

describe("Ruby missed-opportunity replay: planned levels use the instrument's digits", () => {
  it("XAUUSD levels print 2 decimals, not a fixed 5", () => {
    state.replays = [replay(1, "XAUUSD", { entry: 2345.12, stop: 2340.5, target: 2360 })];
    render(<AdminRubyQualityPage />);
    expect(kv(1, "Planned entry")).toBe("2345.12");
    expect(kv(1, "Planned stop")).toBe("2340.50");
    expect(kv(1, "Planned target")).toBe("2360.00");
  });

  it("a JPY pair prints 3 decimals; EURUSD keeps 5; US30 and BTCUSD print 2", () => {
    state.replays = [
      replay(2, "USDJPY", { entry: 151.234, stop: 150.9, target: null }),
      replay(3, "EURUSD", { entry: 1.085, stop: 1.0825, target: 1.09 }),
      replay(4, "US30", { entry: 39000.5, stop: 38900, target: 39200 }),
      replay(5, "BTCUSD", { entry: 67000.25, stop: 66000, target: 69000 }),
    ];
    render(<AdminRubyQualityPage />);
    expect(kv(2, "Planned entry")).toBe("151.234");
    expect(kv(2, "Planned stop")).toBe("150.900");
    expect(kv(2, "Planned target")).toBe("—");
    expect(kv(3, "Planned entry")).toBe("1.08500");
    expect(kv(4, "Planned entry")).toBe("39000.50");
    expect(kv(5, "Planned stop")).toBe("66000.00");
  });

  it("never rounds away digits a level actually carries", () => {
    state.replays = [replay(6, "XAUUSD", { entry: 2345.125, stop: 2340, target: 2360 })];
    render(<AdminRubyQualityPage />);
    expect(kv(6, "Planned entry")).toBe("2345.125");
    expect(kv(6, "Planned stop")).toBe("2340.000");
  });
});
