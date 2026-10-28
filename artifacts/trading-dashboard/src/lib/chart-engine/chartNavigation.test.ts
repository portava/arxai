import { describe, expect, it } from "vitest";
import { panChartWindow, zoomChartWindow } from "./chartNavigation";

describe("loaded chart navigation", () => {
  it("zooms around the current historical view instead of jumping to the newest price", () => {
    expect(zoomChartWindow({from:100,to:180},0.75,5000)).toEqual({from:110,to:170});
    expect(zoomChartWindow({from:110,to:170},4/3,5000)).toEqual({from:100,to:180});
  });
  it("pans a quarter window and preserves scale until a loaded boundary", () => {
    expect(panChartWindow({from:100,to:180},-0.25,5000)).toEqual({from:80,to:160});
    expect(panChartWindow({from:100,to:180},0.25,5000)).toEqual({from:120,to:200});
    expect(panChartWindow({from:0,to:80},-1,100)).toEqual({from:-3,to:77});
    expect(panChartWindow({from:20,to:100},1,100)).toEqual({from:22,to:102});
  });
  it("retains at least four bar slots and cannot zoom out into an unbounded empty chart", () => {
    const close=zoomChartWindow({from:100,to:104},0.1,5000)!;
    expect(close.to-close.from).toBe(4);
    const wide=zoomChartWindow({from:0,to:99},4,100)!;
    expect(wide).toEqual({from:-3,to:102});
    expect(zoomChartWindow({from:0,to:20},0.5,1)).toEqual({from:-3,to:3});
  });
  it("refuses missing history and invalid navigation without returning fabricated ranges", () => {
    for(const count of [0,-1,NaN,Infinity,1.5]) expect(panChartWindow({from:0,to:30},0.25,count)).toBeNull();
    for(const range of [null,{from:NaN,to:20},{from:20,to:20},{from:30,to:20}]) expect(zoomChartWindow(range,0.75,50)).toBeNull();
    for(const factor of [0,-1,NaN,Infinity,5]) expect(zoomChartWindow({from:0,to:30},factor,50)).toBeNull();
  });
});
