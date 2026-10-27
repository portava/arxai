import { describe,it,expect } from "vitest";
import { CANDLE_DEFINITIONS } from "@workspace/domain/chart-patterns";
import { CANDLE_FIXTURES } from "../../../../../lib/domain/src/chart-patterns/__qa__/candlestickFixtures";
import { analyzeSmartChart } from "./smartChartAnalysis";
import { CANDLE_MEANINGS,smartChartNarrative } from "./smartChartNarrative";
describe("plain-language observed geometry",()=>{
 it("covers exactly the implemented catalogue without implying the pending inventory is available",()=>{
  expect(Object.keys(CANDLE_MEANINGS).sort()).toEqual(CANDLE_DEFINITIONS.map(d=>d.id).sort());
  expect(Object.isFrozen(CANDLE_MEANINGS)).toBe(true);
 });
 for(const fixture of CANDLE_FIXTURES)it(`${fixture.id} keeps its numbers in details and its actual geometry in front`,()=>{
  const bars=fixture.bars,result=analyzeSmartChart({symbol:"EURUSD",timeframe:"M5",source:"mt5_broker",sourceIdentity:"a".repeat(64),bars,asOfMs:bars.at(-1)!.closeTime*1000});
  const finding=result.allFindings.find(f=>f.id===`${fixture.id}:${bars.at(-1)!.time}`)!;
  const narrative=smartChartNarrative(finding);
  expect(narrative.summary).toBe(CANDLE_MEANINGS[fixture.id]);expect(narrative.detail).toBe(finding.explanation);
  expect(narrative.summary).not.toMatch(/\bwill\b|\bbuy\b|\bsell\b|\bprobability\b|\bconfiden\w*\b|buyers|sellers/i);
  expect(narrative.summary.length).toBeLessThan(260);
  const failed={...finding,status:"invalidated" as const,explanation:"A later close invalidated the conditions."};
  expect(smartChartNarrative(failed)).toEqual({summary:failed.explanation,detail:null});
 });
 it("does not replace an unknown or confirmed detector's causal explanation",()=>{
  const finding={id:"head_and_shoulders:10",status:"developing" as const,explanation:"A right shoulder is still developing."} as Parameters<typeof smartChartNarrative>[0];
  expect(smartChartNarrative(finding)).toEqual({summary:finding.explanation,detail:null});
 });
});
