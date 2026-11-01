import {describe,it,expect} from 'vitest';
import {cashCurveDisplayPoints} from './ChartResearchCashPanel';
describe('historical equity display keeps risk evidence while bounding geometry',()=>{
 it('retains the missed drawdown inside a bucket as well as its lower starting value and later maximum',()=>{
  const points=Array.from({length:1280},(_,i)=>({time:i,value:i<5?[0,5,1,10,9][i]:9}));const shown=cashCurveDisplayPoints(points);for(const time of [0,1,2,3,1279])expect(shown).toContainEqual(points[time]);expect(shown.length).toBeLessThanOrEqual(1028);
 });
 it('preserves distinct absolute and relative drawdown pairs without inventing or averaging observations',()=>{
  const points=Array.from({length:2000},(_,i)=>({time:i,value:i<7?[100,150,100,300,240,310,309][i]:309}));const shown=cashCurveDisplayPoints(points);for(const time of [1,2,3,4])expect(shown).toContainEqual(points[time]);expect(shown.every(p=>points[p.time]===p)).toBe(true);expect(shown.every((p,i)=>i===0||p.time>shown[i-1].time)).toBe(true);expect(shown.length).toBeLessThanOrEqual(1028);
 });
 it('does not reduce small observation sets',()=>{const points=[{time:0,value:100},{time:100,value:-5}];expect(cashCurveDisplayPoints(points)).toEqual(points);});
});
