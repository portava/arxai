import { describe, expect, it } from "vitest";
import { chartDescriptiveStats, chartNumber, chartObservationGaps, chartChangeSummary } from "./chartDescriptiveStats";
import type { SmartChartAnalysisBar } from "./smartChartAnalysis";
const bars=(closes:number[]):SmartChartAnalysisBar[]=>closes.map((close,i)=>({time:100+i*60,closeTime:160+i*60,open:close,high:close+0.1,low:close-0.1,close,isComplete:true,isFinal:true,isForming:false}));
describe("visible price statistics",()=>{
  it("reports arithmetic descriptors and running-peak price drawdown",()=>{
    const result=chartDescriptiveStats(bars([10,20,15,12]))!;
    expect(result).toMatchObject({count:4,first:10,last:12,change:2,changePercent:20,mean:14.25,median:13.5,maxDrawdownPercent:40});
    expect(result.stdDev).toBeCloseTo(Math.sqrt(14.1875));expect(result.range).toBeCloseTo(10.2);
  });
  it("preserves small FX changes and does not confuse low prices with zero",()=>{
    const result=chartDescriptiveStats(bars([1.00001,1.00002,1.00003]))!;
    expect(result.change).toBeCloseTo(0.00002,12);expect(result.mean).toBeCloseTo(1.00002,12);
    expect(chartNumber(0.000000012345678)).toBe("1.234568e-8");
  });
  it("handles one observation or a flat series without invented variability",()=>{
    for(const values of [[1],[1,1,1]])expect(chartDescriptiveStats(bars(values))).toMatchObject({change:0,stdDev:0,maxDrawdownPercent:0,median:1});
  });
  it("refuses missing, nonfinite, nonpositive or overflowing evidence",()=>{
    for(const values of [[],[NaN],[Infinity],[0],[-1],[1e308,1]])expect(chartDescriptiveStats(bars(values))).toBeNull();
    expect(chartNumber(Infinity)).toBe("Unavailable");
  });
  it("reports elapsed observation gaps without assuming a closure or an outage",()=>{
    const data=bars([10,11,12]);expect(chartObservationGaps(data,60)).toEqual({gaps:0,largestSeconds:0});
    data[2]!.time+=120;expect(chartObservationGaps(data,60)).toEqual({gaps:1,largestSeconds:180});
    expect(chartObservationGaps(data,0)).toBeNull();expect(chartObservationGaps([...data].reverse(),60)).toBeNull();
  });
  it("keeps summary percentages concise while preserving tiny nonzero direction",()=>{
    expect(chartChangeSummary(5.503098,5.503098)).toBe("rose 5.5%");
    expect(chartChangeSummary(-4.888689,-4.888689)).toBe("fell 4.89%");
    for(const tiny of [0.00999,0.000000001,Number.MIN_VALUE]){
      expect(chartChangeSummary(tiny,tiny)).toBe("rose less than 0.01%");
      expect(chartChangeSummary(-tiny,-tiny)).toBe("fell less than 0.01%");
    }
    expect(chartChangeSummary(0.01,0.01)).toBe("rose 0.01%");
    expect(chartChangeSummary(Number.MIN_VALUE,0)).toBe("rose less than 0.01%");
    expect(chartChangeSummary(0,0)).toBe("stayed level");
    expect(chartChangeSummary(-0,-0)).toBe("stayed level");
    expect(chartChangeSummary(1,NaN)).toBe("change is unavailable");
    expect(chartChangeSummary(Infinity,1)).toBe("change is unavailable");
    expect(chartNumber(-4.888689)).toBe("-4.888689");
  });
});
