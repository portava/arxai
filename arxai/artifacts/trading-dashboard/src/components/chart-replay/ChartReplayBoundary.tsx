import { lazy, Suspense, useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { RouteAccessGuard } from "@/components/layout/RouteAccessGuard";
import { RouteErrorBoundary } from "@/components/layout/RouteErrorBoundary";
import { captureChartReplay, replayDrawingKey, replayExitUrl, type ChartReplaySnapshot } from "@/lib/chart-engine/chartReplay";
import { ChartReplayContext } from "./ChartReplayContext";
import type { ChartCandlesResponse } from "@workspace/api-client-react";
import type { ChartPreferences } from "@/lib/chart-engine/chartWorkspace";
const ChartReplayPlayer = lazy(() => import("./ChartReplayPlayer"));
const base = (import.meta.env.BASE_URL || "/").replace(/\/$/,"");

/** This boundary is inside AuthGate and outside AppLayout. Entering replay
 * unmounts all current trading panels, quotes, Truth and SSE subscribers. */
export function ChartReplayBoundary({children}:{children:ReactNode}) {
  const [location,setLocation]=useLocation();
  const {user}=useCurrentUser();
  const [snapshot,setSnapshot]=useState<ChartReplaySnapshot|null>(null);
  const exitPath=useRef("/live-chart");
  const entered=useRef(false);
  const replayPath=location.split(/[?#]/)[0].replace(/\/$/,"")==="/chart-replay";
  const current=snapshot?.ownerId===user?.id ? snapshot : null;
  const open=useCallback((data:ChartCandlesResponse|undefined,preferences:ChartPreferences,expected:{symbol:string;timeframe:string})=>{
    const captured=captureChartReplay(data,user?.id ?? 0,preferences,Date.now(),expected);
    if (!captured.snapshot) return captured.error;
    exitPath.current=location.startsWith("/market-scanner") ? "/market-scanner" : "/live-chart";
    setSnapshot(captured.snapshot); setLocation("/chart-replay"); return null;
  },[user?.id,location,setLocation]);
  useLayoutEffect(()=>{
    if (snapshot && !current) setSnapshot(null);
  },[snapshot,current]);
  useLayoutEffect(()=>()=>{
    if(snapshot)try{localStorage.removeItem(replayDrawingKey(snapshot));}catch{/* optional local annotations */}
  },[snapshot]);
  // Browser Back/forward and explicit exit both cross a document boundary.
  // Never briefly remount live panels against pre-replay React Query caches.
  const leaving=entered.current && !replayPath;
  useLayoutEffect(()=>{
    if(replayPath)entered.current=true;
    else if(leaving)window.location.replace(replayExitUrl(location,base,window.location.origin));
  },[replayPath,leaving,location]);
  const exit=()=>window.location.replace(replayExitUrl(exitPath.current,base,window.location.origin));
  if (leaving) return <p className="p-6" role="status">Loading current market data…</p>;
  return <ChartReplayContext.Provider value={{open}}>{replayPath
    ? <RouteAccessGuard><RouteErrorBoundary><Suspense fallback={<p className="p-6" role="status">Opening historical replay…</p>}>
        {current ? <ChartReplayPlayer key={current.id} snapshot={current} onExit={exit}/>
          : <main className="mx-auto max-w-xl space-y-4 p-6"><h1 className="text-xl font-semibold">Replay unavailable</h1><p>This private snapshot is no longer available. Open a source-identified chart to start a new replay.</p><button className="rounded border px-3 py-2" onClick={exit}>Return to current chart</button></main>}
      </Suspense></RouteErrorBoundary></RouteAccessGuard>
    : children}</ChartReplayContext.Provider>;
}
