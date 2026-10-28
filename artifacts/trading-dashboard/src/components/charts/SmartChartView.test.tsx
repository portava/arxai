import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./ARXNativeChart", () => ({
  ARXNativeChart: (props: any) => <output data-testid="native-chart">{props.symbol}:{props.timeframe ?? "default"}:{props.height}</output>,
}));
import { SmartChartSymbolSelect, SmartChartView } from "./SmartChartView";
import { setChartSymbol, useChartSymbol } from "@/lib/use-chart-symbol";

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Sibling() {
  const [symbol] = useChartSymbol();
  return <output data-testid="sibling-symbol">{symbol}</output>;
}

it("keeps the selected synthetic market and broadcasts an explicit picker change to sibling views", () => {
  localStorage.setItem("highroll.chartSymbol", "V75");
  render(<><SmartChartView height={520}/><Sibling/></>);
  expect(screen.getByTestId("native-chart").textContent).toBe("V75:default:520");
  fireEvent.change(screen.getByRole("combobox", {name:"Chart market"}), {target:{value:"XAUUSD"}});
  expect(screen.getByTestId("native-chart").textContent).toBe("XAUUSD:default:520");
  expect(screen.getByTestId("sibling-symbol").textContent).toBe("XAUUSD");
  expect(document.querySelector('script[src*="tradingview"], iframe')).toBeNull();
});

it("follows shared symbol changes without retaining a local stale selection", () => {
  render(<SmartChartView height={620}/>);
  act(() => setChartSymbol("FX:GBPUSD"));
  expect(screen.getByTestId("native-chart").textContent).toBe("GBPUSD:default:620");
  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("GBPUSD");
});

it("preserves an exact approved broker alias without substituting another market", () => {
  render(<SmartChartView symbol="R_75" height={520}/>);
  expect(screen.getByTestId("native-chart").textContent).toBe("R_75:default:520");
  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("R_75");
});

it.each(["UNKNOWN_MARKET", "EUR", ""])("withholds the native data request for explicit unavailable input %j", symbol => {
  localStorage.setItem("highroll.chartSymbol", "V75");
  render(<SmartChartView symbol={symbol} height={620}/>);
  expect(screen.queryByTestId("native-chart")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("No substitute market");
  expect(localStorage.getItem("highroll.chartSymbol")).toBe("V75");
});

it("keeps controlled selection with its owner and uses distinct accessible selectors", () => {
  const choose = vi.fn();
  const view = render(<><SmartChartView symbol="FX:EURUSD" onSymbolChange={choose} height={620}/>
    <SmartChartSymbolSelect symbol="V75" onSymbolChange={vi.fn()} label="Comparison market"/></>);
  const selector = screen.getByRole("combobox", {name:"Chart market"});
  expect(selector.id).not.toBe(screen.getByRole("combobox", {name:"Comparison market"}).id);
  fireEvent.change(selector, {target:{value:"GBPUSD"}});
  expect(choose).toHaveBeenCalledExactlyOnceWith("GBPUSD");
  expect(screen.getByTestId("native-chart").textContent).toBe("EURUSD:default:620");
  view.rerender(<SmartChartView symbol="GBPUSD" onSymbolChange={choose} timeframe="H4" height={620}/>);
  expect(screen.getByTestId("native-chart").textContent).toBe("GBPUSD:H4:620");
});
