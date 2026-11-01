import {describe,it,expect} from "vitest";
import {chartUtcClockQualified,formatSourceChartTime,originalUtcAuthority} from "./chartClockEvidence";
const utc={kind:"original_utc",basis:"UTC",authority:"offline:controlled-utc-fixture",reason:null};
describe("clock evidence presentation",()=>{
 it("never infers UTC from absent metadata or a superficially valid declaration",()=>{
  expect(chartUtcClockQualified([])).toBe(false);
  for(const evidence of [undefined,{}, {...utc,kind:"unavailable"},{...utc,authority:" "},{...utc,reason:"not verified"},{...utc,basis:"BROKER_SERVER"}])
   expect(chartUtcClockQualified([{timeBasisEvidence:evidence}])).toBe(false);
 });
 it("requires one unchanged original authority across the displayed data",()=>{
  expect(chartUtcClockQualified([{timeBasisEvidence:utc},{timeBasisEvidence:utc}])).toBe(true);
  expect(chartUtcClockQualified([{timeBasisEvidence:utc},{timeBasisEvidence:{...utc,authority:"other"}}])).toBe(false);
  expect(originalUtcAuthority({...utc,authority:"x".repeat(129)})).toBeNull();
 });
 it("retains source-clock coordinates without applying the requested display-zone offset",()=>{
  expect(formatSourceChartTime(0,false,"Asia/Tokyo")).toBe("1970-01-01 00:00 source clock (UTC unverified)");
  expect(formatSourceChartTime(0,true,"Asia/Tokyo")).toContain("09:00");
 });
});
