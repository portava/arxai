import { describe, expect, it, vi, afterEach } from "vitest";
import { createResearchRunner, type ResearchWorkerPort } from "./researchRunner";
import type { ResearchV2Config, ResearchV2Input } from "@workspace/domain/backtest/research-core";
const input = {} as ResearchV2Input, config = {} as ResearchV2Config;
function port(): ResearchWorkerPort { return { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null, onmessageerror: null }; }
afterEach(() => vi.useRealTimers());
describe("isolated chart research runner", () => {
  it("terminates a replaced run and ignores even its already queued callback", () => {
    const a = port(), b = port(), receive = vi.fn();
    const factory = vi.fn().mockReturnValueOnce(a).mockReturnValueOnce(b);
    const runner = createResearchRunner(factory);
    runner.run(input, config, receive);
    const late = a.onmessage!, first = vi.mocked(a.postMessage).mock.calls[0]![0] as {id:number};
    runner.run(input, config, receive);
    late({ data: {id:first.id,result:{old:true}} } as MessageEvent);
    expect(receive).not.toHaveBeenCalled(); expect(a.terminate).toHaveBeenCalledOnce();
    const second = vi.mocked(b.postMessage).mock.calls[0]![0] as {id:number};
    b.onmessage!({data:{id:second.id,result:{fresh:true}}} as MessageEvent);
    expect(receive).toHaveBeenCalledWith({status:"complete",result:{fresh:true}});
    expect(b.terminate).toHaveBeenCalledOnce();
  });
  it("cancels without a success callback on source change/unmount", () => {
    const a=port(), receive=vi.fn(), runner=createResearchRunner(()=>a);
    runner.run(input,config,receive); const late=a.onmessage!;
    runner.cancel(); late({data:{id:1,result:{}}} as MessageEvent);
    expect(receive).not.toHaveBeenCalled(); expect(a.onmessage).toBeNull();
  });
  it("bounds a stuck worker and terminates it", () => {
    vi.useFakeTimers(); const a=port(), receive=vi.fn(), runner=createResearchRunner(()=>a,100);
    runner.run(input,config,receive); vi.advanceTimersByTime(100);
    expect(receive.mock.calls[0]![0].status).toBe("error"); expect(a.terminate).toHaveBeenCalledOnce();
  });
  it.each(["onerror","onmessageerror"] as const)("reports %s without falling back to main-thread computation", event => {
    const a=port(), receive=vi.fn(), runner=createResearchRunner(()=>a);
    runner.run(input,config,receive); (a[event] as (e:unknown)=>void)({});
    expect(receive.mock.calls[0]![0].status).toBe("error"); expect(a.terminate).toHaveBeenCalledOnce();
  });
  it("handles unavailable workers and serialization failures", () => {
    const receive=vi.fn(); createResearchRunner(()=>{throw Error("disabled");}).run(input,config,receive);
    expect(receive.mock.calls[0]![0].status).toBe("error");
    const a=port(); a.postMessage=()=>{throw Error("clone");};
    createResearchRunner(()=>a).run(input,config,receive); expect(a.terminate).toHaveBeenCalledOnce();
  });
});
