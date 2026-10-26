import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChartWorkbenchTools } from "./ChartWorkbenchTools";
import type { ChartAnchor } from "@/lib/chart-engine/chartWorkspace";
import { DEFAULT_PREFERENCES, drawingStorageKey } from "@/lib/chart-engine/chartWorkspace";
import type { ChartEngineAdapter } from "@/lib/chart-engine";
let click: ((anchor:ChartAnchor)=>void) | null;
const drawings=vi.fn();
const adapter={setDrawings:drawings,setDrawingHandler:(handler:typeof click)=>{click=handler;}} as unknown as ChartEngineAdapter;
const mount=(symbol="EURUSD",timeframe="M15",engine=adapter)=>render(<ChartWorkbenchTools key={`${symbol}:${timeframe}`} adapter={engine} epoch={1} symbol={symbol} timeframe={timeframe} preferences={DEFAULT_PREFERENCES} onPreferences={vi.fn()} hasCandles feedLabel="Offline fixture"/>);
beforeEach(()=>{localStorage.clear();vi.clearAllMocks();click=null;});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
describe("drawing workspace controls",()=>{
  it("creates, edits, undoes, redoes and reloads a drawing without trade calls",()=>{
    const view=mount();fireEvent.change(screen.getByLabelText("Drawing tool"),{target:{value:"horizontal"}});
    act(()=>click?.({time:100,price:1.2}));
    fireEvent.click(screen.getByRole("button",{name:"Objects (1)"}));
    fireEvent.blur(screen.getByLabelText("Drawing 1 start price"),{target:{value:"1.3"}});
    expect(JSON.parse(localStorage.getItem(drawingStorageKey("EURUSD","M15"))!)[0].start.price).toBe(1.3);
    fireEvent.click(screen.getByRole("button",{name:"Undo"}));expect(drawings.mock.calls.at(-1)![0][0].start.price).toBe(1.2);
    fireEvent.click(screen.getByRole("button",{name:"Redo"}));expect(drawings.mock.calls.at(-1)![0][0].start.price).toBe(1.3);
    view.unmount();mount();expect(drawings.mock.calls.at(-1)![0][0].start.price).toBe(1.3);
  });
  it("synchronizes matching chart drawings and clears obsolete undo history",()=>{
    const first=mount(), second=mount("EURUSD","M15",{...adapter,setDrawingHandler:vi.fn()} as ChartEngineAdapter);
    fireEvent.change(within(first.container).getByLabelText("Drawing tool"),{target:{value:"horizontal"}});
    act(()=>click?.({time:100,price:1.2}));
    expect(within(first.container).getByRole("button",{name:"Objects (1)"})).toBeTruthy();
    expect(within(second.container).getByRole("button",{name:"Objects (1)"})).toBeTruthy();
    expect(within(second.container).getByRole("button",{name:"Undo"}).hasAttribute("disabled")).toBe(true);
  });
  it("requires two distinct candle anchors and cancels unfinished drawings",()=>{
    mount();fireEvent.change(screen.getByLabelText("Drawing tool"),{target:{value:"trend"}});
    act(()=>click?.({time:100,price:1.2}));act(()=>click?.({time:100,price:1.3}));
    expect(screen.getByText("Choose a different candle for the second anchor.")).toBeTruthy();
    fireEvent.keyDown(window,{key:"Escape"});expect(click).toBeNull();
    expect(localStorage.getItem(drawingStorageKey("EURUSD","M15"))).toBeNull();
    fireEvent.change(screen.getByLabelText("Drawing tool"),{target:{value:"fibonacci"}});
    act(()=>click?.({time:200,price:1.2}));act(()=>click?.({time:100,price:1.3}));
    expect(drawings.mock.calls.at(-1)![0][0].kind).toBe("fibonacci");
  });
  it("isolates symbols/timeframes and warns on storage failure without losing in-memory drawing",()=>{
    const view=mount();fireEvent.change(screen.getByLabelText("Drawing tool"),{target:{value:"horizontal"}});act(()=>click?.({time:100,price:1.2}));view.unmount();
    const next=mount("XAUUSD");expect(drawings.mock.calls.at(-1)![0]).toEqual([]);next.unmount();
    mount("EURUSD","H1");expect(drawings.mock.calls.at(-1)![0]).toEqual([]);
    vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw Error("quota");});
    fireEvent.change(screen.getByLabelText("Drawing tool"),{target:{value:"horizontal"}});act(()=>click?.({time:100,price:1.2}));
    expect(drawings.mock.calls.at(-1)![0]).toHaveLength(1);expect(screen.getByRole("alert").textContent).toContain("lost");
  });
});
