import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SymbolExplorer } from "./SymbolExplorer";
import { useChartSymbol, getChartSymbol } from "@/lib/use-chart-symbol";

function SharedSymbolHarness() {
  const [symbol, setSymbol] = useChartSymbol();
  return <>
    <output data-testid="scanner-symbol">{symbol}</output>
    <output data-testid="chart-symbol">{symbol}</output>
    <output data-testid="ruby-symbol">{symbol}</output>
    <output data-testid="intelligence-symbol">{symbol}</output>
    <output data-testid="order-symbol">{symbol}</output>
    <SymbolExplorer activeSymbol={symbol} onSelect={canonical => setSymbol(canonical)}/>
  </>;
}

afterEach(() => localStorage.clear());

describe("workspace discovery selection", () => {
  it("uses the existing SymbolExplorer owner and publishes one canonical selection to shared consumers", () => {
    render(<SharedSymbolHarness/>);
    fireEvent.change(screen.getByTestId("input-symbol-search"), { target: { value: "EURUSD" } });
    fireEvent.click(screen.getByTestId("suggestion-EURUSD"));
    expect(getChartSymbol()).toBe("EURUSD");
    for (const consumer of ["scanner-symbol", "chart-symbol", "ruby-symbol", "intelligence-symbol", "order-symbol"]) {
      expect(screen.getByTestId(consumer).textContent).toBe("EURUSD");
    }
  });

  it("shows real selectable market rows immediately in the compact scanner", async () => {
    const onSelect = vi.fn();
    render(<SymbolExplorer compactWorkspace activeSymbol="EURUSD" onSelect={onSelect}/>);
    const forexRows = await screen.findByTestId("category-panel-forex");
    expect(forexRows.querySelector('[data-testid="chip-symbol-EURUSD"]')).toBeTruthy();
    expect(forexRows.querySelector('[data-testid="chip-symbol-GBPUSD"]')).toBeTruthy();
    fireEvent.click(forexRows.querySelector('[data-testid="chip-symbol-GBPUSD"]')!);
    expect(onSelect).toHaveBeenCalledWith("GBPUSD", expect.objectContaining({ canonicalSymbol: "GBPUSD" }));
  });
});
