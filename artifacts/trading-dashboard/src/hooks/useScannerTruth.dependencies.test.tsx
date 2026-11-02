import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { chartCandlesQueryKey } from "@/lib/chartCandlesQuery";
import { higherTimeframeObservationKey } from "@workspace/domain/truth";
import { useScannerTruth } from "./useScannerTruth";
vi.mock("@/hooks/useCurrentUser", () => ({useCurrentUser: () => ({user:{id:7},isError:false})}));
vi.mock("@/hooks/useTradingMode", () => ({useTradingMode: () => ({isLoading:false,envelope:null})}));
vi.mock("@/hooks/useSelectedMarketSnapshot", () => ({useSelectedMarketSnapshot: () => ({data:{ok:true},isError:false})}));
vi.mock("@/lib/assistant-name", () => ({useAssistantName: () => ({name:"Eleanor"})}));
let client: QueryClient;
afterEach(() => {cleanup();client.clear();vi.unstubAllGlobals();});
const primary = {symbol:"EURUSD",timeframe:"M5",source:"provider",sourceIdentity:"a".repeat(64),closedWindowIdentity:"b".repeat(64),lastClosedCandleAt:"2026-01-01T00:00:00.000Z"};
const higher = () => ({symbol:"EURUSD",timeframe:"H1",source:"provider",aiUsable:true,candles:[],feedStatus:{symbol:"EURUSD",source:"provider",aiUsable:true,stale:false},marketEvidence:{...primary,timeframe:"H1",closedWindowIdentity:"c".repeat(64)}});
function setup(){
 client = new QueryClient({defaultOptions:{queries:{retry:false}}});
 client.setQueryData(chartCandlesQueryKey("EURUSD","M5",200),{candles:[],feedStatus:null,sourceClockQualified:false,marketEvidence:primary});
 return ({children}:{children:ReactNode}) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
it("only assessment consumers request HTF; matching consumers share it and revisions withdraw observation",async()=>{
 const wrapper=setup();let resolve!:(value:Response)=>void;
 const fetch=vi.fn((_url: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(r=>{resolve=r;}));vi.stubGlobal("fetch",fetch);
 const ordinary=renderHook(()=>useScannerTruth("EURUSD","M5"),{wrapper});
 expect(fetch).not.toHaveBeenCalled();
 const a=renderHook(()=>useScannerTruth("EURUSD","M5",{observeAssessmentDependencies:true}),{wrapper});
 const b=renderHook(()=>useScannerTruth("EURUSD","M5",{observeAssessmentDependencies:true}),{wrapper});
 expect(fetch).toHaveBeenCalledTimes(1);expect(fetch.mock.calls[0]?.[0]).toContain("timeframe=H1&limit=120&view=analysis");
 expect(a.result.current.assessmentEvidence).toBeNull();
 const response=higher();await act(async()=>resolve(new Response(JSON.stringify(response))));
 await waitFor(()=>expect(a.result.current.assessmentEvidence?.higherTimeframeObservation).toBe(higherTimeframeObservationKey("H1",response)));
 expect(b.result.current.assessmentEvidence).toEqual(a.result.current.assessmentEvidence);
 const before=a.result.current.assessmentEvidence;
 const corrected=higher();corrected.marketEvidence.closedWindowIdentity="d".repeat(64);
 act(()=>client.setQueryData(chartCandlesQueryKey("EURUSD","H1",120,"analysis"),{candles:[],feedStatus:corrected.feedStatus,originalResponse:corrected}));
 await waitFor(()=>expect(a.result.current.assessmentEvidence?.higherTimeframeObservation).not.toBe(before?.higherTimeframeObservation));
 expect(a.result.current.assessmentEvidence?.closedWindowIdentity).toBe(primary.closedWindowIdentity);
 fetch.mockRejectedValueOnce(new Error("offline"));
 await act(async()=>{await client.refetchQueries({queryKey:chartCandlesQueryKey("EURUSD","H1",120,"analysis")});});
 await waitFor(()=>expect(a.result.current.assessmentEvidence).toBeNull());
 expect(ordinary.result.current.assessmentEvidence).toBeNull();
});

it.each(["envelope market", "envelope interval", "feed market", "bar market", "bar interval", "bar source"])("withholds assessment observation after %s mismatch",async mismatch=>{
 const wrapper=setup();const response=higher();
 vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify(response))));
 const view=renderHook(()=>useScannerTruth("EURUSD","M5",{observeAssessmentDependencies:true}),{wrapper});
 await waitFor(()=>expect(view.result.current.assessmentEvidence).not.toBeNull());
 const bad:any=structuredClone(response);
 if(mismatch==="envelope market")bad.symbol="GBPUSD";
 if(mismatch==="envelope interval")bad.timeframe="M15";
 if(mismatch==="feed market")bad.feedStatus.symbol="GBPUSD";
 if(mismatch.startsWith("bar")){bad.candles=[{symbol:"EURUSD",timeframe:"H1",source:"provider"}];bad.candles[0][mismatch.split(" ")[1]==="market"?"symbol":mismatch.split(" ")[1]==="interval"?"timeframe":"source"]="different";}
 act(()=>client.setQueryData(chartCandlesQueryKey("EURUSD","H1",120,"analysis"),{candles:[],feedStatus:bad.feedStatus,originalResponse:bad}));
 await waitFor(()=>expect(view.result.current.assessmentEvidence).toBeNull());
});

it("owned unavailable HTF preserves a primary-only observation without inventing HTF evidence",async()=>{
 const wrapper=setup();const response={symbol:"EURUSD",timeframe:"H1",source:null,aiUsable:false,candles:[],marketEvidence:null,feedStatus:{symbol:"EURUSD",source:null,aiUsable:false,stale:true}};
 vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify(response))));
 const view=renderHook(()=>useScannerTruth("EURUSD","M5",{observeAssessmentDependencies:true}),{wrapper});
 await waitFor(()=>expect(view.result.current.assessmentEvidence?.higherTimeframeObservation).toBe(higherTimeframeObservationKey("H1",response)));
});
