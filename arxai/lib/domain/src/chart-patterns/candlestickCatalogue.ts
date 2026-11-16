import type { ChartPatternCandle } from "./types.js";

/** ARX explicit geometry convention v5. These are observations, not forecasts,
 * TA-Lib output parity, calibrated confidence, or execution instructions. */
export const CANDLE_CRITERIA_VERSION = "arx-candle-geometry-v5";
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
  const value={id,name,family,criteria,sources:Object.freeze([source]),summaryEligible};defs.push(value);return value;
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
const risingWindow=define("rising_window","Rising Window","windows","After a rise, two nonzero-range candles have a full-range upward gap: second low strictly above first high. No claim that the gap will act as support.",TV+"43000592721-rising-window-bullish/");
const fallingWindow=define("falling_window","Falling Window","windows","After a decline, two nonzero-range candles have a full-range downward gap: second high strictly below first low. No claim that the gap will act as resistance.",TV+"43000592721-rising-window-bullish/");
const abandonedUp=define("bullish_abandoned_baby","Bullish Abandoned Baby","stars","After a decline, a long down body, a Doji separated below by a full-range gap, then a long up body fully above the Doji and closing past the first body's midpoint.",TA+"CDLABANDONEDBABY.c");
const abandonedDown=define("bearish_abandoned_baby","Bearish Abandoned Baby","stars","After a rise, a long up body, a Doji separated above by a full-range gap, then a long down body fully below the Doji and closing past the first body's midpoint.",TA+"CDLABANDONEDBABY.c");
const insideUp=define("three_inside_up","Three Inside Up","harami","After a decline, a long down body strictly contains a second body <=half its size, then an up candle closes above the first open. The middle candle may have either colour or be a Doji.",TA+"CDL3INSIDE.c");
const insideDown=define("three_inside_down","Three Inside Down","harami","After a rise, a long up body strictly contains a second body <=half its size, then a down candle closes below the first open. The middle candle may have either colour or be a Doji.",TA+"CDL3INSIDE.c");
const outsideUp=define("three_outside_up","Three Outside Up","engulfing","After a decline, an up body strictly engulfs the prior down body, then the third close is higher than the second. This records follow-through already observed, not a future outcome.",TA+"CDL3OUTSIDE.c");
const outsideDown=define("three_outside_down","Three Outside Down","engulfing","After a rise, a down body strictly engulfs the prior up body, then the third close is lower than the second. This records follow-through already observed, not a future outcome.",TA+"CDL3OUTSIDE.c");
const soldiers=define("three_white_soldiers","Three White Soldiers","soldiers_crows","After a decline, three up bodies at least the prior-10 mean body, rising closes, each later open strictly inside the prior body, upper shadows <=10% of range, and each body >=75% of the previous body.",TA+"CDL3WHITESOLDIERS.c");
const crows=define("three_black_crows","Three Black Crows","soldiers_crows","After a rise, three down bodies at least the prior-10 mean body, falling closes, each later open strictly inside the prior body, lower shadows <=10% of range, and each body >=75% of the previous body. ARX uses a symmetric variant with an observed prior rise.",TA+"CDL3BLACKCROWS.c");
const dojiStarUp=define("bullish_doji_star","Bullish Doji Star","doji","After a decline, a long down body is followed by a Doji whose body lies entirely below the first body. This two-candle observation does not imply a completed three-candle Morning Star.",TA+"CDLDOJISTAR.c");
const dojiStarDown=define("bearish_doji_star","Bearish Doji Star","doji","After a rise, a long up body is followed by a Doji whose body lies entirely above the first body. This two-candle observation does not imply a completed three-candle Evening Star.",TA+"CDLDOJISTAR.c");
const kickerUp=define("bullish_kicking","Bullish Kicking/Kicker","marubozu","Two opposite Marubozu candles: down then up, with second low strictly above first high; each body above its prior-10 mean and each shadow <=5% of range. No preceding trend is required.",TA+"CDLKICKING.c");
const kickerDown=define("bearish_kicking","Bearish Kicking/Kicker","marubozu","Two opposite Marubozu candles: up then down, with second high strictly below first low; each body above its prior-10 mean and each shadow <=5% of range. No preceding trend is required.",TA+"CDLKICKING.c");
const counterUp=define("bullish_counterattack","Bullish Meeting Lines/Counterattack","counterattack","After a decline, long down then long up bodies close within 5% of the prior-10 mean range of one another. No subsequent reversal is established.",TA+"CDLCOUNTERATTACK.c");
const counterDown=define("bearish_counterattack","Bearish Meeting Lines/Counterattack","counterattack","After a rise, long up then long down bodies close within 5% of the prior-10 mean range of one another. No subsequent reversal is established.",TA+"CDLCOUNTERATTACK.c");
const matchingLow=define("matching_low","Matching Low","tweezers","After a decline, two down candles close within 5% of the prior-10 mean range. This compares closes, not the candle lows; neither body must be long.",TA+"CDLMATCHINGLOW.c");
const homing=define("homing_pigeon","Homing Pigeon","harami","After a decline, a long down body strictly contains a down body at most half its size and at most the second candle's prior-10 mean body.",TA+"CDLHOMINGPIGEON.c");
const onNeck=define("on_neck","On-Neck","neck_thrusting","After a decline and a long down body, an up candle opens below the previous low and closes within 5% of prior-10 mean range of that low.",TA+"CDLONNECK.c");
const inNeck=define("in_neck","In-Neck","neck_thrusting","After a decline and a long down body, an up candle opens below the previous low and closes from the previous close to at most 5% of prior-10 mean range above it.",TA+"CDLINNECK.c");
const thrusting=define("thrusting","Thrusting","neck_thrusting","After a decline and a long down body, an up candle opens below the previous low and closes above the In-Neck tolerance but at or below the previous body's midpoint.",TA+"CDLTHRUSTING.c");
const separatingUp=define("bullish_separating_lines","Bullish Separating Lines","belt_hold","After a rise, a down candle is followed by a long up body with opening-side shadow <=5% of its range. Opens differ by at most 5% of the prior-10 mean range.",TA+"CDLSEPARATINGLINES.c");
const separatingDown=define("bearish_separating_lines","Bearish Separating Lines","belt_hold","After a decline, an up candle is followed by a long down body with opening-side shadow <=5% of its range. Opens differ by at most 5% of the prior-10 mean range.",TA+"CDLSEPARATINGLINES.c");
const triUp=define("bullish_tri_star","Bullish Tri-Star","doji","After a decline, three Doji candles: the middle body is gapped below the first body, and the third body's lower edge is above the middle body's lower edge. No full-range or third body gap is required.",TA+"CDLTRISTAR.c");
const triDown=define("bearish_tri_star","Bearish Tri-Star","doji","After a rise, three Doji candles: the middle body is gapped above the first body, and the third body's upper edge is below the middle body's upper edge. No full-range or third body gap is required.",TA+"CDLTRISTAR.c");
const tasukiUp=define("upside_tasuki_gap","Upside Tasuki Gap","tasuki_gap","After a rise, an up body is gapped above the first body, then a down candle opens inside the up body and closes strictly inside the remaining body gap. The last two body lengths differ by <=25% of the prior-10 mean range before the middle candle; first colour is unrestricted.",TA+"CDLTASUKIGAP.c");
const tasukiDown=define("downside_tasuki_gap","Downside Tasuki Gap","tasuki_gap","After a decline, a down body is gapped below the first body, then an up candle opens inside the down body and closes strictly inside the remaining body gap. The last two body lengths differ by <=25% of the prior-10 mean range before the middle candle; first colour is unrestricted.",TA+"CDLTASUKIGAP.c");
const kickingLength=define("kicking_by_length","Kicking by Length","marubozu","Kicking geometry with unequal body lengths; the observation identifies the longer body's colour, not the direction of the gap or a future outcome. Near-equal lengths leave this subtype unavailable.",TA+"CDLKICKINGBYLENGTH.c");
const risingMethods=define("rising_three_methods","Rising Three Methods","three_methods","After a rise, a long up body (above its prior-10 mean body) is followed by three short down bodies (each below half its own prior-10 mean body) whose bodies lie within the first high-low range, whose closes fall, and whose first close is at or below the first close. A fifth, long up body opens strictly above the third reaction close and closes strictly above the first close.",TA+"CDLRISEFALL3METHODS.c");
const fallingMethods=define("falling_three_methods","Falling Three Methods","three_methods","After a decline, a long down body (above its prior-10 mean body) is followed by three short up bodies (each below half its own prior-10 mean body) whose bodies lie within the first high-low range, whose closes rise, and whose first close is at or above the first close. A fifth, long down body opens strictly below the third reaction close and closes strictly below the first close.",TA+"CDLRISEFALL3METHODS.c");
const strikeUp=define("bullish_three_line_strike","Bullish Three-Line Strike","three_line_strike","After a rise, three up candles close successively higher; the second and third each open within the preceding body extended by 25% of the prior-10 mean range. A fourth, down candle opens strictly above the third close and closes strictly below the first open. ARX names follow TA-Lib's sign: bullish = three up candles then a down strike. The core Engulfing label may describe the last two candles in the opposite direction.",TA+"CDL3LINESTRIKE.c");
const strikeDown=define("bearish_three_line_strike","Bearish Three-Line Strike","three_line_strike","After a decline, three down candles close successively lower; the second and third each open within the preceding body extended by 25% of the prior-10 mean range. A fourth, up candle opens strictly below the third close and closes strictly above the first open. ARX names follow TA-Lib's sign: bearish = three down candles then an up strike. The core Engulfing label may describe the last two candles in the opposite direction.",TA+"CDL3LINESTRIKE.c");
const gapMethodsUp=define("upside_gap_three_methods","Upside Gap Three Methods","tasuki_gap","After a rise, two up candles with the second body strictly gapped above the first body; then a down candle opens strictly inside the second body and closes strictly inside the first body. No body-length rule applies.",TA+"CDLXSIDEGAP3METHODS.c");
const gapMethodsDown=define("downside_gap_three_methods","Downside Gap Three Methods","tasuki_gap","After a decline, two down candles with the second body strictly gapped below the first body; then an up candle opens strictly inside the second body and closes strictly inside the first body. No body-length rule applies.",TA+"CDLXSIDEGAP3METHODS.c");
const sideUp=define("upside_gap_side_by_side_white_lines","Upside-Gap Side-by-Side White Lines","side_by_side","After a rise, two up candles both have bodies strictly gapped above the first candle's body. Their opens differ by <=5% and their body lengths by <=25% of the prior-10 mean range before the middle candle. The first candle's colour is unrestricted.",TA+"CDLGAPSIDESIDEWHITE.c");
const sideDown=define("downside_gap_side_by_side_white_lines","Downside-Gap Side-by-Side White Lines","side_by_side","After a decline, two up candles both have bodies strictly gapped below the first candle's body. Their opens differ by <=5% and their body lengths by <=25% of the prior-10 mean range before the middle candle. The first candle's colour is unrestricted.",TA+"CDLGAPSIDESIDEWHITE.c");
const matHold=define("mat_hold","Mat Hold","three_methods","After a rise, a long up body; a short down body strictly gapped above it; two more short bodies of either colour with falling body tops whose lower body edges lie inside the upper 50% of the first body. A fifth, up candle opens strictly above the last reaction close and closes strictly above the highest reaction high. Bullish only; no final long-body rule.",TA+"CDLMATHOLD.c");
const identicalCrows=define("identical_three_crows","Identical Three Crows","soldiers_crows","After a rise, three down candles with falling closes; the second and third each open within 5% of the prior-10 mean range (measured before the previous candle) of the previous close; each lower shadow is below 10% of its own prior-10 mean range. No body-length rule applies.",TA+"CDLIDENTICAL3CROWS.c");
const twoCrows=define("two_crows","Two Crows","soldiers_crows","After a rise, a long up body; a down body strictly gapped above it; then a down candle opens strictly inside the second body and closes strictly inside the first body.",TA+"CDL2CROWS.c");
const gapTwoCrows=define("upside_gap_two_crows","Upside Gap Two Crows","soldiers_crows","After a rise, a long up body; a short down body (below half its prior-10 mean body) strictly gapped above it; then a down candle opens strictly above the second open, closes strictly below the second close and strictly above the first close. Only a body gap is required.",TA+"CDLUPSIDEGAP2CROWS.c");
const stickSandwich=define("stick_sandwich","Stick Sandwich","tweezers","After a decline, a down candle, an up candle whose low is strictly above the first close, then a down candle closing within 5% of the prior-10 mean range of the first close. The third open is unconstrained. The core Engulfing label may describe the last two candles in the opposite direction.",TA+"CDLSTICKSANDWICH.c");
const uniqueRiver=define("unique_three_river_bottom","Unique Three-River Bottom","harami","After a decline, a long down body; a down candle closing strictly above the first close, opening at or below the first open and reaching a strictly lower low; then a short up body (below half its prior-10 mean body) opening strictly above the second low.",TA+"CDLUNIQUE3RIVER.c");
const threeStars=define("three_stars_in_the_south","Three Stars in the South","long_shadow","After a decline, a long down body whose lower shadow exceeds its body; a smaller down body opening above the first close and at or below the first high, trading below the first close but not below the first low, with a lower shadow above 10% of its prior-10 mean range; then a short down body with both shadows below 10% of its prior-10 mean range and its range strictly inside the second range.",TA+"CDL3STARSINSOUTH.c");
const ladderBottom=define("ladder_bottom","Ladder Bottom","long_shadow","After a decline, three down candles with strictly falling opens and closes; a fourth down candle whose upper shadow exceeds 10% of its prior-10 mean range; then an up candle opening strictly above the fourth open and closing strictly above the fourth high.",TA+"CDLLADDERBOTTOM.c");
export const CANDLE_DEFINITIONS:readonly CandleDefinition[]=Object.freeze(defs.map(d=>Object.freeze(d)));
const p=(n:number)=>Number(n.toPrecision(7)).toString();
const body=(c:CatalogueCandle)=>Math.abs(c.close-c.open);
const range=(c:CatalogueCandle)=>c.high-c.low;
const upper=(c:CatalogueCandle)=>c.high-Math.max(c.open,c.close);
const lower=(c:CatalogueCandle)=>Math.min(c.open,c.close)-c.low;
const top=(c:CatalogueCandle)=>Math.max(c.open,c.close);
const bot=(c:CatalogueCandle)=>Math.min(c.open,c.close);
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
  /** The v1 short-body rule (:short_body) for an earlier candle in a formation. */
  const isShortAt=(k:number)=>{const m=priorMean(closed,k,body);return m!=null&&body(closed[k]!)>0&&LT(body(closed[k]!),.5*m);};
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
      if(range(a)>0&&r>0){
        if(t==="up"&&GT(c.low,a.high))add(risingWindow,i-1,i,`The second low ${p(c.low)} is above the first high ${p(a.high)}, leaving an observed gap of ${p(c.low-a.high)} after a rise. Whether it will hold is unknown.`,t,a.high);
        if(t==="down"&&LT(c.high,a.low))add(fallingWindow,i-1,i,`The second high ${p(c.high)} is below the first low ${p(a.low)}, leaving an observed gap of ${p(a.low-c.high)} after a decline. Whether it will hold is unknown.`,t,a.low);
      }
      if(firstLong&&isDoji(c)){
        if(bullish&&LT(Math.max(c.open,c.close),Math.min(a.open,a.close)))add(dojiStarUp,i-1,i,`A long down body was followed by a Doji body below ${p(Math.min(a.open,a.close))}. Only two candles are observed; there is no third-candle confirmation.`,t);
        if(bearish&&GT(Math.min(c.open,c.close),Math.max(a.open,a.close)))add(dojiStarDown,i-1,i,`A long up body was followed by a Doji body above ${p(Math.max(a.open,a.close))}. Only two candles are observed; there is no third-candle confirmation.`,t);
      }
      if(ar!=null&&t==="down"&&down(a)&&down(c)&&LE(Math.abs(c.close-a.close),.05*ar))add(matchingLow,i-1,i,`Two down candles closed at ${p(a.close)} and ${p(c.close)}, within a tolerance of ${p(.05*ar)} after a decline. Their lows need not match; future support is unknown.`,t,a.close);
      if(firstLong&&bullish&&down(c)&&meanBody!=null&&LE(b,meanBody)&&LE(b,.5*ab)&&LT(c.open,a.open)&&GT(c.close,a.close))add(homing,i-1,i,`A smaller down body from ${p(c.open)} to ${p(c.close)} sits inside the prior down body after a decline. This containment is observed, not a proven reversal.`,t);
      if(firstLong&&bullish&&up(c)&&LT(c.open,a.low)&&ar!=null){
        const tolerance=.05*ar;
        if(LE(Math.abs(c.close-a.low),tolerance))add(onNeck,i-1,i,`The up candle opened below ${p(a.low)} and closed at ${p(c.close)}, near the prior low within ${p(tolerance)}. The rebound is observed; continuation is unknown.`,t,a.low);
        if(GE(c.close,a.close)&&LE(c.close,a.close+tolerance))add(inNeck,i-1,i,`After opening below the prior low, the up candle closed at ${p(c.close)}, no more than ${p(tolerance)} above the prior close ${p(a.close)}. This records the shallow rebound only.`,t,a.close);
        if(GT(c.close,a.close+tolerance)&&LE(c.close,midpoint))add(thrusting,i-1,i,`The up candle closed at ${p(c.close)}, beyond the near-close tolerance but at or below the prior body's midpoint ${p(midpoint)}. This partial recovery does not predict what follows.`,t,midpoint);
      }
      if(ar!=null&&long&&LE(Math.abs(c.open-a.open),.05*ar)){
        const bullish=t==="up"&&down(a)&&up(c)&&LE(l,.05*r),bearish=t==="down"&&up(a)&&down(c)&&LE(u,.05*r);
        if(bullish||bearish)add(bullish?separatingUp:separatingDown,i-1,i,`Opposite candles opened at ${p(a.open)} and ${p(c.open)}, within ${p(.05*ar)}. The second long body returned toward the prior trend with a very small opening-side shadow. Only that completed move is observed.`,t,c.open);
      }
      if(firstLong&&long){
        const bothMarubozu=LE(upper(a),.05*range(a))&&LE(lower(a),.05*range(a))&&LE(u,.05*r)&&LE(l,.05*r);
        if(bothMarubozu&&down(a)&&up(c)&&GT(c.low,a.high))add(kickerUp,i-1,i,`Opposite long bodies with very small shadows are separated by a full upward gap of ${p(c.low-a.high)}. The gap and body change are observed; continuation remains unknown.`,"none",a.high);
        if(bothMarubozu&&up(a)&&down(c)&&LT(c.high,a.low))add(kickerDown,i-1,i,`Opposite long bodies with very small shadows are separated by a full downward gap of ${p(a.low-c.high)}. The gap and body change are observed; continuation remains unknown.`,"none",a.low);
        const kickingGap=(down(a)&&up(c)&&GT(c.low,a.high))||(up(a)&&down(c)&&LT(c.high,a.low));
        if(bothMarubozu&&kickingGap&&(GT(b,ab)||LT(b,ab))){
          const longer=GT(b,ab)?c:a;
          add(kickingLength,i-1,i,`The two opposite, gapped Marubozu bodies measure ${p(ab)} and ${p(b)}. The longer body is ${up(longer)?"up":"down"}; this is a length classification, not a forecast of the next candle.`,"none");
        }
        if(ar!=null&&LE(Math.abs(c.close-a.close),.05*ar)&&((bullish&&up(c))||(bearish&&down(c))))add(bullish?counterUp:counterDown,i-1,i,`Opposite long candles closed at ${p(a.close)} and ${p(c.close)} after a ${bullish?"decline":"rise"}; near-equality tolerance is ${p(.05*ar)}. This is a recorded meeting of closes, not proof of a reversal.`,t,a.close);
      }
    }
    if(i>=2&&contiguous(closed,i-2,i,intervalSeconds)){
      const a=closed[i-2]!,mid=closed[i-1]!,ab=body(a),mb=body(mid),am=priorMean(closed,i-2,body),t=trendBefore(closed,i-2,intervalSeconds),half=a.open/2+a.close/2;
      if(am!=null&&GT(ab,am)&&LE(mb,ab*.3)&&long){
        const bullish=t==="down"&&down(a)&&up(c)&&LT(Math.max(mid.open,mid.close),Math.min(a.open,a.close))&&GT(c.open,Math.max(mid.open,mid.close))&&GT(c.close,half);
        const bearish=t==="up"&&up(a)&&down(c)&&GT(Math.min(mid.open,mid.close),Math.max(a.open,a.close))&&LT(c.open,Math.min(mid.open,mid.close))&&LT(c.close,half);
        if(bullish||bearish)add(isDoji(mid)?(bullish?morningDoji:eveningDoji):(bullish?morning:evening),i-2,i,`A long ${bullish?"down":"up"} candle was followed by a gapped ${isDoji(mid)?"Doji":"small body"}; the third close ${p(c.close)} passed the first body's midpoint ${p(half)}. The three-candle shape is observed, not a proven reversal.`,t,half);
      }
      const declining=t==="down"&&down(a),rising=t==="up"&&up(a),firstLong=am!=null&&GT(ab,am);
      if(isDoji(a)&&isDoji(mid)&&isDoji(c)){
        const bullish=t==="down"&&LT(Math.max(mid.open,mid.close),Math.min(a.open,a.close))&&GT(Math.min(c.open,c.close),Math.min(mid.open,mid.close));
        const bearish=t==="up"&&GT(Math.min(mid.open,mid.close),Math.max(a.open,a.close))&&LT(Math.max(c.open,c.close),Math.max(mid.open,mid.close));
        if(bullish||bearish)add(bullish?triUp:triDown,i-2,i,`Three Doji bodies were observed after a ${bullish?"decline":"rise"}. The middle body gapped ${bullish?"below":"above"} the first, and the last body moved back from that extreme. No subsequent reversal is established.`,t);
      }
      const nearRange=priorMean(closed,i-1,range);
      if(nearRange!=null&&LE(Math.abs(mb-b),.25*nearRange)){
        const bullish=t==="up"&&up(mid)&&down(c)&&GT(mid.open,Math.max(a.open,a.close))&&GT(c.open,mid.open)&&LT(c.open,mid.close)&&LT(c.close,mid.open)&&GT(c.close,Math.max(a.open,a.close));
        const bearish=t==="down"&&down(mid)&&up(c)&&LT(mid.open,Math.min(a.open,a.close))&&GT(c.open,mid.close)&&LT(c.open,mid.open)&&GT(c.close,mid.open)&&LT(c.close,Math.min(a.open,a.close));
        if(bullish||bearish)add(bullish?tasukiUp:tasukiDown,i-2,i,`The last candle opened inside the preceding body and closed at ${p(c.close)}, inside the remaining body gap. The last two body lengths are ${p(mb)} and ${p(b)}, within ${p(.25*nearRange)}. Whether the gap persists is unknown.`,t,bullish?Math.max(a.open,a.close):Math.min(a.open,a.close));
      }
      if(firstLong&&isDoji(mid)&&long){
        const bullish=declining&&up(c)&&LT(mid.high,a.low)&&GT(c.low,mid.high)&&GT(c.close,half);
        const bearish=rising&&down(c)&&GT(mid.low,a.high)&&LT(c.high,mid.low)&&LT(c.close,half);
        if(bullish||bearish)add(bullish?abandonedUp:abandonedDown,i-2,i,`The middle Doji is separated from both neighbours by full high-low gaps. The final close ${p(c.close)} passed the first body's midpoint ${p(half)}. This three-candle observation does not establish a future reversal.`,t,half);
      }
      const middleInside=GT(Math.min(mid.open,mid.close),Math.min(a.open,a.close))&&LT(Math.max(mid.open,mid.close),Math.max(a.open,a.close));
      if(firstLong&&LE(mb,ab*.5)&&middleInside){
        const bullish=declining&&up(c)&&GT(c.close,a.open),bearish=rising&&down(c)&&LT(c.close,a.open);
        if(bullish||bearish)add(bullish?insideUp:insideDown,i-2,i,`After a contained second body, the third close ${p(c.close)} moved beyond the first open ${p(a.open)}. The three-candle progression is observed; its future outcome remains unknown.`,t,a.open);
      }
      const outsideBull=declining&&up(mid)&&GT(mid.close,a.open)&&LT(mid.open,a.close)&&GT(c.close,mid.close);
      const outsideBear=rising&&down(mid)&&GT(mid.open,a.close)&&LT(mid.close,a.open)&&LT(c.close,mid.close);
      if(outsideBull||outsideBear)add(outsideBull?outsideUp:outsideDown,i-2,i,`The middle body engulfed the first body; the third close ${p(c.close)} moved beyond the middle close ${p(mid.close)}. That follow-through already happened; additional movement is unproven.`,t,mid.close);
      const middleMean=priorMean(closed,i-1,body);
      const bodiesSustained=am!=null&&middleMean!=null&&meanBody!=null&&GE(ab,am)&&GE(mb,middleMean)&&GE(b,meanBody)&&GE(mb,.75*ab)&&GE(b,.75*mb);
      if(bodiesSustained){
        const bullish=t==="down"&&up(a)&&up(mid)&&up(c)&&GT(mid.close,a.close)&&GT(c.close,mid.close)
          &&GT(mid.open,a.open)&&LT(mid.open,a.close)&&GT(c.open,mid.open)&&LT(c.open,mid.close)
          &&LE(upper(a),.1*range(a))&&LE(upper(mid),.1*range(mid))&&LE(u,.1*r);
        const bearish=t==="up"&&down(a)&&down(mid)&&down(c)&&LT(mid.close,a.close)&&LT(c.close,mid.close)
          &&LT(mid.open,a.open)&&GT(mid.open,a.close)&&LT(c.open,mid.open)&&GT(c.open,mid.close)
          &&LE(lower(a),.1*range(a))&&LE(lower(mid),.1*range(mid))&&LE(l,.1*r);
        if(bullish||bearish)add(bullish?soldiers:crows,i-2,i,`Three ${bullish?"up":"down"} bodies closed successively at ${p(a.close)}, ${p(mid.close)}, and ${p(c.close)}; later opens were inside preceding bodies and the bodies did not sharply shrink. Only this completed progression is observed.`,t);
      }
      const gapUp=t==="up"&&up(a)&&up(mid)&&GT(mid.open,a.close)&&down(c)&&GT(c.open,mid.open)&&LT(c.open,mid.close)&&GT(c.close,a.open)&&LT(c.close,a.close);
      const gapDown=t==="down"&&down(a)&&down(mid)&&LT(mid.open,a.close)&&up(c)&&LT(c.open,mid.open)&&GT(c.open,mid.close)&&LT(c.close,a.open)&&GT(c.close,a.close);
      if(gapUp||gapDown)add(gapUp?gapMethodsUp:gapMethodsDown,i-2,i,`The second body gapped ${gapUp?"above":"below"} the first; the third candle opened at ${p(c.open)} inside the second body and closed at ${p(c.close)} inside the first body, filling the body gap. The fill is observed; what follows is unknown.`,t,a.close);
      if(nearRange!=null&&up(mid)&&up(c)&&LE(Math.abs(c.open-mid.open),.05*nearRange)&&LE(Math.abs(b-mb),.25*nearRange)){
        const sideBySideUp=t==="up"&&GT(bot(mid),top(a))&&GT(bot(c),top(a));
        const sideBySideDown=t==="down"&&LT(top(mid),bot(a))&&LT(top(c),bot(a));
        if(sideBySideUp||sideBySideDown)add(sideBySideUp?sideUp:sideDown,i-2,i,`Two up candles opened at ${p(mid.open)} and ${p(c.open)} (tolerance ${p(.05*nearRange)}) with bodies ${p(mb)} and ${p(b)} (tolerance ${p(.25*nearRange)}), both ${sideBySideUp?"above":"below"} the first body. Whether the gap persists is unknown.`,t,sideBySideUp?top(a):bot(a));
      }
      const e1=priorMean(closed,i-2,range);
      if(e1!=null&&nearRange!=null&&meanRange!=null&&t==="up"&&down(a)&&down(mid)&&down(c)&&LT(mid.close,a.close)&&LT(c.close,mid.close)
        &&LT(lower(a),.1*e1)&&LT(lower(mid),.1*nearRange)&&LT(l,.1*meanRange)&&LE(Math.abs(mid.open-a.close),.05*e1)&&LE(Math.abs(c.open-mid.close),.05*nearRange))
        add(identicalCrows,i-2,i,`Three down candles closed at ${p(a.close)}, ${p(mid.close)} and ${p(c.close)}; each later open was within ${p(.05*e1)} or ${p(.05*nearRange)} of the previous close, and lower shadows were very short. Only this completed progression is observed.`,t,a.close);
      if(t==="up"&&up(a)&&firstLong&&down(mid)&&GT(mid.close,a.close)&&down(c)){
        if(GT(c.open,mid.close)&&LT(c.open,mid.open)&&GT(c.close,a.open)&&LT(c.close,a.close))add(twoCrows,i-2,i,`A down body gapped above the long up body; the third candle opened at ${p(c.open)} inside it and closed at ${p(c.close)} inside the first body. The fill is observed; what follows is unknown.`,t,a.close);
        if(isShortAt(i-1)&&GT(c.open,mid.open)&&LT(c.close,mid.close)&&GT(c.close,a.close))add(gapTwoCrows,i-2,i,`Two down bodies sat above the long up body's close ${p(a.close)}; the third body (${p(c.open)} to ${p(c.close)}) covered the second and stayed above that close. Whether the gap persists is unknown.`,t,a.close);
      }
      const equalRange=e1;
      if(equalRange!=null&&t==="down"&&down(a)&&up(mid)&&down(c)&&GT(mid.low,a.close)&&LE(Math.abs(c.close-a.close),.05*equalRange))add(stickSandwich,i-2,i,`Down candles closed at ${p(a.close)} and ${p(c.close)}, within ${p(.05*equalRange)}, around an up candle whose low ${p(mid.low)} stayed above the first close. Matching closes do not establish future support.`,t,a.close);
      if(t==="down"&&down(a)&&firstLong&&down(mid)&&GT(mid.close,a.close)&&LE(mid.open,a.open)&&LT(mid.low,a.low)&&up(c)&&isShortAt(i)&&GT(c.open,mid.low))add(uniqueRiver,i-2,i,`The second down candle reached a lower low ${p(mid.low)} while closing above the first close ${p(a.close)}; a small up body then opened at ${p(c.open)}, above that low. No subsequent reversal is established.`,t,mid.low);
      if(nearRange!=null&&meanRange!=null&&t==="down"&&down(a)&&firstLong&&GT(lower(a),ab)&&down(mid)&&LT(mb,ab)&&GT(mid.open,a.close)&&LE(mid.open,a.high)&&LT(mid.low,a.close)&&GE(mid.low,a.low)&&GT(lower(mid),.1*nearRange)
        &&down(c)&&isShortAt(i)&&LT(u,.1*meanRange)&&LT(l,.1*meanRange)&&GT(c.low,mid.low)&&LT(c.high,mid.high))
        add(threeStars,i-2,i,`After a long down candle with a long lower shadow (low ${p(a.low)}), a smaller down body held a low of ${p(mid.low)}; a short down candle then traded inside the second range, low ${p(c.low)}. The shape is observed; a reversal is unproven.`,t,c.low);
    }
    if(i>=3&&contiguous(closed,i-3,i,intervalSeconds)){
      const a=closed[i-3]!,m1=closed[i-2]!,m2=closed[i-1]!;
      const threeUp=up(a)&&up(m1)&&up(m2)&&down(c),threeDown=down(a)&&down(m1)&&down(m2)&&up(c);
      const n1=threeUp||threeDown?priorMean(closed,i-3,range):null,n2=threeUp||threeDown?priorMean(closed,i-2,range):null;
      if(n1!=null&&n2!=null){
        const t=trendBefore(closed,i-3,intervalSeconds);
        const opensNear=GE(m1.open,bot(a)-.25*n1)&&LE(m1.open,top(a)+.25*n1)&&GE(m2.open,bot(m1)-.25*n2)&&LE(m2.open,top(m1)+.25*n2);
        const bullish=t==="up"&&threeUp&&opensNear&&GT(m1.close,a.close)&&GT(m2.close,m1.close)&&GT(c.open,m2.close)&&LT(c.close,a.open);
        const bearish=t==="down"&&threeDown&&opensNear&&LT(m1.close,a.close)&&LT(m2.close,m1.close)&&LT(c.open,m2.close)&&GT(c.close,a.open);
        if(bullish||bearish)add(bullish?strikeUp:strikeDown,i-3,i,`Three ${bullish?"up":"down"} candles closed at ${p(a.close)}, ${p(m1.close)} and ${p(m2.close)}; the fourth opened at ${p(c.open)} and closed at ${p(c.close)}, ${bullish?"below":"above"} the first open ${p(a.open)}. The observed strike implies no next move.`,t,a.open);
      }
    }
    if(i>=4&&contiguous(closed,i-4,i,intervalSeconds)){
      const a=closed[i-4]!,r1=closed[i-3]!,r2=closed[i-2]!,r3=closed[i-1]!,ab=body(a),reactions=[r1,r2,r3];
      const risingShape=up(a)&&down(r1)&&up(c),fallingShape=down(a)&&up(r1)&&up(r2)&&up(r3)&&down(c),ladderShape=down(a)&&down(r1)&&down(r2)&&down(r3)&&up(c);
      const t=risingShape||fallingShape||ladderShape?trendBefore(closed,i-4,intervalSeconds):"none";
      if(ladderShape){
        const shadowRange=priorMean(closed,i-1,range);
        if(shadowRange!=null&&t==="down"&&GT(a.open,r1.open)&&GT(r1.open,r2.open)&&GT(a.close,r1.close)&&GT(r1.close,r2.close)&&GT(upper(r3),.1*shadowRange)&&GT(c.open,r3.open)&&GT(c.close,r3.high))
          add(ladderBottom,i-4,i,`Three down candles stepped lower; the fourth showed an upper shadow of ${p(upper(r3))}; the up candle opened at ${p(c.open)} and closed at ${p(c.close)}, above the fourth high ${p(r3.high)}. No subsequent reversal is established.`,t,r3.high);
      }
      if(risingShape||fallingShape){
        const am=priorMean(closed,i-4,body),firstLong=am!=null&&GT(ab,am);
        const shortReactions=isShortAt(i-3)&&isShortAt(i-2)&&isShortAt(i-1);
        const contained=reactions.every(r=>GE(bot(r),a.low)&&LE(top(r),a.high));
        const rising=t==="up"&&risingShape&&down(r2)&&down(r3)&&firstLong&&shortReactions&&contained&&LE(r1.close,a.close)&&LT(r2.close,r1.close)&&LT(r3.close,r2.close)&&long&&GT(c.open,r3.close)&&GT(c.close,a.close);
        const falling=t==="down"&&fallingShape&&firstLong&&shortReactions&&contained&&GE(r1.close,a.close)&&GT(r2.close,r1.close)&&GT(r3.close,r2.close)&&long&&LT(c.open,r3.close)&&LT(c.close,a.close);
        if(rising||falling)add(rising?risingMethods:fallingMethods,i-4,i,`Three short reaction bodies stayed within the first high-low range ${p(a.low)}-${p(a.high)}; the fifth candle closed at ${p(c.close)}, ${rising?"above":"below"} the first close ${p(a.close)}. The resumed move is observed; continuation is unknown.`,t,a.close);
        const highest=Math.max(r1.high,r2.high,r3.high),floor=a.close-.5*ab;
        const held=[r2,r3].every(r=>LT(bot(r),a.close)&&GT(bot(r),floor));
        if(t==="up"&&risingShape&&firstLong&&shortReactions&&GT(r1.close,a.close)&&held&&LT(top(r2),r1.open)&&LT(top(r3),top(r2))&&GT(c.open,r3.close)&&GT(c.close,highest))add(matHold,i-4,i,`A short down body gapped above the first body; later reaction bodies held above ${p(floor)}. The fifth candle closed at ${p(c.close)}, above the highest reaction high ${p(highest)}. Continuation is unknown.`,t,a.close);
      }
    }
  }
  return {status:"ready",reason:null,observations,closedBars:closed.length,criteriaVersion:CANDLE_CRITERIA_VERSION};
}
