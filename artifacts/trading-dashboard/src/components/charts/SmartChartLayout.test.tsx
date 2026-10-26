import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("./ARXNativeChart",()=>({ARXNativeChart:(props:any)=><button data-testid="secondary" onClick={()=>props.onTimeframeChange("H4")}>{props.symbol}:{props.timeframe}:{String(!!props.onChartContextChange)}</button>}));
import { SmartChartLayout } from "./SmartChartLayout";
beforeEach(()=>localStorage.clear());afterEach(cleanup);
it("keeps the primary mounted while adding an independent read-only comparison and remembers layout",()=>{
  const view=render(<SmartChartLayout symbol="EURUSD"><input aria-label="Primary state" defaultValue="kept"/></SmartChartLayout>);
  const primary=screen.getByLabelText("Primary state");fireEvent.click(screen.getByRole("button",{name:"Two charts"}));
  expect(screen.getByLabelText("Primary state")).toBe(primary);expect(screen.getByTestId("secondary").textContent).toBe("EURUSD:H1:false");
  fireEvent.click(screen.getByTestId("secondary"));expect(screen.getByTestId("secondary").textContent).toBe("EURUSD:H4:false");
  view.rerender(<SmartChartLayout symbol="XAUUSD"><input aria-label="Primary state" defaultValue="kept"/></SmartChartLayout>);
  expect(screen.getByTestId("secondary").textContent).toBe("XAUUSD:H4:false");view.unmount();
  render(<SmartChartLayout symbol="EURUSD"><div>Primary</div></SmartChartLayout>);expect(screen.getByTestId("secondary").textContent).toBe("EURUSD:H4:false");
});
