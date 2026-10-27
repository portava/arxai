import { afterEach, describe, expect, it, vi } from "vitest";
import { ChartAnalysisRenderer, studyDisplayWindow } from "./chartAnalysisRenderer";
import { StudyCalculator, STUDY_DEFAULTS, STUDY_CATALOG } from "./chartStudies";

function fixture(count = 10000) {
  let range = { from: Math.max(0,count-200), to: count+10 } as any;
  let callback: (() => void) | undefined;
  let scheduled: (() => void) | undefined;
  vi.stubGlobal("requestAnimationFrame", vi.fn((fn: () => void) => { scheduled = fn; return 1; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn(() => { scheduled = undefined; }));
  const handles: any[] = [];
  const scale = { getVisibleLogicalRange: () => range, setVisibleLogicalRange: vi.fn(), subscribeVisibleLogicalRangeChange: (fn: () => void) => { callback = fn; }, unsubscribeVisibleLogicalRangeChange: vi.fn() };
  const chart = { timeScale: () => scale, panes: () => [], removeSeries: vi.fn(), addSeries: vi.fn(() => {
    const line: any = { data: [], createPriceLine: vi.fn() };
    line.setData=vi.fn((data:any[])=>{line.data=data.map(point=>({...point}));});
    line.update=vi.fn((point:any)=>{
      const last=line.data.at(-1);
      if(last && point.time<last.time)throw new Error("Historical update requires full replacement");
      if(last?.time===point.time)line.data[line.data.length-1]={...point};else line.data.push({...point});
    });
    line.pop=vi.fn((count:number)=>{
      // Actual LWC pop counts plotted values and leaves whitespace mappings.
      for(let i=line.data.length-1;i>=0&&count>0;i--)if(line.data[i].value!=null){line.data.splice(i,1);count--;}
    });
    handles.push(line); return line;
  }) };
  const renderer = new ChartAnalysisRenderer(chart as any, {} as any);
  const candles = Array.from({ length: count }, (_, i) => ({ time: 100 + i * 60, open: 100, high: 120, low: 90, close: 100 + Math.sin(i / 4) }));
  return { renderer, candles, handles, chart, scale, frame: () => scheduled?.(), move: (from: number, to: number) => { range = { from, to }; callback?.(); } };
}
afterEach(() => vi.unstubAllGlobals());
describe("study viewport rendering and streaming", () => {
  it("retains full calculations while limiting render geometry, and restores exact past values on pan", () => {
    const { renderer, handles, candles, move } = fixture();
    renderer.setStudies(STUDY_DEFAULTS.slice(0, 1), candles);
    expect(handles[0].setData.mock.calls[0][0]).toHaveLength(400);
    const historical = renderer.inspect(candles[1000]!.time)[0]!.values[0]!.value;
    expect(historical).toBeCloseTo(candles.slice(981, 1001).reduce((sum, bar) => sum + bar.close, 0) / 20, 9);
    move(1000, 1100);
    const data = handles[0].setData.mock.calls.at(-1)[0];
    expect(data[0].time).toBe(candles[800]!.time);
    expect(data.at(-1).time).toBe(candles[1300]!.time);
    expect(data.find((point: any) => point.time === candles[1000]!.time).value).toBeCloseTo(historical!, 10);
    move(1020, 1120);
    expect(handles[0].setData).toHaveBeenCalledTimes(2); // pan stays inside buffer
    move(0, 9999);
    expect(handles[0].setData.mock.calls.at(-1)[0]).toHaveLength(10000);
  });
  it("coalesces a stream burst but preserves every appended bar and the final revision", () => {
    const { renderer, handles, candles, frame } = fixture();
    const config = { ...STUDY_DEFAULTS[1]!, period: 3 };
    renderer.setStudies([config], candles);
    for (let i = 0; i < 10; i++) {
      candles[candles.length - 1] = { ...candles.at(-1)!, close: 105 + i / 10 };
      renderer.refreshLater(candles, candles.length - 1);
    }
    candles.push({ ...candles.at(-1)!, time: candles.at(-1)!.time + 60, close: 106 });
    renderer.refreshLater(candles, candles.length - 1);
    candles.push({ ...candles.at(-1)!, time: candles.at(-1)!.time + 60, close: 107 });
    renderer.refreshLater(candles, candles.length - 1);
    expect(handles[0].update).not.toHaveBeenCalled();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    frame();
    const expected = new StudyCalculator(config).calculate(candles);
    for (let i = 9999; i < candles.length; i++) expect(renderer.inspect(candles[i]!.time)[0]!.values[0]!.value).toBeCloseTo(expected[i]!.values[0]!, 10);
    const visible = handles[0].data;
    expect(visible.at(-1).time).toBe(candles.at(-1)!.time);
    expect(visible.at(-2).time).toBe(candles.at(-2)!.time);
  });
  it("updates historical calculations without pushing unseen streaming points into a past viewport", () => {
    const { renderer, handles, candles, frame, move } = fixture();
    renderer.setStudies(STUDY_DEFAULTS.slice(0, 1), candles);
    move(1000, 1100);
    candles[candles.length - 1] = { ...candles.at(-1)!, close: 109 };
    renderer.refreshLater(candles, 9999); frame();
    expect(handles[0].update).not.toHaveBeenCalled();
    move(9800, 10010);
    expect(handles[0].setData.mock.calls.at(-1)[0].at(-1).value).toBeCloseTo(renderer.inspect(candles.at(-1)!.time)[0]!.values[0]!.value!, 10);
  });
  it("cancels queued work when destroyed and rebuilds corrected snapshots", () => {
    const { renderer, handles, candles, frame, scale } = fixture();
    renderer.setStudies(STUDY_DEFAULTS.slice(0, 1), candles);
    renderer.refreshLater(candles, 9999);
    const corrected = candles.slice(-500).map(bar => ({ ...bar, close: 111 }));
    renderer.refresh(corrected, 0, true); frame();
    expect(renderer.inspect(corrected.at(-1)!.time)[0]!.values[0]!.value).toBe(111);
    renderer.refreshLater(corrected, 499);
    renderer.destroy(); frame();
    expect(handles[0].update).not.toHaveBeenCalled();
    expect(scale.unsubscribeVisibleLogicalRangeChange).toHaveBeenCalledTimes(1);
  });
  it("batches intermediate price-axis movement and renders only the final study window", () => {
    const {renderer,handles,candles,move}=fixture();
    renderer.setStudies(STUDY_DEFAULTS.slice(0,1),candles);
    handles[0].setData.mockClear();
    renderer.batchViewport(()=>{
      move(0,10);move(4000,4100);
      renderer.refresh(candles,9999,true);
    });
    expect(handles[0].setData).toHaveBeenCalledTimes(1);
    const rendered=handles[0].setData.mock.calls[0][0];
    expect(rendered[0].time).toBe(candles[3800]!.time);
    expect(rendered.at(-1).time).toBe(candles[4300]!.time);
    move(9000,9100);expect(handles[0].setData).toHaveBeenCalledTimes(2);
  });
  it("bounds windows at empty, first, last and out-of-range views", () => {
    expect(studyDisplayWindow(0, null, null)).toEqual({ from: 0, to: 0 });
    expect(studyDisplayWindow(10000, { from: -100, to: 100 } as any, null)).toEqual({ from: 0, to: 301 });
    expect(studyDisplayWindow(10000, { from: 9900, to: 11000 } as any, null)).toEqual({ from: 9700, to: 10000 });
    expect(studyDisplayWindow(10, null, null)).toEqual({ from: 0, to: 10 });
  });
});


describe("exact study tail reconciliation",()=>{
  for(const {defaults:config} of STUDY_CATALOG) it(`${config.kind}: all rendered channels equal a full calculation through replay and corrections`,()=>{
    const f=fixture(320);let bars=f.candles;
    f.renderer.setStudies([config],bars);
    const verify=()=>{
      const expected=new StudyCalculator(config).calculate(bars);
      for(const [channel,line] of f.handles.entries()) {
        const visible=expected.filter(point=>point.time>=line.data[0]?.time&&point.time<=line.data.at(-1)?.time);
        expect(line.data).toEqual(visible.map(point=>{
          const value=point.values[channel];
          return value==null||!Number.isFinite(value)?{time:point.time}:{time:point.time,value,
            ...(config.kind==='macd'&&channel===2?{color:value>=0?'#10b981':'#ef4444'}:{})};
        }));
        expect(line.data.length).toBe(bars.length); // full visible fixture, including whitespace
      }
    };
    verify();const original=bars;
    for(const count of [319,320,288,320,1,2,Math.max(1,config.period-1),config.period,config.period+1,320]){
      bars=original.slice(0,count);f.renderer.batchViewport(()=>{f.move(0,count+10);f.renderer.refresh(bars,0,false);});verify();
    }
    expect(f.handles.every(line=>line.pop.mock.calls.length>0)).toBe(true);
    bars=bars.map((bar,i)=>i===319?{...bar,close:105}:bar);f.renderer.refresh(bars,319,false);verify();
    bars=bars.map((bar,i)=>i===180?{...bar,close:107}:bar);f.renderer.refresh(bars,180,true);verify();
    bars=[{...bars[0]!,time:40},...bars];f.renderer.refresh(bars,0,true);verify();
    bars=[];f.renderer.refresh(bars,0,true);verify();
    bars=original.slice(0,1);f.renderer.refresh(bars,0,true);verify();
    bars=original;f.renderer.refresh(bars,0,true);verify();
    // Changed periods/config rebuild their calculators and series, not old data.
    const altered={...config,period:Math.max(2,config.period+1)};
    f.renderer.setStudies([altered],bars);
    const last=f.handles.at(-1).data.at(-1);
    const values=new StudyCalculator(altered).calculate(bars).at(-1)!.values;
    expect(last.value??null).toBe(values.at(-1)??null);
  });
  it("uses tail writes for adjacent bars without shifting the buffer, and rebuilds on actual viewport changes",()=>{
    const f=fixture();f.renderer.setStudies(STUDY_DEFAULTS.slice(0,2),f.candles);
    const start=f.handles[0].data[0].time;
    for(const n of [9999,10000])f.renderer.batchViewport(()=>{
      f.move(n-150,n+10);f.renderer.refresh(f.candles.slice(0,n),9999,false);
    });
    for(const line of f.handles){expect(line.setData).toHaveBeenCalledTimes(1);expect(line.pop).toHaveBeenCalledWith(1);expect(line.update).toHaveBeenCalledTimes(1);expect(line.data[0].time).toBe(start);}
    f.move(1000,1100);expect(f.handles[0].setData).toHaveBeenCalledTimes(2);
    f.move(0,9999);expect(f.handles[0].data).toHaveLength(10000);
  });
});


describe("Replay cache renderer ownership",()=>{
  const replay={sessionId:'one',ownerId:7,source:'deriv_public',sourceIdentity:'a'.repeat(64),symbol:'V75',timeframe:'M15'};
  it("never exposes cached future study or axis values and disposes removed/destroyed study caches",()=>{
    const f=fixture(200);f.renderer.setStudies(STUDY_DEFAULTS,f.candles);
    f.renderer.refresh(f.candles,0,true,replay);
    const owned=[...(f.renderer as any).studies];
    expect(owned.every(study=>study.calculator.replayCache.count===200)).toBe(true);
    f.renderer.batchViewport(()=>{f.move(0,10);f.renderer.refresh(f.candles.slice(0,2),2,true,replay);});
    expect(f.handles.every(line=>line.data.every((point:any)=>point.time<=f.candles[1]!.time))).toBe(true);
    expect(f.renderer.inspect(f.candles.at(-1)!.time).every(row=>row.values.every(item=>item.value===null))).toBe(true);
    expect(owned.every(study=>study.calculator.replayCache.count===200)).toBe(true);
    f.renderer.setStudies(STUDY_DEFAULTS.slice(0,1),f.candles.slice(0,2));
    expect(owned.every(study=>study.calculator.replayCache===null)).toBe(true);
    f.renderer.refresh(f.candles,0,true,replay);const current=(f.renderer as any).studies[0].calculator;
    f.renderer.destroy();expect(current.replayCache).toBeNull();
  });
});
