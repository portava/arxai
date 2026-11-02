import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,render,screen,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {LiveModeBadge} from '@/components/live/LiveModeBadge';
import {EnvironmentPill} from '@/components/dashboard/cockpit/EnvironmentPill';
import {useTradingMode} from './useTradingMode';
let client:QueryClient,modeBody:any,safetyBody:any,modeFailure=false,safetyFailure=false;
const base=()=>({ok:true,userId:7,currentAccountMode:'LIVE_SHARED',cleanModeLabel:'Live (Shared Master MT5)',cleanUserMessage:'Live trading active',cleanBlockedReason:null,role:'USER',isAdmin:false,isAdminPreviewingUserMode:false,adminDiagnosticsAvailable:false,liveExecutionArmed:true,userSharedMasterAssignment:{attached:true},accountShellStatus:{},userAllocation:{hasAllocation:true},userRiskCaps:{maxLotSize:1},userFrozenStatus:{isFrozen:false,freezeMessage:null},userCanManualTrade:true,userCanAutoTrade:true,adminDiagnostics:null});
function Probe(){const m=useTradingMode();return <output data-testid="mode-authority">{JSON.stringify({isAdmin:m.isAdmin,preview:m.isAdminPreviewingUserMode,manual:m.canManualTrade,auto:m.canAutoTrade,armed:m.isLiveArmed,envelope:m.envelope,error:m.isError})}</output>;}
function mount(){return render(<QueryClientProvider client={client}><LiveModeBadge/><EnvironmentPill/><Probe/></QueryClientProvider>);}
const badge=()=>screen.getByTestId('live-mode-badge').textContent??'';
const authority=()=>JSON.parse(screen.getByTestId('mode-authority').textContent!);
async function refresh(key:string[]){await act(async()=>{await client.refetchQueries({queryKey:key});});}
beforeEach(()=>{
 client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});modeBody=base();safetyBody={arming:{killSwitchEngaged:false}};modeFailure=false;safetyFailure=false;
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
  if(url==='/api/me/account-mode'){if(modeFailure)throw new Error('Mode transport failed');return {ok:true,json:async()=>modeBody};}
  if(url==='/api/me/live/arming')return {ok:!safetyFailure,status:safetyFailure?503:200,json:async()=>safetyBody};
  throw new Error('Unexpected request '+url);
 }));
});
afterEach(()=>{cleanup();client.clear();vi.unstubAllGlobals();});
describe('actual shared query authority and read-state transitions',()=>{
 it('deduplicates both display surfaces on existing authenticated query keys and preserves user permissions',async()=>{
  mount();await waitFor(()=>expect(badge()).toContain('Permissions reported'));
  const calls=vi.mocked(fetch).mock.calls;expect(calls.map(c=>c[0]).sort()).toEqual(['/api/me/account-mode','/api/me/live/arming']);
  for(const call of calls)expect(call[1]).toEqual({credentials:'include',cache:'no-store'});
  expect(authority()).toMatchObject({isAdmin:false,preview:false,manual:true,auto:true,armed:true,envelope:modeBody});
 });
 it('retains execution-authority outputs but withholds display availability after a failed cached-mode read',async()=>{
  mount();await waitFor(()=>expect(badge()).toContain('Permissions reported'));modeFailure=true;await refresh(['me','account-mode']);
  await waitFor(()=>expect(badge()).toContain('Availability unverified'));expect(authority()).toMatchObject({manual:true,auto:true,armed:true,error:true});expect(authority().envelope).toEqual(modeBody);
 });
 it('accepts a fresh scope downgrade without reusing owner presentation or diagnostics',async()=>{
  modeBody={...base(),role:'OWNER',isAdmin:true,adminDiagnosticsAvailable:true,adminDiagnostics:{private:'fixture'}};mount();await waitFor(()=>expect(authority().isAdmin).toBe(true));
  modeBody={...base(),isAdminPreviewingUserMode:true,userCanManualTrade:false,userCanAutoTrade:false};await refresh(['me','account-mode']);
  await waitFor(()=>expect(badge()).toContain('User preview'));expect(authority()).toMatchObject({isAdmin:false,preview:true,manual:false,auto:false});expect(authority().envelope.adminDiagnostics).toBeNull();
 });
 it('handles incomplete successful mode envelopes without inventing disarming or crashing nested reads',async()=>{
  modeBody={ok:true,userId:7,currentAccountMode:'LIVE_SHARED',role:'USER'};mount();await waitFor(()=>expect(authority().envelope).not.toBeNull());
  expect(badge()).toContain('Availability unverified');expect(badge()).not.toContain('not armed');expect(authority()).toMatchObject({manual:false,auto:false,armed:false});
 });
 it('rejects non-OK direct safety JSON instead of treating a new body as a verified kill report',async()=>{
  mount();await waitFor(()=>expect(badge()).toContain('Permissions reported'));safetyBody={arming:{killSwitchEngaged:true}};safetyFailure=true;await refresh(['live','arming','kill-switch-only']);
  await waitFor(()=>expect(badge()).toContain('Availability unverified'));expect(badge()).not.toContain('Kill switch engaged');
 });
 it('retains last-reported kill priority on failure then clears it after an authenticated successful false read',async()=>{
  safetyBody={arming:{killSwitchEngaged:true}};mount();await waitFor(()=>expect(badge()).toContain('Kill switch engaged'));
  safetyFailure=true;await refresh(['live','arming','kill-switch-only']);await waitFor(()=>expect(badge()).toContain('Last reported kill switch'));
  safetyFailure=false;safetyBody={arming:{killSwitchEngaged:false}};await refresh(['live','arming','kill-switch-only']);await waitFor(()=>expect(badge()).toContain('Permissions reported'));expect(badge()).not.toContain('kill switch');
 });
 it('labels an expired cached kill report as last reported while its refresh is pending',async()=>{
  client.setQueryData(['me','account-mode'],base());client.setQueryData(['live','arming','kill-switch-only'],{arming:{killSwitchEngaged:true}},{updatedAt:Date.now()-20_000});
  vi.mocked(fetch).mockImplementation(()=>new Promise(()=>{}));mount();expect(badge()).toContain('Last reported kill switch');expect(badge()).not.toContain('Permissions reported');
 });
});
