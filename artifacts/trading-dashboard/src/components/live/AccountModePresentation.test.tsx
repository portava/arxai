import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
const h=vi.hoisted(()=>({mode:{} as any,safety:{} as any,queries:[] as any[]}));
vi.mock('@/hooks/useTradingMode',()=>({useTradingMode:()=>h.mode}));
vi.mock('@tanstack/react-query',()=>({useQuery:(options:any)=>{h.queries.push(options);return h.safety;}}));
import {LiveModeBadge} from './LiveModeBadge';
import {EnvironmentPill} from '@/components/dashboard/cockpit/EnvironmentPill';
function reset(){
 const envelope={ok:true,currentAccountMode:'LIVE_SHARED',liveExecutionArmed:true,userCanManualTrade:true,userCanAutoTrade:true,userFrozenStatus:{isFrozen:false,freezeMessage:null},cleanBlockedReason:null,cleanUserMessage:'Live trading is active',cleanModeLabel:'Live (Shared Master MT5)',isAdminPreviewingUserMode:false};
 h.mode={envelope,isLoading:false,isError:false,isStale:false,isFetching:false,dataUpdatedAt:Date.now(),isLiveShared:true,isDemo:false,isLiveArmed:true,isFrozen:false,cleanBlockedReason:null,cleanUserMessage:envelope.cleanUserMessage,cleanModeLabel:envelope.cleanModeLabel};
 h.safety={data:{arming:{killSwitchEngaged:false}},isLoading:false,isError:false,isStale:false,isFetching:false,dataUpdatedAt:Date.now()};h.queries=[];
}
beforeEach(reset);afterEach(cleanup);
function mount(){return render(<><LiveModeBadge/><EnvironmentPill/></>);}
const badge=()=>screen.getByTestId('live-mode-badge');
const pill=()=>screen.getByTestId('cockpit-env-pill');
describe('account mode is distinct from current trading/feed health',()=>{
 it('labels selected mode without asserting broker connectivity or all-systems health',()=>{
  mount();for(const el of [badge(),pill()]){expect(el.textContent).toContain('Account mode: Live shared');expect(el.textContent).toContain('Permissions reported');}
  expect(document.body.textContent).not.toMatch(/All systems operational|Bridge Connected|LIVE · Shared MT5/);
  expect(pill().textContent).toContain('checked separately');
 });
 it('keeps a non-connectivity blocked reason without inventing a bridge failure',()=>{
  h.mode.cleanBlockedReason=h.mode.envelope.cleanBlockedReason='Allocation approval is pending.';mount();expect(pill().textContent).toContain('Trading blocked');expect(pill().textContent).toContain('Allocation approval is pending.');expect(document.body.textContent).not.toContain('Bridge Disconnected');
 });
 it('does not turn compact blocked mode into a bare LIVE claim',()=>{
  h.mode.cleanBlockedReason=h.mode.envelope.cleanBlockedReason='Account review required.';render(<LiveModeBadge compact/>);expect(badge().textContent).toContain('Trading blocked');expect(badge().textContent).toContain('mode:');
 });
 it.each(['error','stale','missing','loading'] as const)('withholds current availability on %s account-mode evidence',state=>{
  if(state==='error')h.mode.isError=true;if(state==='stale')h.mode.isStale=true;if(state==='missing')h.mode.envelope=null;if(state==='loading')h.mode.isLoading=true;
  mount();for(const el of [badge(),pill()])expect(el.textContent).toContain('Availability unverified');expect(document.body.textContent).not.toContain('Permissions reported');
 });
 it('gives a fresh direct kill-switch report precedence even when the account resolver fails',()=>{
  h.mode.isError=true;h.mode.envelope=null;h.safety.data.arming.killSwitchEngaged=true;mount();for(const el of [badge(),pill()])expect(el.textContent).toContain('Kill switch engaged');
 });
 it('retains a conservative last-reported kill warning without claiming it is current',()=>{
  h.safety.data.arming.killSwitchEngaged=true;h.safety.isError=true;h.safety.isStale=true;mount();for(const el of [badge(),pill()])expect(el.textContent).toContain('Last reported kill switch');
 });
 it('shows frozen status distinctly and does not infer connectivity',()=>{
  h.mode.isFrozen=true;h.mode.envelope.userFrozenStatus={isFrozen:true,freezeMessage:'Account paused for review.'};mount();expect(pill().textContent).toContain('Trading paused');expect(pill().textContent).toContain('Account paused for review.');expect(document.body.textContent).not.toContain('Disconnected');
 });
 it('does not call a DEMO broker account a simulator',()=>{
  h.mode.envelope.currentAccountMode='DEMO';h.mode.isLiveShared=false;h.mode.isDemo=true;mount();expect(pill().textContent).toContain('Account mode: Demo');expect(document.body.textContent).not.toContain('Simulator');
 });
 it('distinguishes explicit disarming from an absent arming field',()=>{
  h.mode.envelope.liveExecutionArmed=false;h.mode.isLiveArmed=false;const v=mount();expect(pill().textContent).toContain('Live orders not armed');
  delete h.mode.envelope.liveExecutionArmed;v.rerender(<><LiveModeBadge/><EnvironmentPill/></>);expect(pill().textContent).toContain('Availability unverified');expect(pill().textContent).not.toContain('not armed');
 });
 it.each(['missing','error','stale'] as const)('does not grant availability from %s direct safety evidence',state=>{
  if(state==='missing')h.safety.data=undefined;if(state==='error')h.safety.isError=true;if(state==='stale')h.safety.isStale=true;mount();expect(pill().textContent).toContain('Availability unverified');expect(document.body.textContent).not.toContain('Permissions reported');
 });
 it('never elevates user preview to verified live dispatch',()=>{
  h.mode.envelope.isAdminPreviewingUserMode=true;mount();expect(pill().textContent).toContain('User preview');expect(document.body.textContent).not.toContain('Permissions reported');
 });
 it.each(['userFrozenStatus','cleanBlockedReason','isAdminPreviewingUserMode'] as const)('does not treat missing %s as a negative restriction verdict',field=>{
  delete h.mode.envelope[field];mount();expect(pill().textContent).toContain('Availability unverified');expect(document.body.textContent).not.toContain('Permissions reported');
 });

});
