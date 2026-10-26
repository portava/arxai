import type { ChartPatternCandle } from "./types.js";

/** ARX explicit geometry convention v1. These are observations, not forecasts,
 * TA-Lib output parity, calibrated confidence, or execution instructions. */
export const CANDLE_CRITERIA_VERSION = "arx-candle-geometry-v1";
export interface CatalogueCandle extends ChartPatternCandle { time:number; closeTime:number; isFinal:boolean }
export interface CandleDefinition { id:string; name:string; family:string; criteria:string; sources:readonly string[]; summaryEligible:boolean }
export interface CandleObservation {
  definition:CandleDefinition; startIndex:number; endIndex:number; observedAt:number;
  explanation:string; priorTrend:"up"|"down"|"none"; referenceLevel:number|null;
}
const TA="https://github.com/TA-Lib/ta-lib/blob/main/src/ta_func/ta_";
const TV="https://www.tradingview.com/support/solutions/";
const defs:CandleDefinition[]=[];
function define(id:string,name:string,family:string,criteria:string,source:string,summaryEligible=true):CandleDefinition {
  const value={id,name,family,criteria,sources:[source],summaryEligible};defs.push(value);return value;
}
const bodyUp=define("white_candle","White/bullish candle","body","Close strictly above open; colour describes this candle only.",TA+"CDLLONGLINE.c",false);
const bodyDown=define("black_candle","Black/bearish candle","body","Close strictly below open; colour describes this candle only.",TA+"CDLLONGLINE.c",false);
const longBody=define("long_body","Long-body candle","body","Body exceeds the mean body of the prior 10 closed candles; that mean must be nonzero.",TA+"CDLLONGLINE.c",false);
const shortBody=define("short_body","Short-body candle","body","Positive body below half the mean body of the prior 10 closed candles.",TA+"CDLSHORTLINE.c",false);
const spin=define("spinning_top","Spinning top","indecision","Non-Doji body at most 30% of range; both shadows exceed the body.",TA+"CDLSPINNINGTOP.c");
const wave=define("high_wave","High-wave candle","indecision","Spinning-top geometry with both shadows at least twice the body and range >=1.5 times prior-10 mean range.",TA+"CDLHIGHWAVE.c");
const maruUp=define("bullish_marubozu","Bullish Marubozu","marubozu","Long up body; each shadow <=5% of current range.",TA+"CDLMARUBOZU.c");
const maruDown=define("bearish_marubozu","Bearish Marubozu","marubozu","Long down body; each shadow <=5% of current range.",TA+"CDLMARUBOZU.c");
const opening=define("opening_marubozu","Opening Marubozu","marubozu","Long body with opening-side shadow <=5% of range and closing-side shadow >5%; full Marubozu is classified separately.",TA+"CDLBELTHOLD.c");
const closing=define("closing_marubozu","Closing Marubozu","marubozu","Long body with closing-side shadow <=5% of range and opening-side shadow >5%; full Marubozu is classified separately.",TA+"CDLCLOSINGMARUBOZU.c");
const doji=define("doji","Standard Doji","doji","Body <=10% of a nonzero current high-low range; descriptive and direction-neutral.",TV+"43000583767-doji/");
const longLeg=define("long_legged_doji","Long-Legged Doji","doji","Doji with both shadows >=30% of range and range >=1.5 times prior-10 mean range.",TA+"CDLLONGLEGGEDDOJI.c");
const dragon=define("dragonfly_doji","Dragonfly Doji","doji","Doji with upper shadow <=5% and lower shadow >=60% of current range.",TA+"CDLDRAGONFLYDOJI.c");
const grave=define("gravestone_doji","Gravestone Doji","doji","Doji with lower shadow <=5% and upper shadow >=60% of current range.",TA+"CDLGRAVESTONEDOJI.c");
const four=define("four_price_doji","Four-Price Doji","doji","Open, high, low and close exactly equal; a zero-range observation, not evidence of a reversal or active trading.",TV+"43000583767-doji/",false);
const rick=define("rickshaw_man","Rickshaw Man","doji","Long-legged Doji variant whose body midpoint lies within 10% of the high-low midpoint; not an independent signal.",TA+"CDLRICKSHAWMAN.c");
const takuri=define("takuri_line","Takuri Line","doji","Dragonfly-shaped Doji after a decline, lower shadow >=3 times prior-10 mean body and range >=1.5 times prior mean range.",TA+"CDLTAKURI.c");
const hammer=define("hammer","Hammer","long_shadow","Non-Doji body <=30% of range, lower shadow >=2 bodies, upper shadow <=10% of range, after a five-close decline.",TV+"43000583775-hammer-bullish/");
const hanging=define("hanging_man","Hanging Man","long_shadow","Hammer geometry after a five-close rise; this names the shape, not a confirmed reversal.",TA+"CDLHANGINGMAN.c");
const inverted=define("inverted_hammer","Inverted Hammer","long_shadow","Non-Doji body <=30% of range, upper shadow >=2 bodies, lower shadow <=10%, after a five-close decline. This ARX variant does not require a body gap.",TA+"CDLINVERTEDHAMMER.c");
const beltUp=define("bullish_belt_hold","Bullish Belt Hold","belt_hold","Long up body after a decline, opens within 5% of range from its low.",TA+"CDLBELTHOLD.c");
const beltDown=define("bearish_belt_hold","Bearish Belt Hold","belt_hold","Long down body after a rise, opens within 5% of range from its high.",TA+"CDLBELTHOLD.c");
const haramiUp=define("bullish_harami","Bullish Harami","harami","After a decline, a long down body contains a smaller up body <=half its size strictly within both body edges.",TV+"43000583777-harami-bearish/");
const haramiDown=define("bearish_harami","Bearish Harami","harami","After a rise, a long up body contains a smaller down body <=half its size strictly within both body edges.",TV+"43000583777-harami-bearish/");
const crossUp=define("bullish_harami_cross","Bullish Harami Cross","harami","After a decline, a long down body strictly contains a Doji body <=half its size.",TA+"CDLHARAMICROSS.c");
const crossDown=define("bearish_harami_cross","Bearish Harami Cross","harami","After a rise, a long up body strictly contains a Doji body <=half its size.",TA+"CDLHARAMICROSS.c");
const piercing=define("piercing_line","Piercing Line","piercing_cloud","After a decline, long down then long up bodies; second opens below prior low and closes strictly above prior body midpoint but below prior open.",TA+"CDLPIERCING.c");
const cloud=define("dark_cloud_cover","Dark Cloud Cover","piercing_cloud","After a rise, long up then long down bodies; second opens above prior high and closes strictly below prior body midpoint but above prior open.",TA+"CDLDARKCLOUDCOVER.c");
const tweezerLow=define("tweezer_bottom","Tweezer Bottom","tweezers","After a decline, long down then up candle; lows differ by at most 5% of the prior-10 mean range.",TV+"43000592709-tweezer-bottom-bullish/");
const tweezerHigh=define("tweezer_top","Tweezer Top","tweezers","After a rise, long up then down candle; highs differ by at most 5% of the prior-10 mean range.",TV+"43000592709-tweezer-bottom-bullish/");
const morning=define("morning_star","Morning Star","stars","After a decline: long down body, short non-Doji body entirely gapped below it, then long up body closing above the first body's midpoint. Third opens above the middle body's top.",TA+"CDLMORNINGSTAR.c");
const evening=define("evening_star","Evening Star","stars","After a rise: long up body, short non-Doji body entirely gapped above it, then long down body closing below the first body's midpoint. Third opens below the middle body's bottom.",TA+"CDLEVENINGSTAR.c");
const morningDoji=define("morning_doji_star","Morning Doji Star","stars","Morning Star criteria with a Doji middle candle. No full-range gap is required; Abandoned Baby is a different pattern.",TA+"CDLMORNINGDOJISTAR.c");
const eveningDoji=define("evening_doji_star","Evening Doji Star","stars","Evening Star criteria with a Doji middle candle. No full-range gap is required; Abandoned Baby is a different pattern.",TA+"CDLEVENINGDOJISTAR.c");
export const CANDLE_DEFINITIONS:readonly CandleDefinition[]=Object.freeze(defs.map(d=>Object.freeze(d)));
const p=(n:number)=>Number(n.toPrecision(7)).toString();
const body=(c:CatalogueCandle)=>Math.abs(c.close-c.open);
const range=(c:CatalogueCandle)=>c.high-c.low;
const upper=(c:CatalogueCandle)=>c.high-Math.max(c.open,c.close);
const lower=(c:CatalogueCandle)=>Math.min(c.open,c.close)-c.low;
const up=(c:CatalogueCandle)=>c.close>c.open;
const down=(c:CatalogueCandle)=>c.close<c.open;
/** The shared explicit Doji threshold; callers first validate finite OHLC. */
export const isObservedDoji=(c:Pick<CatalogueCandle,"open"|"high"|"low"|"close">)=>c.high>c.low&&Math.abs(c.close-c.open)/(c.high-c.low)<=.1+1e-12;
const isDoji=isObservedDoji;
const LE=(a:number,b:number)=>a<=b+Math.max(Math.abs(a),Math.abs(b))*1e-12;
const GE=(a:number,b:number)=>a+Math.max(Math.abs(a),Math.abs(b))*1e-12>=b;
const GT=(a:number,b:number)=>!LE(a,b);
const LT=(a:number,b:number)=>!GE(a,b);
function priorMean(bars:readonly CatalogueCandle[],index:number,fn:(bar:CatalogueCandle)=>number):number|null {
  if(index<10)return null;
  let sum=0;for(let i=index-10;i<index;i++)sum+=fn(bars[i]!)/10;
  return Number.isFinite(sum)&&sum>0?sum:null;
}
function contiguous(bars:readonly CatalogueCandle[],from:number,to:number,interval:number):boolean {
  if(from<0)return false;
  for(let i=from+1;i<=to;i++)if(Math.abs(bars[i]!.time-bars[i-1]!.time-interval)>.001)return false;
  return true;
}
function trendBefore(bars:readonly CatalogueCandle[],start:number,interval:number):"up"|"down"|"none" {
  if(start<5||!contiguous(bars,start-5,start,interval))return "none";
  const change=bars[start-1]!.close-bars[start-5]!.close;
  let rises=0,falls=0,averageRange=0;
  for(let i=start-5;i<start;i++){
    averageRange+=range(bars[i]!)/5;
    if(i>start-5){if(bars[i]!.close>bars[i-1]!.close)rises++;if(bars[i]!.close<bars[i-1]!.close)falls++;}
  }
  if(averageRange<=0||Math.abs(change)<averageRange*.5)return "none";
  return change>0&&rises>=3?"up":change<0&&falls>=3?"down":"none";
}
export interface CandleCatalogueResult {status:"ready"|"unavailable";reason:string|null;observations:CandleObservation[];closedBars:number;criteriaVersion:string}
/** Caller retains owner/source/symbol/TF evidence. This pure layer also checks
 * explicit bar finality/time/geometry and never reads a future prefix. */
export function scanCandlestickCatalogue(bars:readonly CatalogueCandle[],options:{asOf:number;intervalSeconds:number;eventLookback?:number}):CandleCatalogueResult {
  const fail=(reason:string):CandleCatalogueResult=>({status:"unavailable",reason,observations:[],closedBars:0,criteriaVersion:CANDLE_CRITERIA_VERSION});
  const {asOf,intervalSeconds}=options,lookback=options.eventLookback??12;
  if(!Number.isFinite(asOf)||asOf<=0||!Number.isFinite(intervalSeconds)||intervalSeconds<=0||!Number.isInteger(lookback)||lookback<1||lookback>600)return fail("Invalid observation or interval boundary.");
  const closed:CatalogueCandle[]=[];let prior=-Infinity,sawForming=false;
  for(const c of bars){
    if(!Number.isFinite(c.time)||c.time<=0)return fail("Invalid candle time.");
    if(c.time>=asOf)continue;
    if(c.time<=prior)return fail("Candles are not chronological and unique.");prior=c.time;
    if(![c.open,c.high,c.low,c.close,c.closeTime].every(v=>Number.isFinite(v)&&v>0)||c.high<Math.max(c.open,c.close,c.low)||c.low>Math.min(c.open,c.close,c.high)||Math.abs(c.closeTime-c.time-intervalSeconds)>.001)return fail("Candle geometry or timeframe disagrees.");
    if(c.isComplete===false&&c.isFinal===false&&c.isForming===true){sawForming=true;continue;}
    if(c.isComplete!==true||c.isFinal!==true||c.isForming!==false||c.closeTime>asOf||sawForming)return fail("Closed-candle evidence disagrees.");
    closed.push(c);
  }
  const observations:CandleObservation[]=[];
  const add=(definition:CandleDefinition,startIndex:number,endIndex:number,explanation:string,priorTrend:"up"|"down"|"none"="none",referenceLevel:number|null=null)=>observations.push({definition,startIndex,endIndex,observedAt:closed[endIndex]!.closeTime,explanation,priorTrend,referenceLevel});
  for(let i=Math.max(0,closed.length-lookback);i<closed.length;i++){
    const c=closed[i]!,b=body(c),r=range(c),u=upper(c),l=lower(c),meanBody=priorMean(closed,i,body),meanRange=priorMean(closed,i,range),trend=trendBefore(closed,i,intervalSeconds),long=meanBody!=null&&GT(b,meanBody);
    const anatomy=`Open ${p(c.open)}, close ${p(c.close)}; body ${p(b)}, upper shadow ${p(u)}, lower shadow ${p(l)}.`;
    if(up(c))add(bodyUp,i,i,anatomy);if(down(c))add(bodyDown,i,i,anatomy);
    if(long)add(longBody,i,i,`${anatomy} Prior-10 mean body ${p(meanBody!)}.`);
    if(meanBody!=null&&b>0&&LT(b,meanBody*.5))add(shortBody,i,i,`${anatomy} Prior-10 mean body ${p(meanBody)}.`);
    if(r===0){add(four,i,i,`All four prices equal ${p(c.close)}. The bar records no price range; activity and liquidity are not established.`);continue;}
    if(isDoji(c)){
      add(doji,i,i,`${anatomy} The body is ${p(b/r*100)}% of range; no direction follows from this shape.`);
      const longLegged=meanRange!=null&&GE(r,1.5*meanRange)&&GE(u,.3*r)&&GE(l,.3*r);
      if(longLegged){add(longLeg,i,i,`${anatomy} Both shadows are long relative to the ${p(meanRange!)} prior mean range.`);if(LE(Math.abs((c.open/2+c.close/2)-(c.high/2+c.low/2)),.1*r))add(rick,i,i,`${anatomy} The small body sits near the middle of this long-legged Doji's range.`);}
      if(LE(u,.05*r)&&GE(l,.6*r)){
        add(dragon,i,i,`${anatomy} Open and close remain near the high; this is a geometric subtype of Doji.`);
        if(trend==="down"&&meanBody!=null&&meanRange!=null&&GE(l,3*meanBody)&&GE(r,1.5*meanRange))add(takuri,i,i,`${anatomy} After a decline, the lower shadow is at least three times the prior mean body.`,trend);
      }
      if(LE(l,.05*r)&&GE(u,.6*r))add(grave,i,i,`${anatomy} Open and close remain near the low; this is a geometric subtype of Doji.`);
    }else{
      if(LE(b,.3*r)&&GT(u,b)&&GT(l,b)){add(spin,i,i,anatomy);if(meanRange!=null&&GE(u,2*b)&&GE(l,2*b)&&GE(r,1.5*meanRange))add(wave,i,i,`${anatomy} Range ${p(r)} exceeds the prior mean ${p(meanRange)} by at least 50%.`);}
      const lowerHammer=LE(b,.3*r)&&GE(l,2*b)&&LE(u,.1*r),upperHammer=LE(b,.3*r)&&GE(u,2*b)&&LE(l,.1*r);
      if(lowerHammer&&trend==="down")add(hammer,i,i,`${anatomy} This lower-shadow shape follows a five-close decline; a reversal is unproven.`,trend,c.low);
      if(lowerHammer&&trend==="up")add(hanging,i,i,`${anatomy} The same lower-shadow shape follows a five-close rise; a reversal is unproven.`,trend,c.high);
      if(upperHammer&&trend==="down")add(inverted,i,i,`${anatomy} This upper-shadow shape follows a five-close decline; further confirmation is absent.`,trend,c.low);
    }
    if(long){
      const openShadow=up(c)?l:u,closeShadow=up(c)?u:l;
      if(LE(u,.05*r)&&LE(l,.05*r))add(up(c)?maruUp:maruDown,i,i,anatomy);
      else if(LE(openShadow,.05*r))add(opening,i,i,anatomy);
      else if(LE(closeShadow,.05*r))add(closing,i,i,anatomy);
      if(LE(openShadow,.05*r)&&((up(c)&&trend==="down")||(down(c)&&trend==="up")))add(up(c)?beltUp:beltDown,i,i,`${anatomy} The body exceeds the prior-10 mean ${p(meanBody!)} after a ${trend==="down"?"decline":"rise"}.`,trend);
    }
    if(i>=1&&contiguous(closed,i-1,i,intervalSeconds)){
      const a=closed[i-1]!,ab=body(a),am=priorMean(closed,i-1,body),ar=priorMean(closed,i-1,range),t=trendBefore(closed,i-1,intervalSeconds),firstLong=am!=null&&GT(ab,am);
      const bullish=t==="down"&&down(a),bearish=t==="up"&&up(a),inside=GT(Math.min(c.open,c.close),Math.min(a.open,a.close))&&LT(Math.max(c.open,c.close),Math.max(a.open,a.close));
      if(firstLong&&inside&&LE(b,ab*.5)&&(bullish||bearish)){
        const cross=isDoji(c);
        if(cross||(bullish?up(c):down(c)))add(cross?(bullish?crossUp:crossDown):(bullish?haramiUp:haramiDown),i-1,i,`The first body (${p(ab)}) encloses the second body (${p(b)}) after a ${bullish?"decline":"rise"}. ${cross?"The second candle is a Doji.":"The second candle has the opposite colour."} Only this closed shape is observed.`,t);
      }
      const midpoint=a.open/2+a.close/2;
      if(firstLong&&long&&bullish&&up(c)&&LT(c.open,a.low)&&GT(c.close,midpoint)&&LT(c.close,a.open))add(piercing,i-1,i,`The second candle opened at ${p(c.open)}, below the prior low ${p(a.low)}, then closed at ${p(c.close)} above the prior body midpoint ${p(midpoint)}.`,t,midpoint);
      if(firstLong&&long&&bearish&&down(c)&&GT(c.open,a.high)&&LT(c.close,midpoint)&&GT(c.close,a.open))add(cloud,i-1,i,`The second candle opened at ${p(c.open)}, above the prior high ${p(a.high)}, then closed at ${p(c.close)} below the prior body midpoint ${p(midpoint)}.`,t,midpoint);
      if(firstLong&&ar!=null&&bullish&&up(c)&&LE(Math.abs(c.low-a.low),.05*ar))add(tweezerLow,i-1,i,`Opposite-colour candles reached lows ${p(a.low)} and ${p(c.low)} after a decline; tolerance is ${p(.05*ar)}. Equal lows do not establish future support.`,t,a.low);
      if(firstLong&&ar!=null&&bearish&&down(c)&&LE(Math.abs(c.high-a.high),.05*ar))add(tweezerHigh,i-1,i,`Opposite-colour candles reached highs ${p(a.high)} and ${p(c.high)} after a rise; tolerance is ${p(.05*ar)}. Equal highs do not establish future resistance.`,t,a.high);
    }
    if(i>=2&&contiguous(closed,i-2,i,intervalSeconds)){
      const a=closed[i-2]!,mid=closed[i-1]!,ab=body(a),mb=body(mid),am=priorMean(closed,i-2,body),t=trendBefore(closed,i-2,intervalSeconds),half=a.open/2+a.close/2;
      if(am!=null&&GT(ab,am)&&LE(mb,ab*.3)&&long){
        const bullish=t==="down"&&down(a)&&up(c)&&LT(Math.max(mid.open,mid.close),Math.min(a.open,a.close))&&GT(c.open,Math.max(mid.open,mid.close))&&GT(c.close,half);
        const bearish=t==="up"&&up(a)&&down(c)&&GT(Math.min(mid.open,mid.close),Math.max(a.open,a.close))&&LT(c.open,Math.min(mid.open,mid.close))&&LT(c.close,half);
        if(bullish||bearish)add(isDoji(mid)?(bullish?morningDoji:eveningDoji):(bullish?morning:evening),i-2,i,`A long ${bullish?"down":"up"} candle was followed by a gapped ${isDoji(mid)?"Doji":"small body"}; the third close ${p(c.close)} passed the first body's midpoint ${p(half)}. The three-candle shape is observed, not a proven reversal.`,t,half);
      }
    }
  }
  return {status:"ready",reason:null,observations,closedBars:closed.length,criteriaVersion:CANDLE_CRITERIA_VERSION};
}
