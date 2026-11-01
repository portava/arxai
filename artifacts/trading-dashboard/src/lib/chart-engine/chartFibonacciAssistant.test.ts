import {afterEach,describe,expect,it,vi} from "vitest";
import {parseFibonacciRequest,registerChartFibonacciAssistant,requestChartFibonacci} from "./chartFibonacciAssistant";
afterEach(()=>vi.restoreAllMocks());
describe("bounded current-chart Fibonacci grammar",()=>{
 it.each(["Fibonacci","preview automatic Fibonacci","please show fib retracement on this chart!","add Fibonacci to the current chart","apply Fibonacci"])("previews %s",text=>{expect(parseFibonacciRequest(text)).toEqual({action:"preview"});});
 it.each(["what is Fibonacci?","what does fib tell me about this chart?","explain Fibonacci on this chart"])("explains or prepares current geometry for %s",text=>{expect(parseFibonacciRequest(text)).toEqual({action:"explain"});});
 it("distinguishes explicit preview and selected manual drawing",()=>{
  expect(parseFibonacciRequest("explain Fibonacci preview on this chart")).toEqual({action:"explain_preview"});
  expect(parseFibonacciRequest("explain the selected Fibonacci drawing")).toEqual({action:"selected"});
 });
 it.each(["show Fibonacci on USDJPY","show Fibonacci on M5","show Fibonacci with span 5","show Fibonacci from yesterday","show Fibonacci using highs only","show Fibonacci and RSI","hide fib","remove Fibonacci","buy Fibonacci breakout","don't show Fibonacci","show Fibonacci 0.618","set Fib anchors 1 to 2","show Fibonacci then sell"])("consumes unsupported entire phrase without mutation: %s",text=>{
  const handler=vi.fn();const release=registerChartFibonacciAssistant(handler);try{expect(requestChartFibonacci(text)).toContain("Chart not changed");expect(handler).not.toHaveBeenCalled();}finally{release();}
 });
 it("leaves unrelated tools to existing routes and releases replaced owners safely",()=>{
  expect(requestChartFibonacci("show RSI")).toBeNull();const a=vi.fn(()=>"first"),b=vi.fn(()=>"second");const stopA=registerChartFibonacciAssistant(a),stopB=registerChartFibonacciAssistant(b);
  stopA();expect(requestChartFibonacci("show Fib")).toBe("second");stopB();expect(requestChartFibonacci("show Fib")).toContain("Open the primary");expect(a).not.toHaveBeenCalled();
 });
});
