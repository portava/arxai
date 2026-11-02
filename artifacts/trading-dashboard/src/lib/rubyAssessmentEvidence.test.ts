import { describe, it, expect } from "vitest";
import { rubyAssessmentEvidenceKey, matchesRubyAssessmentEvidence } from "./rubyAssessmentEvidence";
import { validateRubyChartRead } from "./rubyChartReadResponse";
const evidence={symbol:"EURUSD",timeframe:"M5",source:"deriv_public",sourceIdentity:"a".repeat(64),lastClosedCandleAt:"2026-01-01T00:00:00.000Z",userId:7};
const read={symbol:"EURUSD",timeframe:"M5",gated:false,bias:"Bearish",readLayer:"FULL",liveSetupWithheld:false,canShowLiveTradeSetup:true,assessmentEvidence:evidence};
describe("captured assessment identity",()=>{
  it("accepts equivalent interval spellings without using object identity",()=>{
    expect(matchesRubyAssessmentEvidence(evidence,{...evidence,timeframe:"5m"})).toBe(true);
    expect(validateRubyChartRead(read,{symbol:"EURUSD",timeframe:"5m"},{...evidence})).toEqual(read);
  });
  it.each([undefined,null,{},[],{...evidence,userId:null},{...evidence,userId:0},{...evidence,userId:7.2},{...evidence,sourceIdentity:"guessed"},{...evidence,lastClosedCandleAt:"bad"},{...evidence,lastClosedCandleAt:"2999-01-01T00:00:00.000Z"}])("rejects absent or malformed positive response evidence %j", invalid=>{
    expect(()=>validateRubyChartRead({...read,assessmentEvidence:invalid},read,evidence)).toThrow();
    expect(rubyAssessmentEvidenceKey(invalid)).toBeNull();
  });
  it.each([null,{...evidence,userId:8},{...evidence,source:"mt5_broker"},{...evidence,sourceIdentity:"b".repeat(64)},{...evidence,lastClosedCandleAt:"2026-01-01T00:05:00.000Z"}])("cannot pass a different current observation %j", current=>{
    expect(()=>validateRubyChartRead(read,read,current)).toThrow();
  });
  it("rejects evidence for another market even if response labels match",()=>{
    expect(()=>validateRubyChartRead({...read,assessmentEvidence:{...evidence,symbol:"GBPUSD"}},read)).toThrow();
  });
  it("accepts a conservative refusal without evidence",()=>{
    const refusal={symbol:"EURUSD",timeframe:"M5",gated:true,headline:"Cannot verify chart"};
    expect(validateRubyChartRead(refusal,read,null)).toEqual(refusal);
  });
});
