import { afterEach, describe, expect, it, vi } from "vitest";
import { drawingSegments, drawingStorageKey, PREFERENCES_KEY, readChartStorage, validateDrawings, validatePreferences, writeChartStorage } from "./chartWorkspace";
import { STUDY_DEFAULTS } from "./chartStudies";
afterEach(()=>vi.restoreAllMocks());
describe("bounded chart workspace persistence",()=>{
  it("rejects bad settings without allowing unbounded study work",()=>{
    expect(validatePreferences({style:"random",scale:"bad",studies:[{...STUDY_DEFAULTS[0],period:1e9},STUDY_DEFAULTS[1],STUDY_DEFAULTS[1],{...STUDY_DEFAULTS[4],slow:2}]})).toEqual({style:"candles",scale:"linear",studies:[STUDY_DEFAULTS[1]]});
    expect(validatePreferences({studies:STUDY_DEFAULTS}).studies).toHaveLength(5);
  });
  it("migrates legacy studies and keeps distinct repeated instances while rejecting duplicate IDs", () => {
    const first = {...STUDY_DEFAULTS[1], id:"ema-20", period:20, source:"hl2"};
    const second = {...STUDY_DEFAULTS[1], id:"ema-200", period:200};
    expect(validatePreferences({studies:[first, second, first]}).studies).toEqual([first, second]);
    expect(validatePreferences({studies:[{...first,id:"<script>"},{...first,source:"volume"},{...first,period:0}]}).studies).toEqual([]);
    const many = Array.from({length:100}, (_, i) => ({...first,id:`ema-${i}`}));
    expect(validatePreferences({studies:many}).studies).toHaveLength(12);
    expect(validatePreferences({studies:[{...STUDY_DEFAULTS[4],signalMethod:"sma"}]}).studies[0]?.signalMethod).toBe("sma");
    expect(validatePreferences({studies:[{...STUDY_DEFAULTS[4],signalMethod:"invalid"}]}).studies).toEqual([]);
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
  it("keeps an allowlisted display zone and drops UTC, invalid and missing zones to the legacy shape",()=>{
    expect(validatePreferences({style:"bars",scale:"log",studies:[],timeZone:"Asia/Tokyo"}).timeZone).toBe("Asia/Tokyo");
    expect(validatePreferences({studies:[],timeZone:"local"}).timeZone).toBe("local");
    for (const timeZone of ["UTC","utc","Mars/Olympus","Etc/GMT+5","../x",5,null,undefined]) {
      const result=validatePreferences({style:"bars",scale:"log",studies:[],timeZone});
      expect(result).toEqual({style:"bars",scale:"log",studies:[]});
      expect(Object.hasOwn(result,"timeZone")).toBe(false);
    }
    writeChartStorage("zone-roundtrip",validatePreferences({studies:[],timeZone:"America/New_York"}));
    expect(validatePreferences(readChartStorage("zone-roundtrip")).timeZone).toBe("America/New_York");
  });
  it("seeds a new comparison view from the primary's zone and lets it diverge",()=>{
    const compKey=`${PREFERENCES_KEY}:comparison`;
    writeChartStorage(PREFERENCES_KEY,{style:"candles",scale:"linear",studies:[],timeZone:"Asia/Tokyo"});
    // ARXNativeChart: validatePreferences(readChartStorage(key) ?? readChartStorage(PREFERENCES_KEY)).
    const seeded=validatePreferences(readChartStorage(compKey) ?? readChartStorage(PREFERENCES_KEY));
    expect(seeded.timeZone).toBe("Asia/Tokyo");
    writeChartStorage(compKey,{...seeded,timeZone:"Europe/London"});
    expect(validatePreferences(readChartStorage(compKey) ?? readChartStorage(PREFERENCES_KEY)).timeZone).toBe("Europe/London");
    expect(validatePreferences(readChartStorage(PREFERENCES_KEY)).timeZone).toBe("Asia/Tokyo");
  });
  it("handles corrupt data, oversized data and denied storage",()=>{
    localStorage.setItem("bad","{");expect(readChartStorage("bad")).toBeNull();
    localStorage.setItem("big",JSON.stringify("x".repeat(100_001)));expect(readChartStorage("big")).toBeNull();
    vi.spyOn(Storage.prototype,"getItem").mockImplementation(()=>{throw Error("denied");});
    vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw Error("quota");});
    expect(readChartStorage("any")).toBeNull();expect(writeChartStorage("any",[])).toBe(false);
  });
});
