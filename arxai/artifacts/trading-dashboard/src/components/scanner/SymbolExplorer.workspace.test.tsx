import { afterEach, describe, expect, it } from "vitest";
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
});
