import React from 'react';
import {act,cleanup,render} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {getGetMt5StatusQueryKey} from '@workspace/api-client-react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {Topbar} from '../components/layout/Topbar';
import {MT5StatusIndicator} from '../components/trading/MT5StatusIndicator';
import MT5BridgePage from '../pages/mt5-bridge';
vi.mock('@/components/layout/SymbolPicker',()=>({SymbolPicker:()=>null}));
vi.mock('@/components/alerts/NotificationBell',()=>({NotificationBell:()=>null}));
vi.mock('@/hooks/useFeatureUnlock',()=>({useAllUnlocks:()=>({mt5:true,simulator:false}),useFeatureUnlock:()=>({unlocked:true})}));
vi.mock('@/hooks/useCurrentUser',()=>({useCurrentUser:()=>({user:null}),useLogout:()=>({mutate:vi.fn()})}));
vi.mock('@/hooks/useViewMode',()=>({useViewMode:()=>({canToggle:false})}));
vi.mock('@/hooks/useTradingMode',()=>({useTradingMode:()=>({isLoading:false,isFrozen:false})}));
vi.mock('@/lib/assistant-name',()=>({useAssistantName:()=>({name:'Eleanor'})}));
class Stream {static OPEN=1;static count=0;readyState=0;constructor(){Stream.count++;}addEventListener(){}close(){this.readyState=2;}}
let client:QueryClient;
beforeEach(()=>{vi.useFakeTimers();localStorage.clear();Stream.count=0;vi.stubGlobal('EventSource',Stream);Object.defineProperty(document,'hidden',{configurable:true,value:false});client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});});
afterEach(()=>{cleanup();client.clear();vi.unstubAllGlobals();vi.useRealTimers();});
it.each([['Topbar',Topbar],['MT5StatusIndicator',MT5StatusIndicator],['MT5BridgePage',MT5BridgePage]] as const)('%s uses its canonical no-store reader without adding a parallel stream',async(name,Component)=>{
 const requests:{url:string;options:RequestInit}[]=[];vi.stubGlobal('fetch',vi.fn(async(url,options)=>{requests.push({url:String(url),options});return new Response(JSON.stringify({connected:false,mode:'MOCK',accountSnapshot:null,nativeAccountReport:null,openPositions:[]}),{headers:{'content-type':'application/json'}});}));
 render(<QueryClientProvider client={client}><Component/></QueryClientProvider>);await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
 const calls=requests.filter(request=>request.url.endsWith('/api/mt5/status'));expect(calls).toHaveLength(1);expect(calls[0]!.options).toMatchObject({method:'GET',cache:'no-store'});expect(calls[0]!.options.signal).toBeInstanceOf(AbortSignal);
 expect(client.getQueryState(getGetMt5StatusQueryKey())?.status).toBe('success');expect(Stream.count).toBe(name==='MT5BridgePage'?1:0);
});
