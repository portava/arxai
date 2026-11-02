import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChartStudySettings } from "./ChartStudySettings";
import { DEFAULT_PREFERENCES, type ChartPreferences } from "@/lib/chart-engine/chartWorkspace";

function Workspace() {
  const [preferences, setPreferences] = useState<ChartPreferences>(DEFAULT_PREFERENCES);
  return <><ChartStudySettings preferences={preferences} onPreferences={setPreferences} /><output data-testid="preferences">{JSON.stringify(preferences)}</output></>;
}
const settings = () => JSON.parse(screen.getByTestId("preferences").textContent!);
afterEach(cleanup);
describe("independent study configuration", () => {
  it("searches the catalog and independently edits two copies of one study", () => {
    render(<Workspace />);
    fireEvent.change(screen.getByLabelText("Search studies"), { target: { value: "exponential moving" } });
    expect(screen.queryByRole("button", { name: "Add Simple moving average" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add Exponential moving average", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate study 1" }));
    fireEvent.blur(screen.getByLabelText("EMA 2 Period"), { target: { value: "200" } });
    fireEvent.change(screen.getByLabelText("EMA 2 Source"), { target: { value: "hl2" } });
    expect(settings().studies.map((s: any) => [s.period, s.source])).toEqual([[50, undefined], [200, "hl2"]]);
    expect(new Set(settings().studies.map((s: any) => s.id)).size).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Remove study 1" }));
    expect(settings().studies).toHaveLength(1);
    expect(settings().studies[0].period).toBe(200);
  });
  it("rejects invalid numbers without silently removing a study and exposes MT5 signal smoothing", () => {
    render(<Workspace />);
    fireEvent.click(screen.getByRole("button", { name: "Add MACD" }));
    const fast = screen.getByLabelText("MACD 1 Fast");
    fireEvent.change(fast, { target: { value: "5000" } });
    fireEvent.blur(fast);
    expect(settings().studies[0].period).toBe(12);
    expect((fast as HTMLInputElement).value).toBe("12");
    fireEvent.change(screen.getByLabelText("MACD 1 Slow"), { target: { value: "2" } });
    fireEvent.blur(screen.getByLabelText("MACD 1 Slow"));
    expect(settings().studies[0].slow).toBe(26);
    fireEvent.change(screen.getByLabelText("MACD 1 Signal method"), { target: { value: "sma" } });
    expect(settings().studies[0].signalMethod).toBe("sma");
  });
  it("bounds simultaneous work and makes space available after removal", () => {
    render(<Workspace />);
    const add = screen.getByRole("button", { name: "Add Simple moving average" });
    for (let i = 0; i < 12; i++) fireEvent.click(add);
    expect(settings().studies).toHaveLength(12);
    expect(add.hasAttribute("disabled")).toBe(true);
    fireEvent.click(add);
    expect(settings().studies).toHaveLength(12);
    fireEvent.click(screen.getByRole("button", { name: "Remove study 1" }));
    expect(add.hasAttribute("disabled")).toBe(false);
    fireEvent.click(add);
    expect(settings().studies).toHaveLength(12);
    expect(within(screen.getByLabelText("Available studies")).getAllByRole("button")).toHaveLength(23);
  });
});

it("configures DMI direction and strength lengths independently with clear semantics",()=>{
 render(<Workspace/>);fireEvent.change(screen.getByLabelText("Search studies"),{target:{value:"ADX"}});
 fireEvent.click(screen.getByRole("button",{name:"Add Directional movement (DMI / ADX)"}));
 fireEvent.blur(screen.getByLabelText("DMI 1 DI period"),{target:{value:"7"}});
 fireEvent.blur(screen.getByLabelText("DMI 1 ADX smoothing"),{target:{value:"21"}});
 expect(settings().studies[0]).toMatchObject({kind:"dmi",period:7,signal:21});
 expect(screen.queryByLabelText("DMI 1 Source")).toBeNull();
 expect(screen.getByText(/ADX measures strength, not direction or confidence/)).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Duplicate study 1"}));
 fireEvent.blur(screen.getByLabelText("DMI 2 ADX smoothing"),{target:{value:"3"}});
 expect(settings().studies.map((s:any)=>s.signal)).toEqual([21,3]);
});


it("edits individual DMI lines, duplicates independently, and restores default appearance",()=>{
 render(<Workspace/>);fireEvent.click(screen.getByRole("button",{name:"Add Directional movement (DMI / ADX)"}));
 fireEvent.click(screen.getByLabelText("DMI 1 +DI visible"));
 fireEvent.change(screen.getByLabelText("DMI 1 −DI color"),{target:{value:"#123456"}});
 fireEvent.change(screen.getByLabelText("DMI 1 −DI width"),{target:{value:"3"}});
 fireEvent.change(screen.getByLabelText("DMI 1 −DI style"),{target:{value:"dotted"}});
 expect(settings().studies[0].lineStyles).toEqual([{visible:false},{color:"#123456",width:3,style:"dotted"},{}]);
 fireEvent.click(screen.getByRole("button",{name:"Duplicate study 1"}));
 fireEvent.click(screen.getByLabelText("DMI 2 +DI visible"));
 expect(settings().studies.map((s:any)=>s.lineStyles[0].visible)).toEqual([false,true]);
 fireEvent.click(screen.getByRole("button",{name:"Reset study 1 line appearance"}));
 expect(settings().studies[0].lineStyles).toBeUndefined();expect(settings().studies[1].lineStyles[1].color).toBe("#123456");
 expect((screen.getByLabelText("DMI 1 +DI color") as HTMLInputElement).value).toBe("#4ade80");
});
it("exposes MACD histogram visibility without a misleading single sign-color control",()=>{
 render(<Workspace/>);fireEvent.click(screen.getByRole("button",{name:"Add MACD"}));
 fireEvent.click(screen.getByLabelText("MACD 1 Histogram visible"));
 expect(settings().studies[0].lineStyles[2]).toEqual({visible:false});
 expect(screen.queryByLabelText("MACD 1 Histogram color")).toBeNull();
});

it('adds, adjusts and hides genuine VWAP in the same saved settings; refuses invalid anchors without losing preferences',()=>{
 const identity='a'.repeat(64);
 let bars:any[]=[10,20,30].map((price,index)=>({time:1700000000+index*60,open:price,high:price,low:price,close:price,volumeEvidence:{kind:'real_volume',unit:'provider_trade_units',quantity:index+1,reason:null,authority:'twelve-data:time-series:common-stock:regular-unadjusted:v1',seriesIdentity:identity}}));
 const adapter={getVisibleCandles:()=>bars} as any;
 function Test(){const [preferences,setPreferences]=useState<ChartPreferences>(DEFAULT_PREFERENCES);return <><ChartStudySettings preferences={preferences} onPreferences={setPreferences} adapter={adapter}/><output data-testid="preferences">{JSON.stringify(preferences)}</output></>;}
 render(<Test/>);
 fireEvent.click(screen.getByRole('button',{name:'Add Anchored VWAP'}));
 expect(settings().studies[0].vwapAnchor).toEqual({kind:'observed_bar',time:bars[0].time,seriesIdentity:identity});
 expect(screen.queryByLabelText('VWAP 1 Period')).toBeNull();
 fireEvent.change(screen.getByLabelText('VWAP 1 Source'),{target:{value:'hl2'}});
 fireEvent.focus(screen.getByLabelText('VWAP 1 Observed-bar anchor'));
 fireEvent.change(screen.getByLabelText('VWAP 1 Observed-bar anchor'),{target:{value:String(bars[1].time)}});
 expect(settings().studies[0]).toMatchObject({source:'hl2',vwapAnchor:{time:bars[1].time}});
 fireEvent.click(screen.getByLabelText('VWAP 1 VWAP visible'));expect(settings().studies[0].lineStyles[0].visible).toBe(false);
 const before=settings();bars=[{...bars[0],volumeEvidence:undefined},...bars.slice(1)];
 fireEvent.click(screen.getByRole('button',{name:'Re-anchor to first visible bar'}));expect(settings()).toEqual(before);expect(screen.getByText(/The first visible bar was not skipped/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Add Anchored VWAP'}));expect(settings()).toEqual(before);
});

it('bounds anchor options and does no viewport subscription, while distant visible bars remain searchable',()=>{
 const identity='a'.repeat(64),evidence={kind:'real_volume',unit:'provider_trade_units',quantity:2,reason:null,authority:'twelve-data:time-series:common-stock:regular-unadjusted:v1',seriesIdentity:identity};
 const bars=Array.from({length:50000},(_,i)=>({time:1700000000+i*60,open:1,high:1,low:1,close:1,volumeEvidence:evidence}));
 let reads=0,subscriptions=0;
 const adapter={getVisibleCandles:()=>{reads++;return bars;},subscribeViewport:()=>{subscriptions++;return()=>{};}} as any;
 function Test(){const [preferences,setPreferences]=useState<ChartPreferences>({...DEFAULT_PREFERENCES,studies:[{kind:'vwap',period:1,color:'#ffffff',source:'hlc3',vwapAnchor:{kind:'observed_bar',time:bars[0]!.time,seriesIdentity:identity}}]});return <><ChartStudySettings preferences={preferences} onPreferences={setPreferences} adapter={adapter}/><output data-testid="preferences">{JSON.stringify(preferences)}</output></>;}
 render(<Test/>);expect(subscriptions).toBe(0);expect(reads).toBe(0);
 fireEvent.focus(screen.getByLabelText('VWAP 1 Observed-bar anchor'));expect(reads).toBe(1);
 expect(within(screen.getByLabelText('VWAP 1 Observed-bar anchor')).getAllByRole('option')).toHaveLength(100);
 fireEvent.change(screen.getByLabelText('VWAP 1 Color'),{target:{value:'#123456'}});expect(reads).toBe(1);
 const target=bars[49999]!;const query=new Date(target.time*1000).toISOString().slice(0,19).replace('T',' ');
 fireEvent.change(screen.getByLabelText('VWAP 1 Find visible anchor bar'),{target:{value:query}});
 const selector=screen.getByLabelText('VWAP 1 Observed-bar anchor');expect(within(selector).getAllByRole('option')).toHaveLength(2);
 fireEvent.change(selector,{target:{value:String(target.time)}});expect(settings().studies[0].vwapAnchor.time).toBe(target.time);
});

it('links to an exact study channel, prevents cycles, preserves missing sources and supports choosing price again',()=>{
 render(<Workspace/>);
 fireEvent.click(screen.getByRole('button',{name:'Add Relative strength index'}));
 fireEvent.click(screen.getByRole('button',{name:'Add Simple moving average'}));
 const rsi=settings().studies[0].id;
 fireEvent.change(screen.getByLabelText('SMA 2 Source'),{target:{value:`study:${rsi}:0`}});
 expect(settings().studies[1].studySource).toEqual({studyId:rsi,channel:0});
 const sma=settings().studies[1].id;
 expect(within(screen.getByLabelText('RSI 1 Source')).getByRole('option',{name:'2. SMA · SMA (unavailable)'}).hasAttribute('disabled')).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Duplicate study 2'}));
 expect(settings().studies[2].studySource).toEqual({studyId:rsi,channel:0});
 expect(settings().studies[2].id).not.toBe(sma);
 fireEvent.click(screen.getByRole('button',{name:'Remove study 1'}));
 expect(settings().studies[0].studySource).toEqual({studyId:rsi,channel:0});
 expect(screen.getAllByText(/its source study or channel is missing/)).toHaveLength(2);
 fireEvent.change(screen.getByLabelText('SMA 1 Source'),{target:{value:'close'}});
 expect(settings().studies[0].studySource).toBeUndefined();expect(settings().studies[0].source).toBe('close');
});


it('edits pane guides and applies fixed limits atomically, keeping invalid drafts out of saved studies',()=>{
 render(<Workspace/>);fireEvent.click(screen.getByRole('button',{name:'Add Relative strength index'}));
 fireEvent.change(screen.getByLabelText('RSI 1 Scale minimum'),{target:{value:'80'}});
 fireEvent.change(screen.getByLabelText('RSI 1 Scale maximum'),{target:{value:'20'}});
 fireEvent.click(screen.getByRole('button',{name:'RSI 1 Apply fixed scale'}));
 expect(settings().studies).toHaveLength(1);expect(settings().studies[0].paneScale).toBeUndefined();expect(screen.getByRole('alert')).toBeTruthy();
 fireEvent.change(screen.getByLabelText('RSI 1 Scale minimum'),{target:{value:'20'}});
 fireEvent.change(screen.getByLabelText('RSI 1 Scale maximum'),{target:{value:'80'}});
 fireEvent.click(screen.getByRole('button',{name:'RSI 1 Apply fixed scale'}));
 expect(settings().studies[0].paneScale).toEqual({mode:'fixed',min:20,max:80});
 fireEvent.change(screen.getByLabelText('RSI 1 Scale minimum'),{target:{value:''}});fireEvent.click(screen.getByRole('button',{name:'RSI 1 Apply fixed scale'}));
 expect(settings().studies[0].paneScale.min).toBe(20);
 fireEvent.click(screen.getByRole('button',{name:'RSI 1 Clear reference levels'}));expect(settings().studies[0].referenceLevels).toEqual([]);
 fireEvent.click(screen.getByRole('button',{name:'RSI 1 Add reference level'}));
 fireEvent.blur(screen.getByLabelText('RSI 1 Level 1 value'),{target:{value:'50'}});
 fireEvent.change(screen.getByLabelText('RSI 1 Level 1 description'),{target:{value:'Midpoint'}});
 fireEvent.change(screen.getByLabelText('RSI 1 Level 1 style'),{target:{value:'dotted'}});
 expect(settings().studies[0].referenceLevels).toEqual([{value:50,label:'Midpoint',style:'dotted'}]);
 fireEvent.click(screen.getByRole('button',{name:'Duplicate study 1'}));
 fireEvent.click(screen.getByRole('button',{name:'RSI 1 Default reference levels'}));
 expect(settings().studies[0].referenceLevels).toBeUndefined();expect(settings().studies[1].referenceLevels[0].value).toBe(50);
 fireEvent.click(screen.getByRole('button',{name:'RSI 1 Auto scale'}));expect(settings().studies[0].paneScale).toEqual({mode:'auto'});
 fireEvent.click(screen.getByRole('button',{name:'RSI 1 Default scale'}));expect(settings().studies[0].paneScale).toBeUndefined();
});
