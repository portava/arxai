import { describe, expect, it } from "vitest";
import { captureChartReplay } from "./chartReplay";
import { captureReplayAnalysisPrefix } from "./chartReplayAnalysis";
import { analyzeSmartChart } from "./smartChartAnalysis";
import { DEFAULT_PREFERENCES } from "./chartWorkspace";
import { replayResponse, NOW } from "@/components/chart-replay/replayFixture";

function snapshot(){return captureChartReplay(replayResponse(80),7,DEFAULT_PREFERENCES,NOW).snapshot!;}
describe("source-bound replay analysis prefix",()=>{
  it("uses the installed close as its observation time and retains original identity",()=>{
    const s=snapshot(),r=captureReplayAnalysisPrefix({snapshot:s,installedCount:20},s);
    expect(r.status).toBe("ready");expect(r.bars).toHaveLength(20);
    expect(r.asOfMs).toBe(s.bars[19]!.closeTime*1000);expect(r.replayCutoff).toBe(s.bars[19]!.closeTime);
    expect(r.asOfMs).not.toBe(s.lastClosedAt*1000);expect(r.context.sourceIdentity).toBe(s.sourceIdentity);
  });
  it.each([0,-1,1.5,81,NaN,Infinity])("refuses an unacknowledged cursor %s",installedCount=>{
    const s=snapshot(),r=captureReplayAnalysisPrefix({snapshot:s,installedCount},s);
    expect(r.status).toBe("unavailable");expect(r.bars).toEqual([]);expect(r.asOfMs).toBeNull();
  });
  it("never reads future OHLC, even when the unrevealed tail is hostile",()=>{
    const s=snapshot();const hostile={...s,bars:s.bars.map((b,i)=>i>=20?Object.defineProperty({...b},"close",{get(){throw Error("future candle accessed");}}):b)};
    const r=captureReplayAnalysisPrefix({snapshot:hostile,installedCount:20},s);
    expect(r.status).toBe("ready");expect(r.bars).toHaveLength(20);
  });
  it("all actual pattern outputs equal a physically truncated snapshot",()=>{
    const s=snapshot();
    for(const count of [1,2,19,20,40,79,80,5,30]){
      const r=captureReplayAnalysisPrefix({snapshot:s,installedCount:count},s);
      const truncated={...s,bars:s.bars.slice(0,count),lastClosedAt:s.bars[count-1]!.closeTime};
      const expected=captureReplayAnalysisPrefix({snapshot:truncated,installedCount:count},s);
      const analyze=(x:typeof r)=>analyzeSmartChart({...x.context,bars:x.bars,asOfMs:x.asOfMs!,replayCutoff:x.replayCutoff!,dataState:"historical"});
      expect(analyze(r)).toEqual(analyze(expected));
      expect(analyze(r).allFindings.every(f=>f.asOf<=s.bars[count-1]!.closeTime && f.anchors.every(a=>a.time<=s.bars[count-1]!.time))).toBe(true);
    }
  });
  it("rejects different chart ownership and missing source identity",()=>{
    const s=snapshot();expect(captureReplayAnalysisPrefix({snapshot:s,installedCount:20},{symbol:"EURUSD",timeframe:s.timeframe}).status).toBe("unavailable");
    expect(captureReplayAnalysisPrefix({snapshot:{...s,sourceIdentity:""},installedCount:20},s).status).toBe("unavailable");
  });
});
