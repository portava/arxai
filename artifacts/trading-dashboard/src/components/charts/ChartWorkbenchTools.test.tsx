import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
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
const mount=(symbol="EURUSD",timeframe="M15",engine=adapter)=>render(<ChartWorkbenchTools key={`${symbol}:${timeframe}`} adapter={engine} epoch={1} symbol={symbol} timeframe={timeframe} preferences={DEFAULT_PREFERENCES} onPreferences={vi.fn()} hasCandles feedLabel="Offline fixture"/>);
beforeEach(()=>{localStorage.clear();vi.clearAllMocks();click=null;});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();__resetBrowserZoneCacheForTests();});
describe("drawing workspace controls",()=>{
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
    function View(){const [preferences,onPreferences]=useState(DEFAULT_PREFERENCES);return <ChartWorkbenchTools adapter={adapter} epoch={1} symbol="EURUSD" timeframe="M15" preferences={preferences} onPreferences={onPreferences} hasCandles feedLabel="Offline fixture"/>;}
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
    return <ChartWorkbenchTools adapter={engine} epoch={1} symbol="EURUSD" timeframe={timeframe} preferences={preferences} onPreferences={setPreferences} hasCandles feedLabel="Offline fixture"/>;
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
  it("(f, g) never saves or applies a zone through the template",()=>{
    show({timeZone:"Asia/Tokyo",style:"bars"});
    fireEvent.click(screen.getByRole("button",{name:"Save template"}));
    const saved=JSON.parse(localStorage.getItem(TEMPLATE_KEY)!);
    expect(saved.style).toBe("bars");expect(Object.hasOwn(saved,"timeZone")).toBe(false);
    cleanup();
    localStorage.setItem(TEMPLATE_KEY,JSON.stringify({style:"line",scale:"log",studies:[],timeZone:"Asia/Tokyo"}));
    show();
    fireEvent.click(screen.getByRole("button",{name:"Load template"}));
    expect(latest.style).toBe("line");expect(Object.hasOwn(latest,"timeZone")).toBe(false);
    cleanup();
    show({timeZone:"America/New_York"});
    fireEvent.click(screen.getByRole("button",{name:"Load template"}));
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
      return <ChartWorkbenchTools adapter={adapter} epoch={1} symbol="EURUSD" timeframe="M15" preferences={preferences} onPreferences={setPreferences} hasCandles feedLabel="Offline fixture"/>;
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
