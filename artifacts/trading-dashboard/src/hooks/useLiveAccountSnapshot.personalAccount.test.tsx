import React,{type ReactNode} from 'react';
import {act,cleanup,renderHook} from '@testing-library/react';
import {QueryClient,QueryClientProvider,QueryObserver} from '@tanstack/react-query';
import {getGetMt5StatusQueryKey,getGetMeSharedAccountSummaryQueryKey} from '@workspace/api-client-react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {useLiveAccountSnapshot} from './useLiveAccountSnapshot';
class Stream {
 static OPEN=1;static instances:Stream[]=[];readyState=0;onerror:(()=>void)|null=null;listeners:((event:{data:string})=>void)[]=[];
 constructor(){Stream.instances.push(this);}addEventListener(_type:string,listener:(event:{data:string})=>void){this.listeners.push(listener);}close(){this.readyState=2;}
 emit(data:unknown){this.readyState=1;this.listeners.forEach(listener=>listener({data:JSON.stringify(data)}));}
}
const key=getGetMt5StatusQueryKey(),sharedKey=getGetMeSharedAccountSummaryQueryKey(),hint={type:'personal_account_changed'};
const old={connected:true,accountSnapshot:{nativeAccountReport:{currentVerified:false,status:'reported',currency:'KWD',currencyDigits:3,observedAt:'2026-11-01T12:00:00.000Z',amounts:{balance:'1000.123',equity:'0.000',profit:'-2.123',credit:'3.000',margin:'0.000',freeMargin:'0.000'}}}};
let hidden=false,clients:QueryClient[],disposers:(()=>void)[];
beforeEach(()=>{vi.useFakeTimers();localStorage.clear();hidden=false;clients=[];disposers=[];Stream.instances=[];Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});vi.stubGlobal('EventSource',Stream);vi.stubGlobal('fetch',vi.fn(()=>new Promise(()=>{})));});
afterEach(()=>{cleanup();disposers.forEach(fn=>fn());clients.forEach(client=>client.clear());vi.unstubAllGlobals();vi.useRealTimers();});
function setup(){
 const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity,gcTime:Infinity}}});clients.push(client);client.setQueryData(key,old);client.setQueryData(sharedKey,{master:'unchanged'});
 const requests:{resolve:(value:any)=>void;reject:(reason:Error)=>void;signal:AbortSignal}[]=[];
 const queryFn=vi.fn(({signal}:{signal:AbortSignal})=>new Promise((resolve,reject)=>requests.push({resolve,reject,signal})));
 const observer=new QueryObserver(client,{queryKey:key,queryFn});disposers.push(observer.subscribe(()=>{}));
 const wrapper=({children}:{children:ReactNode})=><QueryClientProvider client={client}>{children}</QueryClientProvider>;
 const hook=renderHook(()=>useLiveAccountSnapshot(),{wrapper});return {client,requests,queryFn,hook,stream:Stream.instances[0]!};
}
const settle=async()=>{await act(async()=>{await vi.advanceTimersByTimeAsync(30);});};
it('personal hint immediately refreshes only exact personal status without renewing cached report or snapshot',async()=>{
 const {client,requests,queryFn,hook,stream}=setup();const before=client.getQueryState(key)!.dataUpdatedAt;client.setQueryData([...key,'other'],42);
 act(()=>stream.emit(hint));expect(queryFn).toHaveBeenCalledTimes(1);expect(client.getQueryData(key)).toEqual(old);expect(client.getQueryState(key)!.dataUpdatedAt).toBe(before);expect(hook.result.current.snapshot).toBeNull();expect(hook.result.current.connectionStatus).toBe('connecting');
 expect(client.getQueryState(sharedKey)!.isInvalidated).toBe(false);expect(client.getQueryState([...key,'other'])!.isInvalidated).toBe(false);
 await act(async()=>requests[0]!.resolve({...old,connected:false,accountSnapshot:null}));expect(client.getQueryData(key)).toMatchObject({connected:false,accountSnapshot:null});expect(Stream.instances).toHaveLength(1);
});
it('personal burst retains one trailing read after an in-flight pre-hint response without cancellation',async()=>{
 const {client,requests,queryFn,stream}=setup();void client.refetchQueries({queryKey:key,exact:true});act(()=>{for(let i=0;i<50;i++)stream.emit(hint);});expect(queryFn).toHaveBeenCalledTimes(1);expect(requests[0]!.signal.aborted).toBe(false);
 await act(async()=>requests[0]!.resolve(old));await settle();expect(queryFn).toHaveBeenCalledTimes(2);await act(async()=>requests[1]!.resolve(old));await settle();expect(queryFn).toHaveBeenCalledTimes(2);
});
it('personal hints during a hint-started request retain a single trailing refresh',async()=>{
 const {requests,queryFn,stream}=setup();act(()=>{for(let i=0;i<50;i++)stream.emit(hint);});expect(queryFn).toHaveBeenCalledTimes(1);await act(async()=>requests[0]!.resolve(old));await settle();expect(queryFn).toHaveBeenCalledTimes(2);
});
it('another reader cancelling a pre-hint request does not consume the personal change',async()=>{
 const {client,queryFn,stream}=setup();void client.refetchQueries({queryKey:key,exact:true});act(()=>stream.emit(hint));await act(async()=>client.cancelQueries({queryKey:key,exact:true}));await settle();expect(queryFn).toHaveBeenCalledTimes(2);
});
it.each(['hidden','paused','error','unmount','logout'] as const)('personal trailing refresh is disposed on %s',async(reason)=>{
 const {client,requests,queryFn,hook,stream}=setup();act(()=>{stream.emit(hint);stream.emit(hint);});expect(queryFn).toHaveBeenCalledTimes(1);
 act(()=>{if(reason==='hidden'){hidden=true;document.dispatchEvent(new Event('visibilitychange'));}if(reason==='paused')hook.result.current.setAutoRefreshEnabled(false);if(reason==='error')stream.onerror?.();if(reason==='unmount')hook.unmount();if(reason==='logout')client.clear();});
 await act(async()=>requests[0]!.resolve(old));act(()=>stream.emit(hint));await settle();expect(queryFn).toHaveBeenCalledTimes(1);
});
it('shared hints do not consume or invalidate a personal request',()=>{
 const {client,queryFn,stream}=setup();act(()=>stream.emit({type:'shared_account_changed'}));expect(queryFn).not.toHaveBeenCalled();expect(client.getQueryState(key)!.isInvalidated).toBe(false);
});
it('personal hints never replace the5s snapshot fallback or its original observations',async()=>{
 const {queryFn,stream,hook}=setup();await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});const fetcher=vi.mocked(fetch);expect(fetcher).toHaveBeenCalledTimes(1);const previous=hook.result.current.snapshot;
 act(()=>stream.emit(hint));expect(queryFn).toHaveBeenCalledTimes(1);expect(hook.result.current.snapshot).toBe(previous);
 await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});expect(fetcher.mock.calls.filter(([url])=>String(url).includes('/slot-summary')).length).toBeGreaterThan(1);
});
