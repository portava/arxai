import { afterEach, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { masterAccountEvidence, useMasterAccountEvidence } from "./useMasterAccountEvidence";
const now=1_800_000_000_000;
const source=(extra:Record<string,unknown>={})=>({lastMt5SnapshotAt:new Date(now).toISOString(),snapshotAgeMs:0,snapshotStatus:"FRESH",syncStatus:"LIVE",...extra});
afterEach(()=>vi.useRealTimers());
it.each([[0,'live'],[5000,'live'],[5001,'fresh'],[30000,'fresh'],[30001,'delayed'],[60000,'delayed'],[60001,'stale']])('ages the report at shared policy boundary %s',(age,expected)=>{
 expect(masterAccountEvidence(source(),now+Number(age),Number(age),0,false).freshness).toBe(expected);
});
it.each([null,'invalid','2027-01-15T08:00:00',new Date(now+1000).toISOString()])('does not certify absent/invalid/future timestamp %s',stamp=>{
 expect(masterAccountEvidence(source({lastMt5SnapshotAt:stamp}),now,0,0,false).freshness).toBe('unavailable');
});
it.each([-1,Infinity,NaN])('invalid server age %s cannot become fresh',age=>{
 expect(masterAccountEvidence(source({snapshotAgeMs:age}),now,0,0,false).freshness).toBe('unavailable');
});
it.each([{snapshotStatus:'STALE'},{syncStatus:'STALE'}])('retains a server stale verdict %j',extra=>{
 expect(masterAccountEvidence(source(extra),now,0,0,false).freshness).toBe('stale');
});
it.each([{snapshotStatus:'MISSING'},{syncStatus:'UNAVAILABLE'},{snapshotStatus:'unknown'}])('does not upgrade a missing/unknown verdict %j',extra=>{
 expect(masterAccountEvidence(source(extra),now,0,0,false).freshness).toBe('unavailable');
});
it('uses the greatest observed age and preserves evidence on query failure',()=>{
 const data=source({snapshotAgeMs:45000}),before=JSON.stringify(data);
 const result=masterAccountEvidence(data,now+1000,0,0,true);
 expect(result).toMatchObject({ageMs:45000,observedAtMs:now,freshness:'unavailable'});expect(JSON.stringify(data)).toBe(before);
});
it('expires without a fetch and does not renew unchanged evidence on HTTP success',()=>{
 vi.useFakeTimers();vi.setSystemTime(now);
 const {result,rerender,unmount}=renderHook(({value})=>useMasterAccountEvidence(value,false),{initialProps:{value:source()}});
 expect(result.current.freshness).toBe('live');expect(vi.getTimerCount()).toBe(1);
 act(()=>vi.advanceTimersByTime(60001));expect(result.current.freshness).toBe('stale');
 rerender({value:source()});expect(result.current.freshness).toBe('stale');expect(result.current.ageMs).toBeGreaterThanOrEqual(60001);
 unmount();expect(vi.getTimerCount()).toBe(0);
});
it('server stale cannot rejuvenate on a repeated timestamp',()=>{
 vi.useFakeTimers();vi.setSystemTime(now);
 const {result,rerender}=renderHook(({value})=>useMasterAccountEvidence(value,false),{initialProps:{value:source({snapshotStatus:'STALE'})}});
 expect(result.current.freshness).toBe('stale');rerender({value:source()});expect(result.current.freshness).toBe('stale');
});
it('backward wall-clock change cannot rejuvenate retained evidence',()=>{
 vi.useFakeTimers();vi.setSystemTime(now);
 const {result,rerender}=renderHook(({value})=>useMasterAccountEvidence(value,false),{initialProps:{value:source()}});
 act(()=>vi.advanceTimersByTime(31000));expect(result.current.freshness).toBe('delayed');
 vi.setSystemTime(now+1);rerender({value:source()});expect(result.current.freshness).toBe('delayed');
});
it('visibility restoration accounts for sleep and a new timestamp allows a new observation',()=>{
 vi.useFakeTimers();vi.setSystemTime(now);
 const {result,rerender,unmount}=renderHook(({value})=>useMasterAccountEvidence(value,false),{initialProps:{value:source()}});
 vi.setSystemTime(now+180000);act(()=>document.dispatchEvent(new Event('visibilitychange')));expect(result.current.freshness).toBe('stale');
 rerender({value:source({lastMt5SnapshotAt:new Date(now+180000).toISOString()})});expect(result.current.freshness).toBe('live');
 unmount();expect(vi.getTimerCount()).toBe(0);
});
