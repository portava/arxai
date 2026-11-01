import React from 'react';
import {writeFileSync} from 'node:fs';
import {afterEach,it,expect,vi} from 'vitest';
import {act,cleanup,render,screen,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import MT5BridgePage from './mt5-bridge';
vi.mock('@/hooks/useTradingMode',()=>({useTradingMode:()=>({isLoading:false,isFrozen:false})}));
vi.mock('@/lib/assistant-name',()=>({useAssistantName:()=>({name:'Eleanor'})}));
class Stream {
 static OPEN=1;static instances:Stream[]=[];readyState=0;onerror:(()=>void)|null=null;listeners:((event:{data:string})=>void)[]=[];
 constructor(){Stream.instances.push(this);}addEventListener(_type:string,listener:(event:{data:string})=>void){this.listeners.push(listener);}close(){this.readyState=2;}
 emit(data:unknown){this.readyState=1;this.listeners.forEach(listener=>listener({data:JSON.stringify(data)}));}
}
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
/** Opt-in isolated timing, not a CI latency threshold. Run only in an agreed
 * quiet window. Real clocks/timers; mock transport; React DOM, not browser paint.
 * ARX_PERSONAL_REFRESH_TIMING_OUTPUT records every warmup and measured sample. */
it.runIf(process.env.ARX_PERSONAL_REFRESH_TIMING==='1')('records personal hint to actual Bridge DOM update using real timers',async()=>{
 vi.useRealTimers();localStorage.clear();Stream.instances=[];Object.defineProperty(document,'hidden',{configurable:true,value:false});vi.stubGlobal('EventSource',Stream);
 const observedAt=new Date().toISOString();
 let balance='1000.123';const fetchStarts:number[]=[];
 const fetcher=vi.fn(async(url:unknown)=>{
   if(!String(url).endsWith('/api/mt5/status'))throw Error('Unexpected endpoint '+String(url));
   fetchStarts.push(performance.now());
   return new Response(JSON.stringify({connected:true,accountSnapshot:{account:'12345678',broker:'Personal fixture'},openPositions:[],nativeAccountReport:{status:'reported',currentVerified:false,reason:'CLOCK_AND_CONTINUITY_UNVERIFIED',observedAt,receivedAt:observedAt,currency:'KWD',currencyDigits:3,amounts:{balance,equity:'0.000',profit:'-7.125',credit:'4.000',margin:'0.000',freeMargin:'0.000'}}}),{headers:{'content-type':'application/json'}});
 });vi.stubGlobal('fetch',fetcher);
 const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
 const samples:{index:number;warmup:boolean;hintToReadStartMs:number;hintToDomMs:number;canonicalReads:number}[]=[];
 try {
  render(<QueryClientProvider client={client}><MT5BridgePage/></QueryClientProvider>);
  await waitFor(()=>expect(screen.getByTestId('native-money-balance').textContent).toBe('KWD 1,000.123'));
  expect(Stream.instances).toHaveLength(1);const stream=Stream.instances[0]!;
  for(let index=0;index<35;index++){
   balance=`${1001+index}.123`;const before=fetchStarts.length,start=performance.now();
   act(()=>stream.emit({type:'personal_account_changed'}));
   await waitFor(()=>expect(screen.getByTestId('native-money-balance').textContent).toBe(`KWD ${(1001+index).toLocaleString('en-US')}.123`));
   const end=performance.now();
   samples.push({index,warmup:index<5,hintToReadStartMs:fetchStarts[before]!-start,hintToDomMs:end-start,canonicalReads:fetchStarts.length-before});
  }
  expect(samples.every(sample=>Number.isFinite(sample.hintToDomMs)&&sample.canonicalReads===1)).toBe(true);
  expect(screen.getByTestId('native-money-equity').textContent).toBe('KWD 0.000');expect(screen.getAllByText(/current state unverified/).length).toBeGreaterThan(0);
  const result={metric:'In-memory SSE message dispatch to React DOM balance text update; real timers, synthetic instant HTTP; not browser compositor or broker-to-screen latency',readMetric:'Same event to generated canonical GET starting in the fetch double',samples,warmupCount:5,measuredCount:30,allOutliersRetained:true,observedAt,streamCount:Stream.instances.length};
  if(process.env.ARX_PERSONAL_REFRESH_TIMING_OUTPUT)writeFileSync(process.env.ARX_PERSONAL_REFRESH_TIMING_OUTPUT,JSON.stringify(result,null,2)+'\n');
 }finally{cleanup();client.clear();}
},20000);
