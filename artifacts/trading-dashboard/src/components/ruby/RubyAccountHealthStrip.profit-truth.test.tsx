import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { RubyAccountHealthStrip } from './RubyAccountHealthStrip';
vi.mock('@/hooks/useTradingMode',()=>({useTradingMode:()=>({isLiveShared:true})}));
class Stream {static OPEN=1;static last:Stream;readyState=0;onerror=null;listeners:((event:{data:string})=>void)[]=[];constructor(){Stream.last=this;}close(){}addEventListener(_:string,fn:(event:{data:string})=>void){this.listeners.push(fn);}emit(data:unknown){this.listeners.forEach(fn=>fn({data:JSON.stringify(data)}));}}
beforeEach(()=>{vi.useFakeTimers();localStorage.clear();Object.defineProperty(document,'hidden',{configurable:true,value:false});vi.stubGlobal('EventSource',Stream);vi.stubGlobal('fetch',vi.fn(()=>new Promise(()=>{})));});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.useRealTimers();});
it.each([undefined,false,true])('real shared hook to Ruby requires affirmative completeness (%s)',complete=>{
 render(<RubyAccountHealthStrip/>);
 act(()=>Stream.last.emit({type:'account_snapshot',snapshot:{userId:'1',accountMode:'LIVE_SHARED',source:'broker_snapshot',balance:1000,equity:1012,margin:0,freeMargin:1012,marginLevel:null,openPL:12,openPositionsCount:1,positions:[{positionId:'lp_1',symbol:'EURUSD',direction:'buy',volume:1,entryPrice:1,currentPrice:1.1,unrealizedPL:12,plSource:'broker',plIsEstimate:false,lastUpdateAtMs:Date.now(),freshness:'fresh'}],lastComputedAtMs:Date.now(),freshness:'fresh',warnings:[],reconciliation:complete===undefined?undefined:{positionPnlComplete:complete}}}));
 const tile=screen.getByText('Position P/L (unverified scope)').parentElement!;
 expect(tile.textContent).toContain(complete===true?'12 (currency unverified)':'—');
 expect(tile.textContent).not.toContain('$');
 if(complete===true)expect(screen.getByText('12 (currency unverified)').className).toContain('text-txt-muted');
});
