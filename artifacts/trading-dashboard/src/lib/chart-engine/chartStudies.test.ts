import { describe, expect, it } from "vitest";
import { STUDY_DEFAULTS, StudyCalculator } from "./chartStudies";
const bars=(closes:number[])=>closes.map((close,i)=>({time:100+i*60,open:close,high:close,low:close,close}));
describe("close-price study calculations",()=>{
  it("keeps warm-up empty and computes SMA, SMA-seeded EMA and population Bollinger bands",()=>{
    const data=bars([1,2,3,4,3,2,5]);
    expect(new StudyCalculator({kind:"sma",period:3,color:"#ffffff"}).calculate(data).map(p=>p.values[0])).toEqual([null,null,2,3,10/3,3,10/3]);
    expect(new StudyCalculator({kind:"ema",period:3,color:"#ffffff"}).calculate(data).map(p=>p.values[0])).toEqual([null,null,2,3,3,2.5,3.75]);
    const bb=new StudyCalculator({kind:"bollinger",period:3,multiplier:2,color:"#ffffff"}).calculate(data);
    expect(bb[1]!.values).toEqual([null,null,null]);
    expect(bb[2]!.values).toEqual([2,2+2*Math.sqrt(2/3),2-2*Math.sqrt(2/3)]);
  });
  it("uses Wilder RSI with explicit flat, rising and falling cases",()=>{
    const rsi=(values:number[])=>new StudyCalculator({kind:"rsi",period:3,color:"#ffffff"}).calculate(bars(values)).map(p=>p.values[0]);
    expect(rsi([1,2,3,4,3,2,5]).slice(0,4)).toEqual([null,null,null,100]);
    expect(rsi([1,2,3,4,3,2,5])[4]).toBeCloseTo(66.6666667);
    expect(rsi([1,2,3,4,3,2,5])[5]).toBeCloseTo(44.4444444);
    expect(rsi([1,2,3,4,3,2,5])[6]).toBeCloseTo(77.7777778);
    expect(rsi([4,3,2,1])[3]).toBe(0);
    expect(rsi([2,2,2,2])[3]).toBe(50);
  });
  it("seeds MACD and signal independently, then renders a signed histogram",()=>{
    const points=new StudyCalculator({kind:"macd",period:2,slow:3,signal:2,color:"#ffffff"}).calculate(bars([1,2,3,4,5,6]));
    expect(points.map(p=>p.values)).toEqual([[null,null,null],[null,null,null],[.5,null,null],[.5,.5,0],[.5,.5,0],[.5,.5,0]]);
  });
  it.each(STUDY_DEFAULTS)("$kind forming-bar revisions and appends equal a clean calculation without compounding",config=>{
    const data=bars(Array.from({length:300},(_,i)=>100+Math.sin(i/8)*5));
    const calculator=new StudyCalculator(config);calculator.calculate(data);
    for(let n=0;n<25;n++){
      data[data.length-1]={...data.at(-1)!,close:100+n*.01};
      expect(calculator.calculate(data,data.length-1)).toHaveLength(1);
      expect(calculator.points).toEqual(new StudyCalculator(config).calculate(data));
    }
    data.push({...data.at(-1)!,time:data.at(-1)!.time+60,close:103});
    calculator.calculate(data,data.length-1);
    expect(calculator.points).toEqual(new StudyCalculator(config).calculate(data));
    data[100]={...data[100]!,close:125};calculator.calculate(data,100);
    expect(calculator.points).toEqual(new StudyCalculator(config).calculate(data));
    calculator.calculate(data.slice(0,50),0);
    expect(calculator.points).toEqual(new StudyCalculator(config).calculate(data.slice(0,50)));
  });
  it("does not change past values when future data arrives",()=>{
    const data=bars(Array.from({length:300},(_,i)=>100+Math.sin(i)));
    for(const config of STUDY_DEFAULTS){const short=new StudyCalculator(config).calculate(data.slice(0,100));expect(new StudyCalculator(config).calculate(data).slice(0,100)).toEqual(short);}
  });
});
