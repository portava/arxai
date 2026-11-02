import {act,cleanup,renderHook} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {ReactNode} from 'react';
const m=vi.hoisted(()=>({read:vi.fn()}));
vi.mock('@workspace/api-client-react',()=>({getAdminFundBookBrokerMirror:m.read,getGetAdminFundBookBrokerMirrorQueryKey:()=>['/api/admin/fundbook/broker-mirror']}));
import {useAdminBrokerMirror} from './useAdminBrokerMirror';
let client:QueryClient;
const user=(id=1,role='ADMIN')=>({id,role,email:'fixture',name:null});
const valid=()=>({ok:true,bridges:[{bridgeConnectionId:7,connectionName:'A',status:'CONNECTED',accountType:'LIVE',freshness:'FRESH',openPositionCount:1,nativeAccountReport:null}],openPositions:[]});
const settle=()=>act(async()=>{await vi.advanceTimersByTimeAsync(25);});
function mount(){return renderHook(()=>useAdminBrokerMirror(),{wrapper:({children}:{children:ReactNode})=><QueryClientProvider client={client}>{children}</QueryClientProvider>});}
beforeEach(()=>{vi.useFakeTimers();localStorage.clear();Object.defineProperty(document,'hidden',{configurable:true,value:false});client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});client.setQueryData(['me'],user());m.read.mockReset().mockResolvedValue(valid());vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Unexpected network');}));});
afterEach(()=>{cleanup();client.clear();vi.useRealTimers();vi.unstubAllGlobals();});
it('reads under the authenticated owner key with no-store and abort signal',async()=>{const h=mount();await settle();expect(h.result.current.data?.bridges[0]?.bridgeConnectionId).toBe(7);expect(client.getQueryData(['/api/admin/fundbook/broker-mirror','1:ADMIN'])).toEqual(valid());expect(m.read.mock.calls[0][0].cache).toBe('no-store');expect(m.read.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);});
it('replaces external changes on the next visible poll and pause leaves manual refresh usable',async()=>{const h=mount();await settle();m.read.mockResolvedValue({...valid(),bridges:[]});await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});await settle();expect(h.result.current.data?.bridges).toEqual([]);act(()=>h.result.current.setAutoRefreshEnabled(false));const count=m.read.mock.calls.length;await act(async()=>{await vi.advanceTimersByTimeAsync(15000);});expect(m.read).toHaveBeenCalledTimes(count);await act(async()=>{await h.result.current.refetch();});await settle();expect(m.read).toHaveBeenCalledTimes(count+1);});
it('withholds cached money after failed reread and accepts recovery',async()=>{const h=mount();await settle();m.read.mockRejectedValueOnce(Error('offline'));await act(async()=>{await h.result.current.refetch();});await settle();expect(h.result.current.isError).toBe(true);expect(h.result.current.data).toBeUndefined();await act(async()=>{await h.result.current.refetch();});await settle();expect(h.result.current.data).toEqual(valid());});
it('retires stalled reads at the full-body deadline and ignores late completion',async()=>{let finish:(value:unknown)=>void=()=>{};m.read.mockImplementationOnce(()=>new Promise(r=>{finish=r;}));const h=mount();await settle();await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});await settle();expect(h.result.current.isError).toBe(true);expect(m.read.mock.calls[0][0].signal.aborted).toBe(true);await act(async()=>{await h.result.current.refetch();});await settle();act(()=>finish({...valid(),bridges:[]}));await settle();expect(h.result.current.data?.bridges).toHaveLength(1);});
it('identity switch cannot show a prior owner or let old handlers fetch for the new owner',async()=>{const h=mount();await settle();const oldRefresh=h.result.current.refetch;m.read.mockImplementation(()=>new Promise(()=>{}));act(()=>client.setQueryData(['me'],user(2)));await settle();expect(h.result.current.data).toBeUndefined();const n=m.read.mock.calls.length;await act(async()=>{await oldRefresh();});expect(m.read).toHaveBeenCalledTimes(n);});
it.each([null,user(1,'USER')])('missing or downgraded identity hides cached data and disables reads',async(identity)=>{const h=mount();await settle();const refresh=h.result.current.refetch;act(()=>client.setQueryData(['me'],identity));await settle();expect(h.result.current.isError).toBe(true);expect(h.result.current.data).toBeUndefined();const n=m.read.mock.calls.length;await act(async()=>{await refresh();});expect(m.read).toHaveBeenCalledTimes(n);});
it('cached identity error with retained admin data cannot expose reports or refetch',async()=>{const h=mount();await settle();const refresh=h.result.current.refetch;act(()=>client.getQueryCache().find({queryKey:['me'],exact:true})!.setState({status:'error',error:Error('identity failed')}));await settle();expect(h.result.current.data).toBeUndefined();const n=m.read.mock.calls.length;await act(async()=>{await refresh();});expect(m.read).toHaveBeenCalledTimes(n);});
it.each([
 (r:any)=>r.bridges.push(r.bridges[0]),
 (r:any)=>r.bridges[0].connectionName={x:1},
 (r:any)=>r.bridges[0].status={},
 (r:any)=>r.bridges[0].freshness={},
 (r:any)=>r.openPositions.push(null),
 (r:any)=>r.openPositions.push({bridgeConnectionId:7,brokerTicket:'x',symbol:{}}),
 (r:any)=>r.ok=false,
])('rejects malformed rows instead of crashing or retaining money',async(mutate)=>{const value=valid();mutate(value);m.read.mockResolvedValue(value);const h=mount();await settle();expect(h.result.current.isError).toBe(true);expect(h.result.current.data).toBeUndefined();});
