import { StrictMode } from "react";
import { createPortal } from "react-dom";
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AssistantDockProvider, AssistantDockSlot, useAssistantDockTarget } from "./AssistantDock";
afterEach(cleanup);
function Trigger() {
  const target=useAssistantDockTarget();
  const button=<button data-testid="test-trigger">Assistant</button>;
  return target?createPortal(button,target):button;
}
it("moves one trigger into a late chart host and restores it when that chart unmounts",()=>{
  const App=({chart}:{chart:boolean})=><AssistantDockProvider><Trigger />{chart&&<AssistantDockSlot />}</AssistantDockProvider>;
  const view=render(<StrictMode><App chart={false}/></StrictMode>);
  expect(screen.getAllByTestId('test-trigger')).toHaveLength(1);
  view.rerender(<StrictMode><App chart/></StrictMode>);
  expect(screen.getByTestId('chart-assistant-dock').contains(screen.getByTestId('test-trigger'))).toBe(true);
  view.rerender(<StrictMode><App chart={false}/></StrictMode>);
  expect(screen.queryByTestId('chart-assistant-dock')).toBeNull();
  expect(screen.getAllByTestId('test-trigger')).toHaveLength(1);
});
it("keeps a remaining host when another chart host is removed",()=>{
  const App=({second}:{second:boolean})=><AssistantDockProvider><Trigger/><section data-testid="first"><AssistantDockSlot/></section>{second&&<section data-testid="second"><AssistantDockSlot/></section>}</AssistantDockProvider>;
  const view=render(<App second/>);
  expect(screen.getByTestId('second').contains(screen.getByTestId('test-trigger'))).toBe(true);
  view.rerender(<App second={false}/>);
  expect(screen.getByTestId('first').contains(screen.getByTestId('test-trigger'))).toBe(true);
  expect(screen.getAllByTestId('test-trigger')).toHaveLength(1);
});
it("does not reserve empty chart space outside the app provider",()=>{
  render(<><AssistantDockSlot/><Trigger/></>);
  expect(screen.queryByTestId('chart-assistant-dock')).toBeNull();
  expect(screen.getAllByTestId('test-trigger')).toHaveLength(1);
});
