import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef, useState, useLayoutEffect, Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChartWorkbenchTools, exportLabels } from "./ChartWorkbenchTools";
import type { ChartAnchor, ChartPreferences } from "@/lib/chart-engine/chartWorkspace";
import { CHART_STYLES, DEFAULT_PREFERENCES, drawingStorageKey, TEMPLATE_KEY } from "@/lib/chart-engine/chartWorkspace";
import { STUDY_DEFAULTS, studyLabel } from "@/lib/chart-engine/chartStudies";
import { __resetBrowserZoneCacheForTests } from "@/lib/chart-engine/chartTimeZone";
import type { ChartEngineAdapter } from "@/lib/chart-engine";
let click: ((anchor:ChartAnchor)=>void) | null;
const drawings=vi.fn();
const adapter={setDrawings:drawings,setDrawingHandler:(handler:typeof click)=>{click=handler;}} as unknown as ChartEngineAdapter;
const mount=(symbol="EURUSD",timeframe="M15",engine=adapter)=>render(<ChartWorkbenchTools utcClockQualified key={`${symbol}:${timeframe}`} adapter={engine} epoch={1} symbol={symbol} timeframe={timeframe} preferences={DEFAULT_PREFERENCES} onPreferences={vi.fn()} hasCandles feedLabel="Offline fixture"/>);
beforeEach(()=>{localStorage.clear();vi.clearAllMocks();click=null;});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();__resetBrowserZoneCacheForTests();});
describe("object navigation",()=>{
  const seed=()=>{
    const rows=[{id:"level",kind:"horizontal",start:{time:100,price:1.2},color:"#ffffff"},
      {id:"note",kind:"text",start:{time:200,price:1.3},color:"#ffffff",text:"Target note",locked:true}];
    localStorage.setItem(drawingStorageKey("EURUSD","M15"),JSON.stringify(rows));
    return rows;
  };
  it("jumps to a filtered object's start without editing it or adding undo history",()=>{
    const rows=seed(), goToTime=vi.fn(()=>true), fetch=vi.fn();vi.stubGlobal("fetch",fetch);
    mount("EURUSD","M15",{...adapter,goToTime} as unknown as ChartEngineAdapter);
    fireEvent.click(screen.getByRole("button",{name:"Objects (2)",exact:true}));
    fireEvent.change(screen.getByLabelText("Find drawing"),{target:{value:"Target note"}});
    fireEvent.click(screen.getByRole("button",{name:"Go to drawing 2 start",exact:true}));
    expect(goToTime).toHaveBeenCalledExactlyOnceWith(200);
    expect(screen.getByRole("button",{name:"Select drawing 2"}).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/Centered on the first loaded candle at or after drawing 2/)).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(drawingStorageKey("EURUSD","M15"))!)).toEqual(rows);
    expect(screen.getByRole("button",{name:"Undo",exact:true}).hasAttribute("disabled")).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("closes Objects and returns focus to this chart only after successful navigation",()=>{
    seed();const chartTarget=createRef<HTMLDivElement>(), scroll=vi.fn(), goToTime=vi.fn(()=>false);
    const engine={...adapter,goToTime} as unknown as ChartEngineAdapter;
    render(<><ChartWorkbenchTools utcClockQualified chartTarget={chartTarget} adapter={engine} epoch={1} symbol="EURUSD" timeframe="M15" preferences={DEFAULT_PREFERENCES} onPreferences={vi.fn()} hasCandles feedLabel="Offline"/><div ref={chartTarget} tabIndex={0}/></>);
    chartTarget.current!.scrollIntoView=scroll;
    fireEvent.click(screen.getByRole("button",{name:"Objects (2)",exact:true}));
    fireEvent.click(screen.getByRole("button",{name:"Go to drawing 1 start"}));
    expect(scroll).not.toHaveBeenCalled();
    expect(screen.getByRole("button",{name:"Go to drawing 1 start"})).toBeTruthy();
    goToTime.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button",{name:"Go to drawing 1 start"}));
    expect(scroll).toHaveBeenCalledExactlyOnceWith({block:"nearest",behavior:"instant"});
    expect(document.activeElement).toBe(chartTarget.current);
    expect(screen.queryByRole("button",{name:"Go to drawing 1 start"})).toBeNull();
    expect(screen.getByRole("button",{name:"Objects (2)",exact:true}).getAttribute("aria-expanded")).toBe("false");
  });
  it("reports an unloaded anchor without claiming that the drawing is shown",()=>{
    seed();const goToTime=vi.fn(()=>false);
    mount("EURUSD","M15",{...adapter,goToTime} as unknown as ChartEngineAdapter);
    fireEvent.click(screen.getByRole("button",{name:"Objects (2)",exact:true}));
    fireEvent.click(screen.getByRole("button",{name:"Go to drawing 1 start",exact:true}));
    expect(screen.getByText(/Drawing 1 starts outside loaded history/)).toBeTruthy();
    expect(screen.getByRole("button",{name:"Select drawing 1"}).getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByText(/Centered on/)).toBeNull();
  });
  it("preserves individual and global hiding when navigating to their candle",()=>{
    const rows=seed();localStorage.setItem(drawingStorageKey("EURUSD","M15"),JSON.stringify([{...rows[0],hidden:true},rows[1]]));
    const goToTime=vi.fn(()=>true);mount("EURUSD","M15",{...adapter,goToTime} as unknown as ChartEngineAdapter);
    fireEvent.click(screen.getByRole("button",{name:"Objects (2)",exact:true}));
    fireEvent.click(screen.getByRole("button",{name:"Go to drawing 1 start",exact:true}));
    expect(screen.getByText(/Drawing remains hidden/)).toBeTruthy();
    expect(screen.getByRole("button",{name:"Show drawing 1"})).toBeTruthy();
    expect(screen.getByRole("button",{name:"Select drawing 1"}).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button",{name:"Hide drawings",exact:true}));
    fireEvent.click(screen.getByRole("button",{name:"Go to drawing 2 start",exact:true}));
    expect(screen.getByText(/Drawing remains hidden/)).toBeTruthy();
    expect(screen.getByRole("button",{name:"Show drawings",exact:true})).toBeTruthy();
    expect(drawings.mock.calls.at(-1)![0]).toEqual([]);
  });
  it("disables navigation while candles or its engine are unavailable",()=>{
    seed();const view=render(<ChartWorkbenchTools utcClockQualified adapter={null} epoch={1} symbol="EURUSD" timeframe="M15" preferences={DEFAULT_PREFERENCES} onPreferences={vi.fn()} hasCandles={false} feedLabel="Unavailable"/>);
    fireEvent.click(screen.getByRole("button",{name:"Objects (2)",exact:true}));
    expect(screen.getByRole("button",{name:"Go to drawing 1 start"}).hasAttribute("disabled")).toBe(true);
    view.unmount();mount();fireEvent.click(screen.getByRole("button",{name:"Objects (2)",exact:true}));
    expect(screen.getByRole("button",{name:"Go to drawing 1 start"}).hasAttribute("disabled")).toBe(true);
  });
  it("keeps replay navigation inside the revealed window without requesting history",()=>{
    seed();const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
    const engine={...adapter,goToTime:vi.fn(()=>false)} as unknown as ChartEngineAdapter;
    render(<ChartWorkbenchTools utcClockQualified adapter={engine} epoch={1} symbol="EURUSD" timeframe="M15" preferences={DEFAULT_PREFERENCES} onPreferences={vi.fn()} hasCandles historyWindowOnly feedLabel="Replay"/>);
    fireEvent.click(screen.getByRole("button",{name:"Objects (2)",exact:true}));
    fireEvent.click(screen.getByRole("button",{name:"Go to drawing 1 start"}));
    expect(screen.getByText(/Drawing 1 starts outside the revealed replay window/)).toBeTruthy();
    expect(screen.queryByText(/Load its candles/)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
it("saves channel extensions and midpoint with undo, lock protection and reload",()=>{
 const key=drawingStorageKey("EURUSD","M15");
 const channel={id:"test-channel",kind:"channel",start:{time:100,price:10},end:{time:200,price:20},offset:{time:150,price:30},color:"#ffffff"};
 localStorage.setItem(key,JSON.stringify([channel]));const view=mount();
 fireEvent.click(screen.getByRole("button",{name:"Objects (1)",exact:true}));
 fireEvent.click(screen.getByLabelText("Drawing 1 extend right"));
 expect(JSON.parse(localStorage.getItem(key)!)[0]).toEqual({...channel,extendRight:true});
 fireEvent.click(screen.getByLabelText("Drawing 1 middle line"));
 expect(JSON.parse(localStorage.getItem(key)!)[0].middleLine).toBe(true);
 fireEvent.click(screen.getByRole("button",{name:"Undo",exact:true}));
 expect(JSON.parse(localStorage.getItem(key)!)[0].middleLine).not.toBe(true);
 fireEvent.click(screen.getByLabelText("Drawing 1 extend left"));
 fireEvent.click(screen.getByLabelText("Lock drawing 1"));
 for(const field of ["extend left","extend right","middle line"])expect((screen.getByLabelText(`Drawing 1 ${field}`) as HTMLInputElement).disabled).toBe(true);
 view.unmount();mount();fireEvent.click(screen.getByRole("button",{name:"Objects (1)",exact:true}));
 expect((screen.getByLabelText("Drawing 1 extend left") as HTMLInputElement).checked).toBe(true);
 expect((screen.getByLabelText("Drawing 1 extend right") as HTMLInputElement).checked).toBe(true);
 expect((screen.getByLabelText("Drawing 1 middle line") as HTMLInputElement).checked).toBe(false);
});
describe("manual text note controls",()=>{
  const createNote=(text="My own observation")=>{
    fireEvent.change(screen.getByLabelText("Drawing tool"),{target:{value:"text"}});
    expect(click).toBeNull();
    fireEvent.change(screen.getByLabelText("New user note"),{target:{value:text}});
    act(()=>click?.({time:100,price:1.2}));
  };
  it("creates literal text at the chosen candle, edits once with undo/redo and reloads without API calls",()=>{
    const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
    const view=mount();createNote("<b>My note</b>\nSecond line");
    const stored=()=>JSON.parse(localStorage.getItem(drawingStorageKey("EURUSD","M15"))!);
    expect(stored()[0]).toMatchObject({kind:"text",text:"<b>My note</b>\nSecond line",start:{time:100,price:1.2}});
    expect(screen.getByText(/This is your annotation, not an automated reading/)).toBeTruthy();
    expect(view.container.querySelector("b")).toBeNull();
    expect(screen.queryByLabelText("Drawing 1 line width")).toBeNull();
    fireEvent.change(screen.getByLabelText("Drawing 1 note text"),{target:{value:"Edited note"}});
    expect(stored()[0].text).toBe("<b>My note</b>\nSecond line");
    fireEvent.click(screen.getByRole("button",{name:"Save note",exact:true}));
    expect(stored()[0].text).toBe("Edited note");
    fireEvent.click(screen.getByRole("button",{name:"Undo",exact:true}));
    expect(stored()[0].text).toBe("<b>My note</b>\nSecond line");
    expect((screen.getByLabelText("Drawing 1 note text") as HTMLTextAreaElement).value).toBe("<b>My note</b>\nSecond line");
    fireEvent.click(screen.getByRole("button",{name:"Redo",exact:true}));
    expect(stored()[0].text).toBe("Edited note");
    view.unmount();mount();
    expect(drawings.mock.calls.at(-1)![0][0].text).toBe("Edited note");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses empty or invalid text without discarding a saved note or adding undo history",()=>{
    mount();
    fireEvent.change(screen.getByLabelText("Drawing tool"),{target:{value:"text"}});
    fireEvent.change(screen.getByLabelText("New user note"),{target:{value:" \u202E "}});
    expect(click).toBeNull();
    expect(localStorage.getItem(drawingStorageKey("EURUSD","M15"))).toBeNull();
    fireEvent.change(screen.getByLabelText("New user note"),{target:{value:"Valid note"}});
    act(()=>click?.({time:100,price:1.2}));
    fireEvent.change(screen.getByLabelText("Drawing 1 note text"),{target:{value:""}});
    expect(screen.getByRole("button",{name:"Save note",exact:true}).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("visible plain text");
    expect(JSON.parse(localStorage.getItem(drawingStorageKey("EURUSD","M15"))!)[0].text).toBe("Valid note");
    fireEvent.click(screen.getByRole("button",{name:"Undo",exact:true}));
    expect(drawings.mock.calls.at(-1)![0]).toEqual([]);
  });
  it("uses existing selection, lock, hide, delete and undo without sharing notes across chart contexts",()=>{
    const engine={...adapter,setDrawingInteraction:vi.fn()} as unknown as ChartEngineAdapter;
    const view=mount("EURUSD","M15",engine);createNote();
    expect(screen.getByRole("button",{name:"Select drawing 1"}).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button",{name:"Lock drawing 1"}));
    expect(screen.getByLabelText("Drawing 1 note text").hasAttribute("disabled")).toBe(true);
    expect(screen.getByLabelText("Drawing 1 start price").hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button",{name:"Hide drawings",exact:true}));
    expect(drawings.mock.calls.at(-1)![0]).toEqual([]);
    expect(engine.setDrawingInteraction).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByRole("button",{name:"Show drawings",exact:true}));
    expect(drawings.mock.calls.at(-1)![0][0]).toMatchObject({kind:"text",locked:true});
    fireEvent.click(screen.getByRole("button",{name:"Delete drawing 1"}));
    expect(drawings.mock.calls.at(-1)![0]).toEqual([]);
    fireEvent.click(screen.getByRole("button",{name:"Undo",exact:true}));
    expect(drawings.mock.calls.at(-1)![0][0].text).toBe("My own observation");
    view.unmount();const other=mount("GBPUSD","M15");expect(drawings.mock.calls.at(-1)![0]).toEqual([]);
    other.unmount();mount("EURUSD","H1");expect(drawings.mock.calls.at(-1)![0]).toEqual([]);
  });
});
describe("drawing workspace controls",()=>{
  it("keeps style selection and its evidence note outside collapsed advanced tools",()=>{
    function View(){const [preferences,onPreferences]=useState(DEFAULT_PREFERENCES);return <ChartWorkbenchTools utcClockQualified adapter={adapter} epoch={1} symbol="EURUSD" timeframe="M15" preferences={preferences} onPreferences={onPreferences} hasCandles feedLabel="Offline fixture"/>;}
    render(<View/>);
    const advanced=screen.getByTestId("chart-advanced-tools"),select=screen.getByLabelText("Chart style");
    expect(advanced.contains(select)).toBe(false);
    expect(screen.getByRole("button",{name:"Chart tools",exact:true}).getAttribute("aria-expanded")).toBe("false");
    fireEvent.change(select,{target:{value:"heikinAshi"}});
    expect((select as HTMLSelectElement).value).toBe("heikinAshi");
    const note=screen.getByTestId("chart-style-note");
    expect(advanced.contains(note)).toBe(false);
    expect(note.textContent).toContain("Analysis uses original candles");
  });

  it("keeps an in-progress drawing visible and cancellable when tools close",()=>{
    mount();
    const toggle=screen.getByRole("button",{name:"Chart tools",exact:true});
    const advanced=screen.getByTestId("chart-advanced-tools");
    expect(toggle.getAttribute("aria-controls")).toBe(advanced.id);
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText("Drawing tool"),{target:{value:"trend"}});
    act(()=>click?.({time:100,price:1.2}));
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("chart-advanced-tools")).toBe(advanced);
    const cancel=screen.getByRole("button",{name:"Cancel drawing",exact:true});
    expect(advanced.contains(cancel)).toBe(false);
    expect(screen.getByText(/choose the second candle and price/)).toBeTruthy();
    fireEvent.click(cancel);
    expect(click).toBeNull();
    expect(localStorage.getItem(drawingStorageKey("EURUSD","M15"))).toBeNull();
  });
  it("preserves exact-price edits and undo history across tools disclosure",()=>{
    mount();
    const toggle=screen.getByRole("button",{name:"Chart tools",exact:true});
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText("Drawing tool"),{target:{value:"horizontal"}});
    act(()=>click?.({time:100,price:1.2}));
    fireEvent.click(screen.getByRole("button",{name:"Objects (1)"}));
    const field=screen.getByLabelText("Drawing 1 start price");
    fireEvent.blur(field,{target:{value:"1.3"}});
    fireEvent.click(toggle);fireEvent.click(toggle);
    expect(JSON.parse(localStorage.getItem(drawingStorageKey("EURUSD","M15"))!)[0].start.price).toBe(1.3);
    fireEvent.click(screen.getByRole("button",{name:"Undo",exact:true}));
    expect(JSON.parse(localStorage.getItem(drawingStorageKey("EURUSD","M15"))!)[0].start.price).toBe(1.2);
  });
  it("explains transformed styles beside the controls and associates each view with its own explanation",()=>{
    function View(){const [preferences,onPreferences]=useState(DEFAULT_PREFERENCES);return <ChartWorkbenchTools utcClockQualified adapter={adapter} epoch={1} symbol="EURUSD" timeframe="M15" preferences={preferences} onPreferences={onPreferences} hasCandles feedLabel="Offline fixture"/>;}
    const first=render(<View/>), second=render(<View/>);
    const a=within(first.container), b=within(second.container);
    expect(a.queryByTestId("chart-style-note")).toBeNull();
    fireEvent.change(a.getByLabelText("Chart style"),{target:{value:"heikinAshi"}});
    fireEvent.change(b.getByLabelText("Chart style"),{target:{value:"baseline"}});
    const ha=a.getByTestId("chart-style-note"), base=b.getByTestId("chart-style-note");
    expect(ha.closest("details")).toBeNull();
    expect(ha.textContent).toContain("averaged candles");
    expect(ha.textContent).toContain("Analysis uses original candles");
    expect(ha.textContent).toContain("original price scale");
    expect(base.textContent).toContain("Loading older history can change this reference");
    expect(ha.id).not.toBe(base.id);
    expect(a.getByLabelText("Chart style").getAttribute("aria-describedby")).toBe(ha.id);
    expect(b.getByLabelText("Chart style").getAttribute("aria-describedby")).toBe(base.id);
    fireEvent.change(a.getByLabelText("Chart style"),{target:{value:"hollow"}});
    expect(a.getByTestId("chart-style-note").textContent).toContain("previous close");
    expect(a.getByTestId("chart-style-note").textContent).toContain("own open for the first loaded candle");
    fireEvent.change(a.getByLabelText("Chart style"),{target:{value:"candles"}});
    expect(a.queryByTestId("chart-style-note")).toBeNull();
    expect(a.getByLabelText("Chart style").hasAttribute("aria-describedby")).toBe(false);
  });
  it("offers explicit pan and zoom and restores drawing placement when a tool is selected",()=>{
    const engine={...adapter,setNavigationMode:vi.fn(),panBy:vi.fn(),zoomBy:vi.fn()} as unknown as ChartEngineAdapter;
    mount("EURUSD","M15",engine);
    fireEvent.change(screen.getByLabelText("Drawing tool"),{target:{value:"trend"}});
    act(()=>click?.({time:100,price:1.2}));
    fireEvent.click(screen.getByRole("button",{name:"Pan",exact:true}));
    expect(click).toBeNull();
    expect(engine.setNavigationMode).toHaveBeenLastCalledWith("pan");
    expect(screen.getByRole("button",{name:"Pan",exact:true}).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByLabelText("Pan to earlier candles"));
    fireEvent.click(screen.getByLabelText("Pan to later candles"));
    expect(engine.panBy).toHaveBeenNthCalledWith(1,-0.25);
    expect(engine.panBy).toHaveBeenNthCalledWith(2,0.25);
    fireEvent.click(screen.getByLabelText("Zoom in chart"));
    fireEvent.click(screen.getByLabelText("Zoom out chart"));
    expect(engine.zoomBy).toHaveBeenNthCalledWith(1,0.75);
    expect(engine.zoomBy).toHaveBeenNthCalledWith(2,4/3);
    fireEvent.change(screen.getByLabelText("Drawing tool"),{target:{value:"horizontal"}});
    expect(engine.setNavigationMode).toHaveBeenLastCalledWith("inspect");
    act(()=>click?.({time:200,price:1.3}));
    expect(drawings.mock.calls.at(-1)![0]).toHaveLength(1);
    expect(drawings.mock.calls.at(-1)![0][0].start).toEqual({time:200,price:1.3});
  });
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

describe("display time zone controls",()=>{
  let latest:ChartPreferences;
  function Harness({initial,timeframe="M15",engine}:{initial:ChartPreferences;timeframe?:string;engine:ChartEngineAdapter}) {
    const [preferences,setPreferences]=useState(initial);latest=preferences;
    return <ChartWorkbenchTools utcClockQualified adapter={engine} epoch={1} symbol="EURUSD" timeframe={timeframe} preferences={preferences} onPreferences={setPreferences} hasCandles feedLabel="Offline fixture"/>;
  }
  const goToEngine=(goToTime=vi.fn(()=>true))=>({...adapter,goToTime} as unknown as ChartEngineAdapter & {goToTime:typeof goToTime});
  const show=(initial:Partial<ChartPreferences>={},timeframe="M15",engine=goToEngine())=>{render(<Harness initial={{...DEFAULT_PREFERENCES,...initial}} timeframe={timeframe} engine={engine}/>);return engine;};
  const goTo=(label:string,value:string)=>{fireEvent.change(screen.getByLabelText(`Go to ${label} date and time`),{target:{value}});fireEvent.click(screen.getByRole("button",{name:`Go to ${label}`,exact:true}));};
  const chooseZone=(value:string)=>fireEvent.change(screen.getByLabelText("Display time zone"),{target:{value}});
  it("(a) keeps today's UTC go-to labels, message and UTC second by default",()=>{
    const engine=show();
    expect((screen.getByLabelText("Display time zone") as HTMLSelectElement).value).toBe("UTC");
    goTo("UTC","2020-01-01T00:00");
    expect(engine.goToTime).toHaveBeenCalledExactlyOnceWith(1577836800);
    expect(screen.getByText("Centered on the first loaded candle at or after that UTC time.")).toBeTruthy();
    expect(screen.queryByTestId("chart-daily-zone-note")).toBeNull();
  });
  it("(b) maps a Tokyo wall clock to the same UTC second and labels the control",()=>{
    const engine=show({timeZone:"Asia/Tokyo"});
    goTo("Asia/Tokyo","2020-01-01T09:00");
    expect(engine.goToTime).toHaveBeenCalledExactlyOnceWith(1577836800);
    expect(screen.getByText("Centered on the first loaded candle at or after that Asia/Tokyo time.")).toBeTruthy();
  });
  it("(c) rejects a clock-change gap without navigating and flags a repeated time",()=>{
    const engine=show({timeZone:"America/New_York"});
    goTo("America/New_York","2026-03-08T02:30");
    expect(engine.goToTime).not.toHaveBeenCalled();
    expect(screen.getByText("That time does not exist in America/New_York (clock change). Choose another time.")).toBeTruthy();
    goTo("America/New_York","2026-11-01T01:30");
    expect(engine.goToTime).toHaveBeenCalledExactlyOnceWith(Date.UTC(2026,10,1,5,30)/1000);
    expect(screen.getByText("Centered on the first loaded candle at or after that America/New_York time. Repeated clock-change time: the earlier occurrence was used.")).toBeTruthy();
  });
  it("(d) stores the selected zone and removes the key for UTC",()=>{
    show();
    chooseZone("Asia/Tokyo");expect(latest.timeZone).toBe("Asia/Tokyo");
    expect(screen.getByLabelText("Go to Asia/Tokyo date and time")).toBeTruthy();
    chooseZone("UTC");expect(Object.hasOwn(latest,"timeZone")).toBe(false);
    expect(latest).toEqual(DEFAULT_PREFERENCES);
  });
  it("(e) lists drawing anchor times in the selected zone",()=>{
    localStorage.setItem(drawingStorageKey("EURUSD","M15"),JSON.stringify([{id:"one",kind:"horizontal",start:{time:Date.UTC(2026,9,28,5,46)/1000,price:1.2},color:"#ffffff"}]));
    show({timeZone:"Asia/Tokyo"});
    fireEvent.click(screen.getByRole("button",{name:"Objects (1)"}));
    expect(screen.getByText("2026-10-28 14:46 GMT+9")).toBeTruthy();
    chooseZone("UTC");
    expect(screen.getByText("2026-10-28 05:46 UTC")).toBeTruthy();
  });
  it("(g) applies the legacy template without changing the current display zone",()=>{
    localStorage.setItem(TEMPLATE_KEY,JSON.stringify({style:"line",scale:"log",studies:[],timeZone:"Asia/Tokyo"}));
    show({timeZone:"America/New_York"});
    fireEvent.click(screen.getByRole("button",{name:"Templates",exact:true}));
    fireEvent.change(screen.getByRole("listbox"),{target:{value:"legacy"}});
    fireEvent.click(screen.getByRole("button",{name:"Apply selected"}));
    expect(latest.style).toBe("line");expect(latest.timeZone).toBe("America/New_York");
  });
  it("(h) converts a typed go-to value on a zone switch and clears one that cannot convert",()=>{
    show({timeZone:"Asia/Tokyo"});
    fireEvent.change(screen.getByLabelText("Go to Asia/Tokyo date and time"),{target:{value:"2020-01-01T09:00"}});
    chooseZone("UTC");
    expect((screen.getByLabelText("Go to UTC date and time") as HTMLInputElement).value).toBe("2020-01-01T00:00");
    chooseZone("America/New_York");
    expect((screen.getByLabelText("Go to America/New_York date and time") as HTMLInputElement).value).toBe("2019-12-31T19:00");
    fireEvent.change(screen.getByLabelText("Go to America/New_York date and time"),{target:{value:"2026-03-08T02:30"}});
    chooseZone("UTC");
    expect((screen.getByLabelText("Go to UTC date and time") as HTMLInputElement).value).toBe("");
  });
  it("(i) names the resolved browser zone, or UTC when it falls back",()=>{
    __resetBrowserZoneCacheForTests();
    const spy=vi.spyOn(Intl.DateTimeFormat.prototype,"resolvedOptions").mockReturnValue({timeZone:"Europe/Paris"} as Intl.ResolvedDateTimeFormatOptions);
    const engine=show({timeZone:"local"});
    expect(screen.getByRole("option",{name:"Browser local (Europe/Paris)"})).toBeTruthy();
    goTo("Browser local (Europe/Paris)","2020-01-01T01:00");
    expect(engine.goToTime).toHaveBeenCalledExactlyOnceWith(1577836800);
    cleanup();__resetBrowserZoneCacheForTests();
    spy.mockReturnValue({timeZone:""} as Intl.ResolvedDateTimeFormatOptions);
    show({timeZone:"local"});
    expect(screen.getByLabelText("Go to UTC date and time")).toBeTruthy();
    expect(screen.getByRole("option",{name:"Browser local (UTC)"})).toBeTruthy();
    expect((screen.getByLabelText("Display time zone") as HTMLSelectElement).value).toBe("local");
  });
  it("(j) keeps daily bars on UTC and says so",()=>{
    const engine=show({timeZone:"Asia/Tokyo"},"D1");
    expect((screen.getByLabelText("Display time zone") as HTMLSelectElement).value).toBe("Asia/Tokyo");
    expect(screen.getByTestId("chart-daily-zone-note").textContent).toBe("Daily bars keep UTC day labels.");
    goTo("UTC","2020-01-01T00:00");
    expect(engine.goToTime).toHaveBeenCalledExactlyOnceWith(1577836800);
  });
  it("prints the PNG capture time in the selected zone with the UTC ISO time",()=>{
    const texts:string[]=[];
    vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue({font:"",fillStyle:"",measureText:()=>({width:10}),fillRect(){},fillText:(text:string)=>texts.push(text),drawImage(){}} as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype,"toDataURL").mockReturnValue("data:image/png;base64,");
    vi.spyOn(HTMLAnchorElement.prototype,"click").mockImplementation(()=>{});
    vi.stubGlobal("Image",class{width=800;height=400;onload:(()=>void)|null=null;set src(_value:string){this.onload?.();}});
    vi.spyOn(Date,"now").mockReturnValue(Date.UTC(2026,9,28,5,46,11,123));
    const engine={...adapter,exportImage:()=>"data:image/png;base64,"} as unknown as ChartEngineAdapter;
    show({timeZone:"Asia/Tokyo"},"M15",engine as never);
    fireEvent.click(screen.getByRole("button",{name:"Export PNG"}));
    expect(texts).toContain("Captured 2026-10-28 14:46:11 GMT+9 (2026-10-28T05:46:11.123Z)");
    texts.length=0;chooseZone("UTC");
    fireEvent.click(screen.getByRole("button",{name:"Export PNG"}));
    expect(texts).toContain("Captured 2026-10-28T05:46:11.123Z");
  });
});

describe("chart style picker and PNG labels",()=>{
  it("offers the seven styles in CHART_STYLES order with display names and stores the choice",()=>{
    let latest=DEFAULT_PREFERENCES;
    function Harness() {
      const [preferences,setPreferences]=useState(DEFAULT_PREFERENCES);latest=preferences;
      return <ChartWorkbenchTools utcClockQualified adapter={adapter} epoch={1} symbol="EURUSD" timeframe="M15" preferences={preferences} onPreferences={setPreferences} hasCandles feedLabel="Offline fixture"/>;
    }
    render(<Harness/>);
    const select=screen.getByLabelText("Chart style") as HTMLSelectElement;
    expect([...select.options].map(option=>option.value)).toEqual([...CHART_STYLES]);
    expect([...select.options].map(option=>option.textContent)).toEqual(["Candlesticks","OHLC bars","Close line","Close area","Close baseline","Heikin Ashi","Hollow candles"]);
    fireEvent.change(select,{target:{value:"heikinAshi"}});
    expect(latest.style).toBe("heikinAshi");expect(select.value).toBe("heikinAshi");
  });
  it("names the style in the PNG header and marks Heikin Ashi as averaged, not traded, prices",()=>{
    const base={symbol:"EURUSD",timeframe:"M15",capture:"Captured 2026-10-28T05:46:11.123Z",feedLabel:"Offline fixture",studies:[STUDY_DEFAULTS[0]!]};
    expect(exportLabels({...base,style:"candles"})).toEqual(["ARX · EURUSD M15","Captured 2026-10-28T05:46:11.123Z","Offline fixture","Style Candlesticks",studyLabel(STUDY_DEFAULTS[0]!)]);
    expect(exportLabels({...base,style:"heikinAshi"})[3]).toBe("Style Heikin Ashi (averaged bodies, not traded prices)");
    expect(exportLabels({...base,style:"baseline",studies:[]})).toEqual(["ARX · EURUSD M15","Captured 2026-10-28T05:46:11.123Z","Offline fixture","Style Close baseline"]);
    for(const style of CHART_STYLES.filter(style=>style!=="heikinAshi"))expect(exportLabels({...base,style}).join("\n")).not.toContain("averaged");
  });
});


it("offers a reversible price-only scale control without altering other preferences",()=>{
 const changed=vi.fn();const initial={...DEFAULT_PREFERENCES,inverted:true};
 const view=render(<ChartWorkbenchTools utcClockQualified adapter={adapter} epoch={1} symbol="EURUSD" timeframe="M15" preferences={initial} onPreferences={changed} hasCandles feedLabel="Offline fixture"/>);
 const button=screen.getByRole("button",{name:"Scale price only",exact:true});expect(button.getAttribute("aria-pressed")).toBe("false");
 fireEvent.click(button);const enabled=changed.mock.calls[0][0](initial);expect(enabled).toEqual({...initial,priceOnlyScale:true});
 view.rerender(<ChartWorkbenchTools utcClockQualified adapter={adapter} epoch={1} symbol="EURUSD" timeframe="M15" preferences={enabled} onPreferences={changed} hasCandles feedLabel="Offline fixture"/>);
 expect(button.getAttribute("aria-pressed")).toBe("true");fireEvent.click(button);expect(changed.mock.calls[1][0](enabled)).toEqual({...initial,priceOnlyScale:false});
});


it("places and edits a classic pitchfork with three distinct candles, undo, locking, hiding and reload",()=>{
 const view=mount();fireEvent.change(screen.getByLabelText("Drawing tool"),{target:{value:"pitchfork"}});
 const key=drawingStorageKey("EURUSD","M15");const saved=()=>JSON.parse(localStorage.getItem(key)!);
 act(()=>click?.({time:100,price:10}));act(()=>click?.({time:200,price:30}));
 expect(localStorage.getItem(key)).toBeNull();
 act(()=>click?.({time:50,price:20}));expect(localStorage.getItem(key)).toBeNull();
 expect(screen.getByText(/Choose both tine anchors after/)).toBeTruthy();
 act(()=>click?.({time:200,price:20}));expect(localStorage.getItem(key)).toBeNull();
 act(()=>click?.({time:300,price:20}));
 expect(saved()[0]).toMatchObject({kind:"pitchfork",start:{time:100,price:10},end:{time:200,price:30},offset:{time:300,price:20},extendRight:true});
 fireEvent.click(screen.getByRole("button",{name:"Objects (1)",exact:true}));
 expect(screen.getByText(/Classic pitchfork:/)).toBeTruthy();
 expect(screen.queryByLabelText("Drawing 1 middle line")).toBeNull();
 fireEvent.click(screen.getByLabelText("Drawing 1 extend left"));expect(saved()[0].extendLeft).toBe(true);
 fireEvent.click(screen.getByRole("button",{name:"Undo",exact:true}));expect(saved()[0].extendLeft).toBeUndefined();
 fireEvent.click(screen.getByRole("button",{name:"Redo",exact:true}));expect(saved()[0].extendLeft).toBe(true);
 fireEvent.blur(screen.getByLabelText("Drawing 1 offset price"),{target:{value:"25"}});expect(saved()[0].offset.price).toBe(25);
 fireEvent.click(screen.getByLabelText("Lock drawing 1"));expect(screen.getByLabelText("Drawing 1 extend right").hasAttribute("disabled")).toBe(true);
 fireEvent.click(screen.getByLabelText("Hide drawing 1"));expect(saved()[0].hidden).toBe(true);
 view.unmount();mount();expect(drawings.mock.calls.at(-1)![0][0]).toMatchObject({kind:"pitchfork",hidden:true});
 fireEvent.click(screen.getByRole("button",{name:"Objects (1)",exact:true}));fireEvent.click(screen.getByLabelText("Show drawing 1"));
 expect(drawings.mock.calls.at(-1)![0][0]).toMatchObject({kind:"pitchfork",offset:{time:300,price:25},locked:true});
 fireEvent.change(screen.getByLabelText("Drawing tool"),{target:{value:"pitchfork"}});act(()=>click?.({time:400,price:10}));act(()=>click?.({time:500,price:20}));
 fireEvent.keyDown(window,{key:"Escape"});expect(saved()).toHaveLength(1);
});

it("places a channel in three steps, cancels partial placement and preserves its third anchor through undo and reload",()=>{
 const view=mount();fireEvent.change(screen.getByLabelText("Drawing tool"),{target:{value:"channel"}});
 act(()=>click?.({time:100,price:10}));act(()=>click?.({time:200,price:20}));
 expect(localStorage.getItem(drawingStorageKey("EURUSD","M15"))).toBeNull();
 expect(screen.getByText(/choose a third candle/)).toBeTruthy();
 act(()=>click?.({time:100,price:30}));
 const saved=()=>JSON.parse(localStorage.getItem(drawingStorageKey("EURUSD","M15"))!);
 expect(saved()[0]).toMatchObject({kind:"channel",start:{time:100,price:10},end:{time:200,price:20},offset:{time:100,price:30}});
 fireEvent.click(screen.getByRole("button",{name:"Undo",exact:true}));expect(saved()).toEqual([]);
 fireEvent.click(screen.getByRole("button",{name:"Redo",exact:true}));expect(saved()[0].offset).toEqual({time:100,price:30});
 fireEvent.change(screen.getByLabelText("Drawing tool"),{target:{value:"channel"}});act(()=>click?.({time:300,price:10}));act(()=>click?.({time:400,price:20}));
 fireEvent.keyDown(window,{key:"Escape"});expect(saved()).toHaveLength(1);
 view.unmount();mount();expect(drawings.mock.calls.at(-1)![0][0].offset).toEqual({time:100,price:30});
});

describe("individual drawing visibility and search",()=>{
 const key=drawingStorageKey("EURUSD","M15");
 const items=[{id:"level",kind:"horizontal",start:{time:100,price:10},color:"#ffffff",locked:true},
 {id:"note",kind:"text",start:{time:200,price:20},color:"#ffffff",text:"Wait for a retest"}];
 const stored=()=>JSON.parse(localStorage.getItem(key)!);
 const open=()=>fireEvent.click(screen.getByRole("button",{name:"Objects (2)",exact:true}));
 it("hides a locked object reversibly without losing geometry, and restores its visibility after reload",()=>{
  localStorage.setItem(key,JSON.stringify(items));const view=mount();open();
  fireEvent.click(screen.getByLabelText("Select drawing 1"));
  fireEvent.click(screen.getByLabelText("Hide drawing 1"));
  expect(stored()).toEqual([{...items[0],hidden:true},items[1]]);
  expect(screen.getByLabelText("Select drawing 1").hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button",{name:"Undo",exact:true}));expect(stored()).toEqual(items);
  fireEvent.click(screen.getByRole("button",{name:"Redo",exact:true}));expect(stored()[0].hidden).toBe(true);
  fireEvent.click(screen.getByRole("button",{name:"Hide drawings",exact:true}));
  expect(drawings).toHaveBeenLastCalledWith([]);
  fireEvent.click(screen.getByRole("button",{name:"Show drawings",exact:true}));
  expect(drawings).toHaveBeenLastCalledWith([{...items[0],hidden:true},items[1]]);
  view.unmount();mount();open();
  expect(screen.getByLabelText("Show drawing 1")).toBeTruthy();
  fireEvent.click(screen.getByLabelText("Show drawing 1"));expect(stored()).toEqual(items);
 });
 it("searches type and note text without hiding canvas objects or renumbering actions",()=>{
  localStorage.setItem(key,JSON.stringify(items));mount();open();const before=drawings.mock.calls.length;
  fireEvent.change(screen.getByLabelText("Find drawing"),{target:{value:" RETEST "}});
  expect(screen.queryByLabelText("Select drawing 1")).toBeNull();expect(screen.getByLabelText("Select drawing 2")).toBeTruthy();
  expect(drawings.mock.calls.length).toBe(before);expect(stored()).toEqual(items);
  fireEvent.click(screen.getByLabelText("Hide drawing 2"));expect(stored()).toEqual([items[0],{...items[1],hidden:true}]);
  fireEvent.change(screen.getByLabelText("Find drawing"),{target:{value:"does not match"}});
  expect(screen.getByText(/No matching drawings/)).toBeTruthy();expect(stored()).toHaveLength(2);
  fireEvent.change(screen.getByLabelText("Find drawing"),{target:{value:"horizontal"}});
  expect(screen.getByLabelText("Select drawing 1")).toBeTruthy();expect(screen.queryByLabelText("Select drawing 2")).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Clear search"}));expect(screen.getAllByTestId("chart-drawing-object")).toHaveLength(2);
 });
 it("synchronizes hidden state to another same-context chart and preserves it on a visible-object drag",()=>{
  localStorage.setItem(key,JSON.stringify(items));
  const interaction=vi.fn();const engine={...adapter,setDrawingInteraction:interaction} as unknown as ChartEngineAdapter;
  mount("EURUSD","M15",engine);open();fireEvent.click(screen.getByLabelText("Hide drawing 1"));
  const otherDrawings=vi.fn();const other=mount("EURUSD","M15",{...adapter,setDrawings:otherDrawings} as unknown as ChartEngineAdapter);
  const config=interaction.mock.calls.at(-1)![0];
  act(()=>config.onCommit([{...items[0],hidden:true},{...items[1],start:{time:200,price:25}}]));
  expect(otherDrawings).toHaveBeenLastCalledWith(stored());expect(stored()[0].hidden).toBe(true);
  other.unmount();
 });
});

describe("focused controls during first candle layout",()=>{
  it.each(["outside","visible","foreign","keyboard"] as const)("scrolls only a focused out-of-view workbench control: %s", scenario=>{
    const props={adapter,epoch:1,symbol:"EURUSD",timeframe:"M15",preferences:DEFAULT_PREFERENCES,onPreferences:vi.fn(),feedLabel:"Offline"};
    const view=render(<ChartWorkbenchTools utcClockQualified {...props} hasCandles={false}/>);
    fireEvent.click(screen.getByRole("button",{name:"Studies (0)",exact:true}));
    const input=screen.getByLabelText("Search studies") as HTMLInputElement;
    input.focus();
    const scroll=vi.fn();input.scrollIntoView=scroll;
    const rectSpy=vi.spyOn(input,"getBoundingClientRect").mockReturnValue({x:10,y:scenario==="outside"?2000:100,left:10,right:210,top:scenario==="outside"?2000:100,bottom:scenario==="outside"?2032:132,width:200,height:32,toJSON:()=>({})});
    const other=document.createElement("input");
    if(scenario==="keyboard")vi.stubGlobal("visualViewport",{offsetTop:0,offsetLeft:0,width:window.innerWidth,height:120});
    const shouldScroll=scenario==="outside"||scenario==="keyboard";
    if(scenario==="foreign"){document.body.append(other);other.focus();}
    try{
      view.rerender(<ChartWorkbenchTools utcClockQualified {...props} hasCandles/>);
      if(shouldScroll)expect(scroll).toHaveBeenCalledExactlyOnceWith({block:"center",inline:"nearest",behavior:"instant"});
      else expect(scroll).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(scenario==="foreign"?other:input);
      view.rerender(<ChartWorkbenchTools utcClockQualified {...props} hasCandles/>);
      expect(scroll).toHaveBeenCalledTimes(shouldScroll?1:0);
      if(scenario==="foreign")expect(rectSpy).not.toHaveBeenCalled();
    }finally{other.remove();vi.unstubAllGlobals();}
  });
});


it("routes keyboard history through the same persisted undo/redo as toolbar edits",()=>{
 const row={id:"level",kind:"horizontal",start:{time:100,price:1.2},color:"#ffffff"};
 const key=drawingStorageKey("EURUSD","M15");localStorage.setItem(key,JSON.stringify([row]));
 const interaction=vi.fn();const engine={...adapter,setDrawingInteraction:interaction} as unknown as ChartEngineAdapter;
 mount("EURUSD","M15",engine);
 const config=()=>interaction.mock.calls.at(-1)![0];
 expect(config().onUndo).toBeUndefined();expect(config().onRedo).toBeUndefined();
 act(()=>config().onCommit([]));
 expect(screen.getByText("Drawing deleted. Undo restores it.")).toBeTruthy();
 expect(JSON.parse(localStorage.getItem(key)!)).toEqual([]);expect(config().onUndo).toBeTypeOf("function");
 act(()=>config().onUndo());
 expect(screen.getByText("Drawing edit undone.")).toBeTruthy();
 expect(JSON.parse(localStorage.getItem(key)!)).toEqual([row]);expect(config().onUndo).toBeUndefined();
 act(()=>config().onRedo());expect(JSON.parse(localStorage.getItem(key)!)).toEqual([]);
 act(()=>config().onUndo());act(()=>config().onCommit([{...row,start:{time:100,price:1.4}}]));
 expect(config().onRedo).toBeUndefined();
 act(()=>window.dispatchEvent(new StorageEvent("storage",{key})));
 expect(config().onUndo).toBeUndefined();expect(config().onRedo).toBeUndefined();
});

describe("range ruler workflow",()=>{
  it("places two points on the same candle, persists, edits and undoes a measurement",()=>{
    mount();fireEvent.change(screen.getByLabelText("Drawing tool"),{target:{value:"measure"}});
    act(()=>click!({time:100,price:100}));act(()=>click!({time:100,price:110}));
    fireEvent.click(screen.getByRole("button",{name:"Objects (1)",exact:true}));
    expect(screen.getByLabelText("Drawing 1 measurement").textContent).toContain("Price +10 (+10%) · 0s elapsed");
    const input=screen.getByLabelText("Drawing 1 end price");fireEvent.blur(input,{target:{value:"90"}});
    expect(screen.getByLabelText("Drawing 1 measurement").textContent).toContain("Price -10 (-10%)");
    fireEvent.click(screen.getByRole("button",{name:"Undo",exact:true}));
    expect(screen.getByLabelText("Drawing 1 measurement").textContent).toContain("Price +10 (+10%)");
    expect(JSON.parse(localStorage.getItem(drawingStorageKey("EURUSD","M15"))!)[0].end.price).toBe(110);
  });
  it("cancels a partial ruler without saving an object",()=>{
    mount();fireEvent.change(screen.getByLabelText("Drawing tool"),{target:{value:"measure"}});
    act(()=>click!({time:100,price:100}));fireEvent.keyDown(window,{key:"Escape"});
    expect(click).toBeNull();expect(screen.getByRole("button",{name:"Objects (0)",exact:true})).toBeTruthy();
    expect(localStorage.getItem(drawingStorageKey("EURUSD","M15"))).toBeNull();
  });
});

describe("source-clock coordinate controls",()=>{
 it("clears an entered UTC date when authority is withdrawn even if both effective zones stay UTC",()=>{
  const engine={...adapter,goToTime:vi.fn(()=>true)} as unknown as ChartEngineAdapter;
  const props={adapter:engine,epoch:1,symbol:"EURUSD",timeframe:"M1",preferences:DEFAULT_PREFERENCES,onPreferences:vi.fn(),hasCandles:true,feedLabel:"Controlled clock fixture"};
  const view=render(<ChartWorkbenchTools {...props} utcClockQualified/>);
  fireEvent.change(screen.getByLabelText("Go to UTC date and time"),{target:{value:"2026-11-01T12:00"}});
  view.rerender(<ChartWorkbenchTools {...props} utcClockQualified={false}/>);
  expect((screen.getByLabelText("Go to source-clock date and time") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("Display time zone") as HTMLSelectElement).disabled).toBe(true);
  expect(engine.goToTime).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Display time zone").closest("label")?.title).toContain("UTC mapping unverified");
 });
});

describe('source-bound study display labels and frozen PNG metadata',()=>{
 it('refreshes the active strip from exact anchor evidence and freezes its PNG label before image decoding',()=>{
  let qualified=true,decode:(()=>void)|null=null;const texts:string[]=[];
  const study={kind:'vwap' as const,period:1,color:'#ffffff',vwapAnchor:{kind:'observed_bar' as const,time:1700000000,seriesIdentity:'a'.repeat(64)}};
  const preferences={...DEFAULT_PREFERENCES,studies:[study]};
  const engine={...adapter,getVwapAnchorEvidence:()=>({utcQualified:qualified,reason:qualified?null:'withdrawn'}),exportImage:()=> 'data:image/png;base64,'} as ChartEngineAdapter;
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({font:'',fillStyle:'',measureText:()=>({width:10}),fillRect(){},fillText:(text:string)=>texts.push(text),drawImage(){}} as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype,'toDataURL').mockReturnValue('data:image/png;base64,');vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
  vi.stubGlobal('Image',class{width=800;height=400;onload:(()=>void)|null=null;set src(_value:string){decode=()=>this.onload?.();}});
  const app=(epoch:number)=><ChartWorkbenchTools utcClockQualified adapter={engine} epoch={epoch} symbol="AAPL" timeframe="M15" preferences={preferences} onPreferences={vi.fn()} hasCandles feedLabel="Delayed offline fixture"/>;
  const view=render(app(1));expect(screen.getByLabelText('Active studies').textContent).toContain('2023-11-14 22:13:20 UTC');expect(screen.getByLabelText('Active studies').textContent).not.toContain('unverified');
  fireEvent.click(screen.getByRole('button',{name:'Export PNG'}));qualified=false;view.rerender(app(2));expect(screen.getByLabelText('Active studies').textContent).toContain('source clock (UTC unverified)');
  decode!();expect(texts.join('\n')).toContain('observed-bar anchor 2023-11-14 22:13:20 UTC');expect(texts.join('\n')).not.toContain('unverified');
 });
});

it('revokes anchor wording before parent engine layout commit and recovers only after that commit without pane selection',()=>{
 let installed=true;const precommit:string[]=[];
 const engine={...adapter,getVwapAnchorEvidence:()=>({utcQualified:installed,reason:installed?null:'clock withdrawn'})};
 const preferences={...DEFAULT_PREFERENCES,studies:[{kind:'vwap' as const,period:1,color:'#ffffff',vwapAnchor:{kind:'observed_bar' as const,time:1700000000,seriesIdentity:'a'.repeat(64)}}]};
 function Parent({revision,qualified}:{revision:object;qualified:boolean}){
  useLayoutEffect(()=>{precommit.push(screen.getByLabelText('Active studies').textContent??'');installed=qualified;},[revision,qualified]);
  return <ChartWorkbenchTools adapter={engine} epoch="same-source" studyEvidenceRevision={revision} symbol="AAPL" timeframe="M15" preferences={preferences} onPreferences={vi.fn()} hasCandles feedLabel="Delayed" assistantActive={false}/>;
 }
 const first={},withdrawn={},recovered={};const view=render(<Parent revision={first} qualified/>);
 expect(screen.getByLabelText('Active studies').textContent).toContain('22:13:20 UTC');
 fireEvent.click(screen.getByRole('button',{name:'Studies (1)'}));
 view.rerender(<Parent revision={withdrawn} qualified={false}/>);
 expect(precommit.at(-1)).toContain('source clock (UTC unverified)');
 expect(screen.getByLabelText('Active studies').textContent).toContain('source clock (UTC unverified)');
 expect(Array.from(screen.getByLabelText('Study settings').querySelectorAll('legend')).find(node=>node.textContent?.startsWith('1. VWAP'))?.textContent).toContain('source clock (UTC unverified)');
 view.rerender(<Parent revision={recovered} qualified/>);
 expect(precommit.at(-1)).toContain('source clock (UTC unverified)');
 expect(screen.getByLabelText('Active studies').textContent).toContain('22:13:20 UTC');
});

describe('anchor display marker only runs for an actual consumer',()=>{
 it.each([false,true])('revision-only updates cause no marker commit when ordinary studies exist: %s',withOrdinaryStudy=>{
  const commits=vi.fn(),proof=vi.fn(()=>({utcQualified:true,reason:null}));
  const preferences={...DEFAULT_PREFERENCES,studies:withOrdinaryStudy?[{kind:'sma' as const,period:20,color:'#fff'}]:[]};
  const engine={...adapter,getVwapAnchorEvidence:proof};
  const onPreferences=vi.fn();
  const app=(revision:object)=><Profiler id="workbench" onRender={commits}><ChartWorkbenchTools showTemplates={false} adapter={engine} epoch="same-owner" studyEvidenceRevision={revision} symbol="AAPL" timeframe="M15" preferences={preferences} onPreferences={onPreferences} hasCandles feedLabel="Delayed"/></Profiler>;
  const view=render(app({}));commits.mockClear();
  view.rerender(app({}));expect(commits).toHaveBeenCalledTimes(1);
  commits.mockClear();view.rerender(app({}));expect(commits).toHaveBeenCalledTimes(1);
  expect(proof).not.toHaveBeenCalled();
 });

 it.each(['vwap','volume_profile'] as const)('adding, removing and readding %s cannot borrow a marker from an unchecked revision',kind=>{
  let installed=true;const precommit:string[]=[];
  const engine={...adapter,getVwapAnchorEvidence:()=>({utcQualified:installed,reason:installed?null:'clock withdrawn'})};
  const anchor={kind:'observed_bar' as const,time:1700000000,seriesIdentity:'a'.repeat(64)};
  const study=kind==='vwap'?{kind,period:1,color:'#fff',vwapAnchor:anchor}:{kind,period:1,color:'#fff',profileRows:32,profileValueAreaPercent:70,profileRange:{kind:'observed_range' as const,fromTime:anchor.time,toTime:anchor.time+60,seriesIdentity:anchor.seriesIdentity,clockAuthority:'twelve-data:time-series:common-stock:regular-unadjusted:v1'}};
  function Parent({revision,qualified,present}:{revision:object;qualified:boolean;present:boolean}){
   useLayoutEffect(()=>{precommit.push(screen.queryByLabelText('Study settings')?.textContent??'');installed=qualified;},[revision,qualified,present]);
   return <ChartWorkbenchTools adapter={engine} epoch="same-source" studyEvidenceRevision={revision} symbol="AAPL" timeframe="M15" preferences={{...DEFAULT_PREFERENCES,studies:present?[study]:[]}} onPreferences={vi.fn()} hasCandles feedLabel="Delayed" assistantActive={false}/>;
  }
  const first={},unchecked={},later={};const view=render(<Parent revision={first} qualified present/>);
  fireEvent.click(screen.getByRole('button',{name:'Studies (1)'}));
  expect(screen.getByLabelText('Study settings').textContent).toContain('22:13:20 UTC');
  view.rerender(<Parent revision={first} qualified present={false}/>);
  view.rerender(<Parent revision={unchecked} qualified present={false}/>);
  // Re-use the old revision object to prove a retained pre-removal marker
  // cannot qualify old installed rows before the parent installs withdrawn data.
  view.rerender(<Parent revision={first} qualified={false} present/>);
  expect(precommit.at(-1)).toContain('source clock (UTC unverified)');
  expect(screen.getByLabelText('Study settings').textContent).toContain('source clock (UTC unverified)');
  view.rerender(<Parent revision={later} qualified present/>);
  expect(precommit.at(-1)).toContain('source clock (UTC unverified)');
  expect(screen.getByLabelText('Study settings').textContent).toContain('22:13:20 UTC');
  view.rerender(<Parent revision={{}} qualified={false} present/>);
  expect(precommit.at(-1)).toContain('source clock (UTC unverified)');
  expect(screen.getByLabelText('Study settings').textContent).toContain('source clock (UTC unverified)');
 });
});

it("keeps the drawing owner across controlled selection and renews it at context boundaries",()=>{
 const setDrawingInteraction=vi.fn();const engine={...adapter,setDrawingInteraction} as unknown as ChartEngineAdapter;
 const props={adapter:engine,epoch:1,symbol:"EURUSD",timeframe:"M15",preferences:DEFAULT_PREFERENCES,onPreferences:vi.fn(),hasCandles:true,feedLabel:"Offline fixture"};
 localStorage.setItem(drawingStorageKey("EURUSD","M15"),JSON.stringify([{id:"pick",kind:"horizontal",start:{time:100,price:1.2},color:"#ffffff"}]));
 const view=render(<ChartWorkbenchTools {...props}/>);
 const initial=setDrawingInteraction.mock.calls.at(-1)![0];expect(initial.owner).toBeTruthy();
 act(()=>initial.onSelect("pick"));
 const selected=setDrawingInteraction.mock.calls.at(-1)![0];expect(selected.selectedId).toBe("pick");expect(selected.owner).toBe(initial.owner);
 view.rerender(<ChartWorkbenchTools {...props} feedLabel="Refreshed fixture"/>);expect(setDrawingInteraction.mock.calls.at(-1)![0].owner).toBe(initial.owner);
 view.rerender(<ChartWorkbenchTools {...props} epoch={2}/>);const next=setDrawingInteraction.mock.calls.at(-1)![0].owner;expect(next).not.toBe(initial.owner);
 view.rerender(<ChartWorkbenchTools {...props} epoch={2} drawingKey="new-source"/>);expect(setDrawingInteraction.mock.calls.at(-1)![0].owner).not.toBe(next);
});

it('labels indicator-only exports without claiming a visible price style or drawing preview',()=>{
 const labels=exportLabels({symbol:'EURUSD',timeframe:'M15',capture:'Offline',feedLabel:'Synthetic',style:'candles',studies:[],fibonacciPreview:true,maximizedPane:'rsi'});
 expect(labels.join(' ')).toContain('Hidden price style');expect(labels.join(' ')).toContain('Maximized indicator pane');expect(labels.join(' ')).not.toContain('UNACCEPTED automatic Fibonacci preview');
});
it('retires an unfinished price drawing when an indicator pane is maximized',()=>{
 const props={adapter,epoch:1,symbol:'EURUSD',timeframe:'M15',preferences:DEFAULT_PREFERENCES,onPreferences:vi.fn(),hasCandles:true,feedLabel:'Offline'};
 const view=render(<ChartWorkbenchTools {...props}/>);
 fireEvent.change(screen.getByLabelText('Drawing tool'),{target:{value:'trend'}});act(()=>click?.({time:100,price:1.2}));
 view.rerender(<ChartWorkbenchTools {...props} maximizedPane="rsi"/>);
 expect(click).toBeNull();expect((screen.getByLabelText('Drawing tool') as HTMLSelectElement).value).toBe('');
 view.rerender(<ChartWorkbenchTools {...props} maximizedPane={null}/>);expect(click).toBeNull();
});
it('refreshes the visible study caption on completed paint and does not rerender for unchanged viewport notifications',()=>{
 let verified=false;const listeners=new Set<()=>void>(),retained:Array<()=>void>=[],commits=vi.fn();
 const engine={...adapter,isAnalysisFocusVerified:()=>verified,subscribeViewport:(fn:()=>void)=>{listeners.add(fn);retained.push(fn);return()=>listeners.delete(fn);}} as ChartEngineAdapter;
 const props={adapter:engine,epoch:1,symbol:'EURUSD',timeframe:'M15',preferences:{...DEFAULT_PREFERENCES,studies:[STUDY_DEFAULTS[0]!]},onPreferences:vi.fn(),hasCandles:true,feedLabel:'Offline'};
 const view=render(<Profiler id="proof-caption" onRender={commits}><ChartWorkbenchTools {...props}/></Profiler>);
 expect(screen.getByLabelText('Saved studies (visibility unverified)')).toBeTruthy();
 act(()=>{verified=true;listeners.forEach(fn=>fn());});expect(screen.getByLabelText('Active studies')).toBeTruthy();expect(screen.queryByText('Visibility unverified ·')).toBeNull();
 commits.mockClear();act(()=>{for(let i=0;i<100;i++)listeners.forEach(fn=>fn());});expect(commits).not.toHaveBeenCalled();
 act(()=>{verified=false;listeners.forEach(fn=>fn());});expect(screen.getByLabelText('Saved studies (visibility unverified)')).toBeTruthy();
 view.unmount();expect(listeners.size).toBe(0);act(()=>{verified=true;retained.forEach(fn=>fn());});expect(screen.queryByLabelText('Active studies')).toBeNull();
});
