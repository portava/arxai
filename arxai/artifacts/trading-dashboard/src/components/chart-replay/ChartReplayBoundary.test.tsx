import { useContext, useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChartReplayBoundary } from "./ChartReplayBoundary";
import { ChartReplayContext } from "./ChartReplayContext";
import { replayResponse } from "./replayFixture";
import { DEFAULT_PREFERENCES } from "@/lib/chart-engine/chartWorkspace";
import { isInvestorAllowedPath, isNormalUserAllowedPath, isPendingTraderAllowedPath } from "@/lib/routeAccess";
const h=vi.hoisted(()=>({path:"/live-chart",listeners:new Set<()=>void>(),user:{id:7,role:"USER"} as {id:number;role:string}|null,approved:true,unmount:vi.fn()}));
function navigate(path:string){h.path=path;h.listeners.forEach(listener=>listener());}
vi.mock("wouter",async()=>{
 const {useSyncExternalStore}=await import("react");return{useLocation:()=>[useSyncExternalStore(listener=>{h.listeners.add(listener);return()=>{h.listeners.delete(listener);};},()=>h.path),navigate]};
});
vi.mock("@/hooks/useCurrentUser",()=>({useCurrentUser:()=>({user:h.user,isLoading:false})}));
vi.mock("@/hooks/useViewMode",()=>({useViewMode:()=>({realIsAdmin:h.user?.role==="ADMIN",effectiveIsAdmin:h.user?.role==="ADMIN",canToggle:false})}));
vi.mock("@/hooks/useProductRole",()=>({useProductRole:()=>({isInvestor:h.user?.role==="INVESTOR"})}));
vi.mock("@/hooks/useTraderTier",()=>({useTraderTier:()=>({isLoading:false,isApprovedTrader:h.approved})}));
vi.mock("./ChartReplayPlayer",()=>({default:({snapshot}:any)=><div data-testid="private-player">{snapshot.symbol}:{snapshot.ownerId}</div>}));
function LiveSurfaces(){const replay=useContext(ChartReplayContext);useEffect(()=>()=>h.unmount(),[]);return<div data-testid="live-surfaces"><p>Current positions / ticket / Truth / price</p><button onClick={()=>replay?.open(replayResponse(),DEFAULT_PREFERENCES,{symbol:"V75",timeframe:"M15"})}>Replay</button></div>;}
beforeEach(()=>{h.path="/live-chart";h.user={id:7,role:"USER"};h.approved=true;h.unmount.mockClear();});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
describe("replay authentication and current-surface isolation",()=>{
 it("unmounts the live shell before rendering the private historical player",async()=>{
  render(<ChartReplayBoundary><LiveSurfaces/></ChartReplayBoundary>);fireEvent.click(screen.getByText("Replay"));
  await screen.findByTestId("private-player");expect(screen.queryByTestId("live-surfaces")).toBeNull();expect(h.unmount).toHaveBeenCalledOnce();
 });
 it("actor changes synchronously mask the prior owner snapshot",async()=>{
  const view=render(<ChartReplayBoundary><LiveSurfaces/></ChartReplayBoundary>);fireEvent.click(screen.getByText("Replay"));await screen.findByTestId("private-player");
  h.user={id:8,role:"USER"};view.rerender(<ChartReplayBoundary><LiveSurfaces/></ChartReplayBoundary>);
  expect(screen.queryByTestId("private-player")).toBeNull();expect(screen.getByText("Replay unavailable")).toBeTruthy();
  h.user={id:7,role:"USER"};view.rerender(<ChartReplayBoundary><LiveSurfaces/></ChartReplayBoundary>);expect(screen.queryByTestId("private-player")).toBeNull();
 });
 it("a direct/reloaded replay route has no reconstructable data",()=>{
  h.path="/chart-replay";render(<ChartReplayBoundary><LiveSurfaces/></ChartReplayBoundary>);
  expect(screen.getByText("Replay unavailable")).toBeTruthy();expect(screen.queryByTestId("live-surfaces")).toBeNull();expect(screen.queryByTestId("private-player")).toBeNull();
 });
 it("preserves approved, pending and investor containment on the actual route guard",async()=>{
  expect(isNormalUserAllowedPath("/chart-replay")).toBe(true);expect(isPendingTraderAllowedPath("/chart-replay")).toBe(false);expect(isInvestorAllowedPath("/chart-replay")).toBe(false);
  h.path="/chart-replay";h.approved=false;render(<ChartReplayBoundary><LiveSurfaces/></ChartReplayBoundary>);
  expect(screen.queryByText("Replay unavailable")).toBeNull();await waitFor(()=>expect(h.path).toBe("/"));
 });
 it("browser Back withholds all cached live surfaces until a fresh document loads",async()=>{
  vi.spyOn(console,"error").mockImplementation(()=>{});render(<ChartReplayBoundary><LiveSurfaces/></ChartReplayBoundary>);
  fireEvent.click(screen.getByText("Replay"));await screen.findByTestId("private-player");act(()=>navigate("/live-chart"));
  expect(screen.getByText("Loading current market data…")).toBeTruthy();expect(screen.queryByTestId("live-surfaces")).toBeNull();
 });
});
