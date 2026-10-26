import { afterEach, describe, expect, it, vi } from "vitest";
import { drawingSegments, drawingStorageKey, readChartStorage, validateDrawings, validatePreferences, writeChartStorage } from "./chartWorkspace";
import { STUDY_DEFAULTS } from "./chartStudies";
afterEach(()=>vi.restoreAllMocks());
describe("bounded chart workspace persistence",()=>{
  it("rejects bad settings without allowing unbounded study work",()=>{
    expect(validatePreferences({style:"random",scale:"bad",studies:[{...STUDY_DEFAULTS[0],period:1e9},STUDY_DEFAULTS[1],STUDY_DEFAULTS[1],{...STUDY_DEFAULTS[4],slow:2}]})).toEqual({style:"candles",scale:"linear",studies:[STUDY_DEFAULTS[1]]});
    expect(validatePreferences({studies:STUDY_DEFAULTS}).studies).toHaveLength(5);
  });
  it("rejects malformed/duplicate geometry and keeps exact per-instrument/timeframe anchors",()=>{
    const drawing={id:"one",kind:"trend",start:{time:100,price:1},end:{time:200,price:2},color:"#ffffff"};
    expect(validateDrawings([drawing,drawing,{...drawing,id:"bad",end:{time:100,price:2}},{...drawing,id:"bad2",start:{time:100,price:NaN}}])).toEqual([drawing]);
    expect(drawingStorageKey("EURUSD","M15")).not.toBe(drawingStorageKey("XAUUSD","M15"));
    expect(drawingStorageKey("EURUSD","M15")).not.toBe(drawingStorageKey("EURUSD","H1"));
  });
  it("constructs direction-aware Fibonacci levels with no fabricated time anchors",()=>{
    const segments=drawingSegments({id:"fib",kind:"fibonacci",start:{time:200,price:20},end:{time:100,price:10},color:"#ffffff"});
    expect(segments).toHaveLength(7);expect(segments[4]!.start.price).toBeCloseTo(13.82);
    expect(segments.every(s=>s.start.time===200&&s.end.time===100&&s.start.price===s.end.price)).toBe(true);
  });
  it("handles corrupt data, oversized data and denied storage",()=>{
    localStorage.setItem("bad","{");expect(readChartStorage("bad")).toBeNull();
    localStorage.setItem("big",JSON.stringify("x".repeat(100_001)));expect(readChartStorage("big")).toBeNull();
    vi.spyOn(Storage.prototype,"getItem").mockImplementation(()=>{throw Error("denied");});
    vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw Error("quota");});
    expect(readChartStorage("any")).toBeNull();expect(writeChartStorage("any",[])).toBe(false);
  });
});
