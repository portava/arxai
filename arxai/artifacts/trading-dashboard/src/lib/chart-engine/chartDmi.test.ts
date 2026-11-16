import { describe, expect, it } from "vitest";
import { StudyCalculator, studyLabel, type ChartStudy } from "./chartStudies";
import { validatePreferences } from "./chartWorkspace";
import type { ChartEngineCandle } from "./types";
const config:ChartStudy={kind:"dmi",period:2,signal:2,color:"#38bdf8"};
const bars=[[10,8,9],[12,9,11],[11,7,8],[13,8,12],[13,8,12]].map(([high,low,close],i)=>({time:100+i*60,open:close!,high:high!,low:low!,close:close!}));
// Independent batch oracle: explicit seed sums and multiply/divide recurrence,
// without production's state checkpoint or average helper.
function oracle(bars:ChartEngineCandle[],period:number,signal:number){
 const rma=(values:(number|null)[],length:number)=>{
  let total=0,count=0,previous:number|null=null;
  return values.map(value=>{if(value===null){total=0;count=0;previous=null;return null;}count++;if(count<=length)total+=value;
   if(count<length)return null;
   previous=count===length?total/length:(previous!*(length-1)+value)/length;return previous;});
 };
 const plus:(number|null)[]=[null],minus:(number|null)[]=[null],tr:(number|null)[]=[null];
 for(let i=1;i<bars.length;i++){
  const b=bars[i]!,a=bars[i-1]!,up=b.high-a.high,down=a.low-b.low;
  plus.push(up>0&&up>down?up:0);minus.push(down>0&&down>up?down:0);
  tr.push(Math.max(b.high-b.low,Math.abs(b.high-a.close),Math.abs(b.low-a.close)));
 }
 const p=rma(plus,period),m=rma(minus,period),t=rma(tr,period);
 const di=p.map((v,i)=>v===null?null:t[i]===0?0:100*v/t[i]!);
 const dm=m.map((v,i)=>v===null?null:t[i]===0?0:100*v/t[i]!);
 const dx=di.map((v,i)=>v===null?null:(v+dm[i]!) === 0?0:100*Math.abs(v-dm[i]!)/(v+dm[i]!));
 const adx=rma(dx,signal);return bars.map((_,i)=>[di[i],dm[i],adx[i]]);
}
function close(actual:(number|null)[][],expected:(number|null|undefined)[][]){
 expect(actual).toHaveLength(expected.length);
 actual.forEach((row,i)=>{expect(row).toHaveLength(3);row.forEach((v,j)=>{const e=expected[i]![j];if(e==null)expect(v).toBeNull();else{expect(v).not.toBeNull();expect(v!).toBeCloseTo(e,9);}});});
}
describe("Wilder DMI / ADX",()=>{
 it("matches hand-calculated directional changes, warmup and two-stage seeds",()=>{
  close(new StudyCalculator(config).calculate(bars).map(p=>p.values),[[null,null,null],[null,null,null],[100/3.5,100/3.5,null],[150/4.25,50/4.25,25],[75/4.625,25/4.625,37.5]]);
  expect(studyLabel(config)).toBe("DMI (2, 2)");
 });
 it("keeps tied outside moves and flat markets zero only after warmup",()=>{
  const flat=Array.from({length:8},(_,i)=>({time:100+i*60,open:10,high:10,low:10,close:10}));
  close(new StudyCalculator(config).calculate(flat).map(p=>p.values),[[null,null,null],[null,null,null],[0,0,null],...Array.from({length:5},()=>[0,0,0])]);
  expect(new StudyCalculator({...config,period:1,signal:1}).calculate([bars[0]!,{time:160,open:9,high:12,low:6,close:9}]).at(-1)?.values).toEqual([0,0,0]);
 });
 it("separates direction from strength for monotone rises and falls",()=>{
  for(const sign of [1,-1]){
   const data=Array.from({length:40},(_,i)=>{const close=100+sign*i;return {time:100+i*60,open:close,high:close,low:close,close};});
   expect(new StudyCalculator({...config,period:14,signal:14}).calculate(data).at(-1)?.values).toEqual(sign===1?[100,0,100]:[0,100,100]);
  }
 });
 it.each([[1,1],[2,4],[14,14],[40,7],[1000,1000]])("matches independent batch recurrence for DI %i / ADX %i",(period,signal)=>{
  const data=Array.from({length:2100},(_,i)=>{const close=100+Math.sin(i/7)*4+Math.cos(i/13)*3;return {time:100+i*60,open:close-.1,high:close+.4+(i%5)/10,low:close-.4-(i%3)/10,close};});
  const c={...config,period,signal};close(new StudyCalculator(c).calculate(data).map(p=>p.values),oracle(data,period,signal));
  for(const scale of [1e-6,1e6]){const scaled=data.map(b=>({...b,open:b.open*scale,high:b.high*scale,low:b.low*scale,close:b.close*scale}));close(new StudyCalculator(c).calculate(scaled).map(p=>p.values),oracle(data,period,signal));}
 });
 it("revises high/low/close without compounding or reading future bars",()=>{
  const data=Array.from({length:60},(_,i)=>({...bars[i%5]!,time:100+i*60}));const calc=new StudyCalculator(config);calc.calculate(data);
  for(const change of [1,2,-1]){const revised=data.map((b,i)=>i===59?{...b,high:b.high+change,low:b.low-change/2,close:b.close+change/4}:b);calc.calculate(revised,59);close(calc.points.map(p=>p.values),oracle(revised,2,2));}
  calc.calculate(data.slice(0,20));expect(calc.points).toEqual(new StudyCalculator(config).calculate(data).slice(0,20));
  calc.calculate(data,20);close(calc.points.map(p=>p.values),oracle(data,2,2));
 });
 it("retains both validated lengths and rejects malformed saved settings",()=>{
  expect(validatePreferences({studies:[config]}).studies).toEqual([config]);
  for(const signal of [undefined,0,-1,1.2,1001,NaN,'14'])expect(validatePreferences({studies:[{...config,signal}]}).studies).toEqual([]);
 });
});
