import React from 'react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {act,cleanup,render,screen} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {getGetMt5StatusQueryKey} from '@workspace/api-client-react';
import MT5BridgePage from './mt5-bridge';
vi.mock('@/hooks/useTradingMode',()=>({useTradingMode:()=>({isLoading:false,isFrozen:false})}));
vi.mock('@/lib/assistant-name',()=>({useAssistantName:()=>({name:'Eleanor'})}));
class Stream {
 static OPEN=1;static instances:Stream[]=[];readyState=0;onerror:(()=>void)|null=null;listeners:((event:{data:string})=>void)[]=[];
 constructor(){Stream.instances.push(this);}addEventListener(_type:string,listener:(event:{data:string})=>void){this.listeners.push(listener);}close(){this.readyState=2;}
 emit(data:unknown){this.readyState=1;this.listeners.forEach(listener=>listener({data:JSON.stringify(data)}));}
}
const NOW=Date.parse('2026-11-01T12:00:00Z');
function report(balance:string){return {status:'reported',currentVerified:false,reason:'CLOCK_AND_CONTINUITY_UNVERIFIED',observedAt:new Date(NOW-2000).toISOString(),receivedAt:new Date(NOW-1000).toISOString(),currency:'KWD',currencyDigits:3,amounts:{balance,equity:'0.000',profit:'-7.125',credit:'4.000',margin:'0.000',freeMargin:'0.000'}};}
let client:QueryClient,persisted:any,fetcher:ReturnType<typeof vi.fn>;
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(NOW);localStorage.clear();Stream.instances=[];Object.defineProperty(document,'hidden',{configurable:true,value:false});vi.stubGlobal('EventSource',Stream);persisted={connected:true,accountSnapshot:{account:'12345678',broker:'Personal fixture'},nativeAccountReport:report('1000.123'),openPositions:[]};
 fetcher=vi.fn(async(url:unknown)=>{if(String(url).endsWith('/api/mt5/status'))return new Response(JSON.stringify(persisted),{headers:{'content-type':'application/json'}});throw Error('Unexpected endpoint '+String(url));});vi.stubGlobal('fetch',fetcher);client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});});
afterEach(()=>{cleanup();client.clear();vi.unstubAllGlobals();vi.useRealTimers();});
const mount=()=>render(<QueryClientProvider client={client}><MT5BridgePage/></QueryClientProvider>);
const flush=async(ms=0)=>{await act(async()=>{await vi.advanceTimersByTimeAsync(ms);});};
it('actual Bridge page mounts one existing stream and refreshes personal money before the5s poll',async()=>{
 mount();await flush();expect(screen.getByTestId('native-money-balance').textContent).toBe('KWD 1,000.123');expect(Stream.instances).toHaveLength(1);const start=Date.now();
 persisted={...persisted,nativeAccountReport:report('9007199254740993.123')};act(()=>Stream.instances[0]!.emit({type:'personal_account_changed'}));await flush(30);
 expect(Date.now()-start).toBeLessThan(5000);expect(fetcher).toHaveBeenCalledTimes(2);expect(screen.getByTestId('native-money-balance').textContent).toBe('KWD 9,007,199,254,740,993.123');expect(screen.getByTestId('native-money-equity').textContent).toBe('KWD 0.000');expect(screen.getByTestId('native-money-profit').textContent).toBe('KWD -7.125');expect(screen.getAllByText(/current state unverified/).length).toBeGreaterThan(0);
 expect(fetcher.mock.calls.every(([,options])=>options?.cache==='no-store')).toBe(true);
});
it('removed personal connection clears old report without borrowing master money',async()=>{
 mount();await flush();expect(Stream.instances).toHaveLength(1);persisted={connected:false,accountSnapshot:null,nativeAccountReport:null,openPositions:[]};act(()=>Stream.instances[0]!.emit({type:'personal_account_changed'}));await flush(30);
 expect(screen.getByTestId('native-money-balance').textContent).toBe('—');expect(client.getQueryData(getGetMt5StatusQueryKey())).toMatchObject({nativeAccountReport:null});
});
it('unmount closes the personal page stream and5s polling remains an independent fallback',async()=>{
 const view=mount();await flush();expect(Stream.instances).toHaveLength(1);const stream=Stream.instances[0]!;
 await flush(5000);expect(fetcher).toHaveBeenCalledTimes(2);view.unmount();expect(stream.readyState).toBe(2);act(()=>stream.emit({type:'personal_account_changed'}));await flush(30);expect(fetcher).toHaveBeenCalledTimes(2);
});
