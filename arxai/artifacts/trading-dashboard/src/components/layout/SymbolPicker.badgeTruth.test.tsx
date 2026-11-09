import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import type { ResolvedSymbol, ResolvedSymbolsResponse } from "@/lib/useMt5Symbols";

/**
 * Truth guard: the symbol-picker badge describes the MT5 symbol-SPEC
 * enumeration, not a live price feed. One spec enumerated inside the 5-minute
 * FRESH window must not turn every enumerated symbol into "N live".
 */

function row(i: number, freshness: ResolvedSymbol["freshness"]): ResolvedSymbol {
  return {
    symbol: `SYM${i}`,
    displayName: `SYM${i}`,
    brokerSymbol: `SYM${i}.m`,
    market: "forex",
    category: "Forex",
    source: "enumerated",
    tradeable: true,
    scannerEnabled: true,
    candlesEnabled: true,
    executionRequiresBrokerConfirmation: true,
    freshness,
  };
}

let response: ResolvedSymbolsResponse;

vi.mock("@/lib/useMt5Symbols", () => ({
  useResolvedSymbols: () => ({ data: response, isLoading: false }),
}));
vi.mock("@/lib/symbol-context", () => ({
  useActiveSymbol: () => ({ setActive: () => {}, recent: [] }),
}));
vi.mock("@/lib/use-chart-symbol", () => ({
  useChartSymbol: () => ["EURUSD"],
  setChartSymbol: () => {},
  bareSymbol: (s: string) => s,
}));

beforeAll(() => {
  // cmdk / radix need these in jsdom.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

function build(symbols: ResolvedSymbol[]): ResolvedSymbolsResponse {
  return {
    ok: true,
    symbols,
    sourceSummary: { sharedBridge: 0, enumerated: symbols.length, defaults: 0 },
    warnings: [],
    enumerationStatus: { available: true, count: symbols.length, lastEnumeratedAt: new Date().toISOString() },
  };
}

async function openBadge(): Promise<HTMLElement> {
  const { SymbolPicker } = await import("./SymbolPicker");
  render(<SymbolPicker />);
  fireEvent.click(screen.getByTestId("button-symbol-picker"));
  return screen.findByTestId("symbol-picker-freshness");
}

describe("SymbolPicker broker-sync badge", () => {
  it("does not call 120 enumerated symbols 'live' when only one spec is fresh", async () => {
    response = build([row(0, "FRESH"), ...Array.from({ length: 119 }, (_, i) => row(i + 1, "STALE"))]);
    const badge = await openBadge();
    expect(badge.textContent).not.toMatch(/live/i);
    expect(badge.textContent).not.toBe("120 live");
    expect(badge.textContent).toContain("1/120");
    expect(badge.getAttribute("title") ?? "").toMatch(/not a live price feed/i);
    // One fresh row among 119 stale rows is not a green/confirmed state.
    expect(badge.className).toContain("amber");
  });

  it("only goes green when every enumerated spec is fresh, and still never says 'live'", async () => {
    response = build([row(0, "FRESH"), row(1, "FRESH")]);
    const badge = await openBadge();
    expect(badge.textContent).toBe("2 specs synced");
    expect(badge.className).toContain("emerald");
  });
});
