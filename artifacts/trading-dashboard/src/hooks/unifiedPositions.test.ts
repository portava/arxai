import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {QueryClient,QueryObserver} from '@tanstack/react-query';
import {readUnifiedPositions,getUnifiedPositionsQueryKey} from './unifiedPositions';
import {createUnifiedPositionChangeRefresh} from './sharedAccountChangeRefresh';
import {ACCOUNT_SUMMARY_READ_TIMEOUT_MS} from './readSharedAccountSummary';
const row=(pnl:number|null)=>({scope:'live',brokerTicket:'1',accountMode:'LIVE',lotSize:1,entryPrice:1,currentPrice:1,stopLoss:null,takeProfit:null,floatingPnl:pnl});
const report=(pnl:number|null)=>({ok:true,live:[row(pnl)],demo:[]});
const response=(body:unknown)=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
beforeEach(()=>vi.useFakeTimers());afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
it.each(['headers','body'])('bounds stalled %s, rejects its late reply, and consumes retained trailing hint',async stage=>{
 let resolveOld!:(value:any)=>void;const stalled=new Promise(resolve=>{resolveOld=resolve;});
 const fetcher=vi.fn().mockImplementationOnce(()=>stage==='headers'?stalled:Promise.resolve({ok:true,json:()=>stalled})).mockResolvedValue(response(report(-12.345)));vi.stubGlobal('fetch',fetcher);
 const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});client.setQueryData(['me'],{id:1});
 const key=getUnifiedPositionsQueryKey(1),observer=new QueryObserver(client,{queryKey:key,queryFn:readUnifiedPositions,retry:false});const off=observer.subscribe(()=>{});const refresh=createUnifiedPositionChangeRefresh(client);
 try{
  refresh.notify();await vi.advanceTimersByTimeAsync(ACCOUNT_SUMMARY_READ_TIMEOUT_MS);expect(client.getQueryState(key)?.status).toBe('error');expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(25);expect(fetcher).toHaveBeenCalledTimes(2);expect(client.getQueryData(key)).toMatchObject({live:[{floatingPnl:-12.345}]});
  resolveOld(stage==='headers'?response(report(999)):report(999));await vi.advanceTimersByTimeAsync(0);expect(client.getQueryData(key)).toMatchObject({live:[{floatingPnl:-12.345}]});
  expect(fetcher.mock.calls.every(([,options])=>options.cache==='no-store'&&options.credentials==='include')).toBe(true);
 }finally{refresh.dispose();off();client.clear();}
});
it('identity change retires old stream hints and does not bind them to the next user',async()=>{
 const client=new QueryClient();client.setQueryData(['me'],{id:1});const fn=vi.fn(async()=>report(1));const observer=new QueryObserver(client,{queryKey:getUnifiedPositionsQueryKey(2),queryFn:fn,staleTime:Infinity});client.setQueryData(getUnifiedPositionsQueryKey(2),report(2));const off=observer.subscribe(()=>{});const refresh=createUnifiedPositionChangeRefresh(client);
 try{client.setQueryData(['me'],{id:2});expect(refresh.notify()).toBe(false);await vi.advanceTimersByTimeAsync(30);expect(fn).not.toHaveBeenCalled();}finally{refresh.dispose();off();client.clear();}
});
it('stream created before identity requires matching owned snapshot, not a bare hint',async()=>{
 const client=new QueryClient();const refresh=createUnifiedPositionChangeRefresh(client);client.setQueryData(['me'],{id:1});
 const fn=vi.fn(async()=>report(2));client.setQueryData(getUnifiedPositionsQueryKey(1),report(1));const observer=new QueryObserver(client,{queryKey:getUnifiedPositionsQueryKey(1),queryFn:fn,staleTime:Infinity});const off=observer.subscribe(()=>{});
 try{expect(refresh.notify()).toBe(false);expect(refresh.notify('2')).toBe(false);expect(fn).not.toHaveBeenCalled();expect(refresh.notify('1')).toBe(true);await vi.advanceTimersByTimeAsync(0);expect(fn).toHaveBeenCalledTimes(1);}finally{refresh.dispose();off();client.clear();}
});
it('aborted reader rejects an abort-ignoring body and never resolves its old report',async()=>{
 let resolveOld!:(value:any)=>void;vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:()=>new Promise(resolve=>{resolveOld=resolve;})})));
 const controller=new AbortController();const promise=readUnifiedPositions({signal:controller.signal}).catch(error=>error);await vi.advanceTimersByTimeAsync(0);controller.abort();expect(await promise).toMatchObject({name:'AbortError'});resolveOld(report(999));await vi.advanceTimersByTimeAsync(0);expect(vi.getTimerCount()).toBe(0);
});
it.each(['0',false,{},Infinity,NaN])('does not coerce malformed monetary evidence %s',async value=>{
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({ok:true,live:[{...row(1),floatingPnl:value}],demo:[]})})));
 await expect(readUnifiedPositions({signal:new AbortController().signal})).rejects.toThrow(/unverified values/);
});

it.each(['symbol','side','source','openedAt','sourceCommandId'])('rejects malformed textual %s instead of forwarding an object to JSX/assistant',async field=>{
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({ok:true,live:[{...row(1),[field]:{unsafe:true}}],demo:[]})})));
 await expect(readUnifiedPositions({signal:new AbortController().signal})).rejects.toThrow(/unverified values/);
});
it('cached identity data with an error is not ownership evidence for later hints',async()=>{
 const client=new QueryClient();client.setQueryData(['me'],{id:1});const fn=vi.fn(async()=>report(2));client.setQueryData(getUnifiedPositionsQueryKey(1),report(1));const observer=new QueryObserver(client,{queryKey:getUnifiedPositionsQueryKey(1),queryFn:fn,staleTime:Infinity});const off=observer.subscribe(()=>{});const refresh=createUnifiedPositionChangeRefresh(client);
 try{client.getQueryCache().find({queryKey:['me'],exact:true})!.setState({status:'error',error:Error('Identity unavailable')});expect(client.getQueryData(['me'])).toEqual({id:1});expect(refresh.notify()).toBe(false);await vi.advanceTimersByTimeAsync(30);expect(fn).not.toHaveBeenCalled();}finally{refresh.dispose();off();client.clear();}
});
