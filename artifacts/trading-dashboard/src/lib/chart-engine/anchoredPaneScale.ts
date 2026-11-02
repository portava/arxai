/** Display-only vertical translation. Percent is measured from pane bottom.
 * The observed span receives the same 8% padding on each side as Auto scale.
 * Normalize before subtracting so opposite-sign magnitudes cannot overflow.
 * Unrepresentable ranges are refused rather than clamped to false endpoints. */
export function anchoredPaneScale(observedLow:number,observedHigh:number,value:number,percent:number){
  if(![observedLow,observedHigh,value,percent].every(Number.isFinite)||observedHigh<observedLow||percent<0||percent>100)return null;
  const magnitude=Math.max(Math.abs(observedLow),Math.abs(observedHigh))||1;
  const a=observedLow/magnitude,b=observedHigh/magnitude,position=percent/100;
  const span=(b>a?(b-a)*1.16:.02)*magnitude;
  if(!Number.isFinite(span)||span<=0)return null;
  const low=value-span*position,high=value+span*(1-position);
  if(!Number.isFinite(low)||!Number.isFinite(high)||!(high>low))return null;
  // A distant anchor may round both edges onto it or significantly distort
  // the span. Do not widen the range to hide that loss of representability.
  if(Math.abs((value-low)/span-position)>1e-9||Math.abs((high-value)/span-(1-position))>1e-9)return null;
  return {low,high,fraction:(input:number)=>{
    if(!Number.isFinite(input))return null;
    const result=position+(input-value)/span;
    return Number.isFinite(result)?result:null;
  }};
}
