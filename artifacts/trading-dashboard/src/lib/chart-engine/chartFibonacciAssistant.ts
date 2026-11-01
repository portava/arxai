export type FibonacciRequest={action:"preview"|"explain"|"explain_preview"|"selected"|"keep"|"hide_selected"|"show_selected"|"remove_selected"}|{error:string};
const unsupported='Chart not changed. Fibonacci requests support “preview automatic Fibonacci”, “what does Fibonacci show me about this chart?”, “explain Fibonacci preview” or “explain selected Fibonacci”. The automatic method uses two closed bars on each side; extra rules, instruments, timeframes, custom ratios and orders are not supported. “Keep Fibonacci” explicitly keeps a current preview; hide/show/remove require “selected Fibonacci drawing”.';
/** Complete, deliberately bounded language. Mentioned but unsupported Fibonacci
 * requests are consumed locally rather than partially applied or sent remotely. */
export function parseFibonacciRequest(text:string):FibonacciRequest|null {
  const input=text.trim().toLowerCase().replace(/[?!.]+$/g,"").replace(/^please\s+/,"");
  if(!/\b(?:fibonacci|fib)\b/.test(input))return null;
  const tool="(?:automatic )?(?:fibonacci|fib)(?: retracement)?";
  if(/^(?:keep|save) (?:the )?(?:current )?(?:fibonacci|fib)(?: preview)?$/.test(input))return {action:"keep"};
  const owned=input.match(/^(hide|show|remove) (?:the )?selected (?:fibonacci|fib)(?: drawing)?$/);
  if(owned)return {action:`${owned[1]}_selected` as "hide_selected"|"show_selected"|"remove_selected"};
  if(new RegExp(`^(?:explain|describe) (?:the )?selected ${tool}(?: drawing)?$`).test(input))return {action:"selected"};
  if(new RegExp(`^(?:explain|describe) (?:the )?(?:current )?${tool} preview(?: on (?:this|the current) chart)?$`).test(input))return {action:"explain_preview"};
  if(new RegExp(`^(?:explain|describe) (?:the )?(?:current )?${tool}(?: on (?:this|the current) chart)?$`).test(input))return {action:"explain"};
  if(new RegExp(`^(?:(?:show|preview|add|apply) )?${tool}(?: (?:to|on) (?:this|the current) chart)?$`).test(input))return {action:"preview"};
  if(new RegExp(`^(?:what is ${tool}|what does ${tool} (?:tell|show) me about this chart)$`).test(input))return {action:"explain"};
  return {error:unsupported};
}
type Handler=(request:Exclude<FibonacciRequest,{error:string}>)=>string;
let current:Handler|null=null;
export function registerChartFibonacciAssistant(handler:Handler):()=>void {
  current=handler;return()=>{if(current===handler)current=null;};
}
export function requestChartFibonacci(text:string):string|null {
  const request=parseFibonacciRequest(text);if(!request)return null;if("error" in request)return request.error;
  return current?current(request):"Select a ready Smart Chart with “Use chart with assistant” to preview or explain Fibonacci. No other pane was substituted. No drawing was saved or order sent.";
}
