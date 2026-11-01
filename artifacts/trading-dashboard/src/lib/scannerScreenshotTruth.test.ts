import {describe,it,expect} from 'vitest';
import {resolveScannerTruth,type ScannerTruthInputs} from './scannerTruth';
import {resolveCappedRubyReadStatus,resolveRubyReadPanelState} from './rubyReadPanelState';
const now=Date.parse('2026-11-01T14:30:00Z');
function input(clock:unknown):ScannerTruthInputs{return {symbolDisplay:'V25_1S',symbolInternal:'V25_1S',timeframe:'15m',feedStatus:{symbol:'V25_1S',source:'deriv_public',quality:'clean',isLive:true,aiUsable:true,stale:false},candleCount:200,requestedCount:200,firstTime:new Date(now-200*900000).toISOString(),lastTime:new Date(now-900000).toISOString(),lastClose:939791.4,headerOk:true,sourceClockQualified:clock,nowMs:now,mode:{isLoading:false,isDemo:false,isLiveShared:true,isPaper:false,isLiveArmed:false,isFrozen:true,canManualTrade:false,canAutoTrade:false,isSharedMasterAssigned:false,ownBridgeConnected:false,approvalStatus:'APPROVED',frozenReason:'Restricted',cleanBlockedReason:'Restricted'}} as ScannerTruthInputs;}
describe('owner screenshot contradictions at shared display boundaries',()=>{
 it.each([false,undefined,null])('does not call an unqualified clock live even with green provider flags: %s',clock=>{
  const t=resolveScannerTruth(input(clock));expect(t.candles.status).toBe('historical_only');expect(t.candles.reason).toMatch(/clock|UTC/i);expect(t.isLivePrice).toBe(false);expect(t.actionable).toBe(false);expect(t.consolidated.rubyReadStatus).not.toBe('FULL_READ');expect(t.readiness.dataFreshness).not.toBe('LIVE_CONFIRMED');expect(t.candles.lastClose).toBe(939791.4);
 });
 it('keeps verified market-data freshness separate from account permission',()=>{const t=resolveScannerTruth(input(true));expect(t.candles.status).toBe('live');expect(t.strip.trading.verdict).toBe('Blocked');});
 it.each([{liveSetupWithheld:true},{canShowLiveTradeSetup:false},{readLayer:'INSUFFICIENT' as const}])('caps the actual read when explicit server fields withhold it: %j',flag=>{
  const read={dataQuality:'ok' as const,basis:'VERIFIED',...flag};expect(resolveCappedRubyReadStatus('FULL_READ',read).status).toBe('LIMITED_READ');const panel=resolveRubyReadPanelState({truthLevel:'full',truthReason:'Live data',aiUsableProp:true,read});expect(panel.verdict).not.toBe('confirmed');expect(panel.badgeAiUsable).toBe(false);
 });
 it('an insufficient result cannot escape into a structural verdict with contradictory flags',()=>{const panel=resolveRubyReadPanelState({truthLevel:'full',truthReason:null,aiUsableProp:true,read:{gated:true,readLayer:'STRUCTURAL_ONLY',liveSetupWithheld:true}});expect(panel.verdict).toBe('not_confirmed');});
});
it('a positive parent hint cannot upgrade downgraded shared chart truth',()=>{
 const panel=resolveRubyReadPanelState({truthLevel:'historical_only',truthReason:'UTC mapping unverified',aiUsableProp:true,read:null});expect(panel.verdict).toBe('not_confirmed');expect(panel.badgeAiUsable).toBe(false);expect(panel.reportedAiUsable).toBe(false);
});
