import {expect,it,vi} from 'vitest';
import {ChartVolumeProfilePrimitive,projectVolumeProfile} from './chartVolumeProfilePrimitive';
import {calculateVolumeProfile} from './chartVolumeProfile';
import {TRADE_VOLUME_AUTHORITY} from './chartVolume';
import type {ChartEngineCandle} from './types';
const identity='a'.repeat(64),bar:ChartEngineCandle={time:60,open:1,high:9,low:1,close:9,volumeEvidence:{kind:'real_volume',unit:'provider_trade_units',quantity:80,authority:TRADE_VOLUME_AUTHORITY,seriesIdentity:identity,reason:null},profileEvidence:{finality:'closed',clockAuthority:TRADE_VOLUME_AUTHORITY}};
const result=()=>calculateVolumeProfile([bar],{kind:'observed_range',fromTime:60,toTime:60,seriesIdentity:identity,clockAuthority:TRADE_VOLUME_AUTHORITY},8,70);
it('projects actual bins on linear/log/inverted axes without exceeding shared width or visible height',()=>{
 for(const axis of [(p:number)=>200-p*20,(p:number)=>p*20,(p:number)=>200-Math.log(p)*80]){const r=result(),left=projectVolumeProfile(r,axis,800,200,1,2),right=projectVolumeProfile(r,axis,800,200,0,2);expect(left.length).toBeGreaterThan(0);expect(right.length).toBe(left.length);for(const g of [...left,...right]){expect(Object.values(g).filter(v=>typeof v==='number').every(Number.isFinite)).toBe(true);expect(g.x).toBeGreaterThanOrEqual(800-800*.28-5);expect(g.x+g.width).toBeLessThanOrEqual(795);expect(g.y).toBeGreaterThanOrEqual(0);expect(g.y+g.height).toBeLessThanOrEqual(200);}expect(Math.max(...left.map(g=>g.x+g.width))).toBeLessThan(Math.min(...right.map(g=>g.x)));}
 expect(projectVolumeProfile(result(),()=>null,800,200)).toEqual([]);expect(projectVolumeProfile(result(),()=>NaN,800,200)).toEqual([]);expect(projectVolumeProfile(result(),p=>p,0,200)).toEqual([]);
});
it('uses the native pane renderer, caches projected geometry, reprojects on viewport invalidation and clears on detach/hold',()=>{
 const primitive=new ChartVolumeProfilePrimitive(),axis=vi.fn((p:number)=>200-p*20),update=vi.fn();primitive.attached({series:{priceToCoordinate:axis},requestUpdate:update} as any);const r=result();primitive.setData(r,'#aabbcc',0,1);
 const context:any={save:vi.fn(),restore:vi.fn(),beginPath:vi.fn(),rect:vi.fn(),clip:vi.fn(),fillRect:vi.fn(),strokeRect:vi.fn(),fillText:vi.fn()};const target:any={useMediaCoordinateSpace:(fn:any)=>fn({context,mediaSize:{width:800,height:200}})};const draw=()=>primitive.paneViews()[0]!.renderer()!.draw(target,false,undefined);
 draw();expect(context.fillRect).toHaveBeenCalledTimes(8);expect(context.strokeRect).toHaveBeenCalledOnce();const calls=axis.mock.calls.length;draw();expect(axis).toHaveBeenCalledTimes(calls);primitive.setData(r,'#aabbcc',0,1);draw();expect(axis).toHaveBeenCalledTimes(calls);primitive.updateAllViews();draw();expect(axis.mock.calls.length).toBe(calls*2);expect((primitive as any).result).toBe(r);
 primitive.setData(Object.freeze({status:'held',method:'ohlc-uniform-range-v1',reason:'withdrawn'}),'#aabbcc',0,1);context.fillRect.mockClear();draw();expect(context.fillRect).not.toHaveBeenCalled();expect((primitive as any).geometry).toEqual([]);primitive.detached();expect((primitive as any).geometry).toEqual([]);expect(update).toHaveBeenCalledTimes(2);
});
