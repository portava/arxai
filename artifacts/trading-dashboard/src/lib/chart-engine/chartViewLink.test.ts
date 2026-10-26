import { describe, expect, it, vi } from "vitest";
import { candleAtLinkedTime, ChartViewLink, type ChartViewEvent } from "./chartViewLink";
import type { ChartEngineAdapter } from "./types";
function participant() {
  let handler: ((event:ChartViewEvent)=>void) | null = null;
  const adapter = {
    setViewLinkHandler: (next:typeof handler) => {handler=next;},
    setLinkedCrosshair: vi.fn((time:number|null) => handler?.({kind:"crosshair",time})),
    setLinkedTimeRange: vi.fn((range:any) => range && handler?.({kind:"range",range})),
  } as unknown as ChartEngineAdapter;
  return {adapter,publish:(event:ChartViewEvent)=>handler?.(event)};
}
describe("workspace-local chart links",()=>{
  it("links four participants without reflecting to sender or creating synchronous feedback",()=>{
    const bus=new ChartViewLink(), peers=Array.from({length:4},participant);
    peers.forEach((peer,i)=>bus.register(String(i),peer.adapter));
    bus.configure({crosshair:true,range:true});
    peers[0]!.publish({kind:"crosshair",time:1234});
    expect(peers[0]!.adapter.setLinkedCrosshair).not.toHaveBeenCalled();
    peers.slice(1).forEach(peer=>expect(peer.adapter.setLinkedCrosshair).toHaveBeenCalledExactlyOnceWith(1234));
    peers[2]!.publish({kind:"range",range:{from:1000,to:2000}});
    expect(peers[2]!.adapter.setLinkedTimeRange).not.toHaveBeenCalled();
    [peers[0],peers[1],peers[3]].forEach(peer=>expect(peer!.adapter.setLinkedTimeRange).toHaveBeenCalledExactlyOnceWith({from:1000,to:2000}));
  });
  it("does not leak to another workspace; disables/cleans links and handles adapter replacement",()=>{
    const bus=new ChartViewLink(), other=new ChartViewLink(), a=participant(), b=participant(), c=participant();
    const remove=bus.register("primary",a.adapter);bus.register("comparison",b.adapter);other.register("primary",c.adapter);
    bus.configure({crosshair:true,range:true});a.publish({kind:"range",range:{from:100,to:200}});
    const replacement=participant();bus.register("primary",replacement.adapter);remove();
    expect(replacement.adapter.setLinkedTimeRange).toHaveBeenCalledWith({from:100,to:200});
    replacement.publish({kind:"crosshair",time:150});expect(b.adapter.setLinkedCrosshair).toHaveBeenCalledWith(150);expect(c.adapter.setLinkedCrosshair).not.toHaveBeenCalled();
    bus.configure({crosshair:false,range:false});vi.mocked(b.adapter.setLinkedCrosshair!).mockClear();
    replacement.publish({kind:"crosshair",time:160});a.publish({kind:"crosshair",time:170});expect(b.adapter.setLinkedCrosshair).not.toHaveBeenCalled();
    expect(b.adapter.setLinkedTimeRange).toHaveBeenLastCalledWith(null);
    const fresh=participant();bus.register("new",fresh.adapter);expect(fresh.adapter.setLinkedTimeRange).not.toHaveBeenCalled();
  });
  it("rejects malformed timestamps and ranges",()=>{
    const bus=new ChartViewLink(),a=participant(),b=participant();bus.register("a",a.adapter);bus.register("b",b.adapter);bus.configure({crosshair:true,range:true});
    for(const time of [NaN,Infinity,-1,0])a.publish({kind:"crosshair",time});
    for(const range of [{from:200,to:100},{from:100,to:100},{from:NaN,to:200},{from:0,to:200}])a.publish({kind:"range",range});
    expect(b.adapter.setLinkedCrosshair).not.toHaveBeenCalled();expect(b.adapter.setLinkedTimeRange).not.toHaveBeenCalled();
    a.publish({kind:"crosshair",time:null});expect(b.adapter.setLinkedCrosshair).toHaveBeenCalledWith(null);
  });
  it("aligns unequal intervals using actual bar opens and refuses gaps / outside history",()=>{
    const bars=[1000,1060,1120,5000].map(time=>({time,open:1,high:2,low:1,close:1.5}));
    expect(candleAtLinkedTime(bars,1119,60)?.time).toBe(1060);
    expect(candleAtLinkedTime(bars,1120,60)?.time).toBe(1120);
    for(const time of [999,1180,4999,5060,NaN])expect(candleAtLinkedTime(bars,time,60)).toBeNull();
    expect(candleAtLinkedTime(bars,1119,0)).toBeNull();
  });
});
