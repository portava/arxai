import type { CatalogueCandle } from "../candlestickCatalogue.js";
type OHLC=Pick<CatalogueCandle,"open"|"high"|"low"|"close">;
const row=(open:number,high:number,low:number,close:number):OHLC=>({open,high,low,close});
export const CATALOGUE_START=1_700_000_000;
export function observed(rows:readonly OHLC[]):CatalogueCandle[]{return rows.map((b,i)=>({...b,time:CATALOGUE_START+i*300,closeTime:CATALOGUE_START+(i+1)*300,isComplete:true,isFinal:true,isForming:false}));}
function prefix(trend:"up"|"down"|"flat"="flat"):OHLC[]{return Array.from({length:12},(_,i)=>{const close=trend==="up"?80+i*2:trend==="down"?124-i*2:102+(i%2)*.2;return row(close-1,close+.75,close-1.75,close);});}
const make=(tail:OHLC[],trend:"up"|"down"|"flat"="flat")=>observed([...prefix(trend),...tail]);
export const mirror=(bars:readonly CatalogueCandle[])=>bars.map(b=>({...b,open:250-b.open,high:250-b.low,low:250-b.high,close:250-b.close}));
const first=row(103,103.5,98.5,99);
const morningTail=[first,row(98,98.7,97.7,98.4),row(98.6,102.5,98.2,102)];
const morningDojiTail=[first,row(98,98.4,97.6,98.01),row(98.6,102.5,98.2,102)];
const abandonedTail=[first,row(97,97.5,96.5,97.01),row(98,102.5,97.8,102)];
const insideTail=[first,row(100,101,99.8,100.8),row(100.5,104.5,100,104)];
const outsideTail=[first,row(98,104.3,97.5,104),row(104,105.5,103.8,105)];
const soldierTail=[row(101,105.2,100.8,105),row(103,107.2,102.8,107),row(105,109.2,104.8,109)];
const windowTail=[row(103,105,102,104),row(106,108,105.5,107)];
const kickerTail=[row(103,103,99,99),row(104,108,104,108)];
const triTail=[row(102,102.5,101.5,102.01),row(101,101.5,100.5,101.01),row(101.5,102,101,101.51)];
const tasukiTail=[row(103,104.3,102.8,104),row(106,108.2,105.8,108),row(107.5,107.8,105.2,105.5)];
const separatingTail=[row(103,103.2,100.8,101),row(103.05,107.3,103.04,107.05)];
const risingTail=[row(102,106.2,101.8,106),row(105.6,105.8,104.9,105.1),row(105.1,105.3,104.4,104.6),row(104.6,104.8,103.9,104.1),row(104.3,107.2,104.1,107)];
// The strike's shadows (.8 of an 8.6 range) stay above 5% so it is not also a Marubozu or Belt Hold.
const strikeTail=[row(102,104.2,101.8,104),row(103,106.2,102.8,106),row(105,108.2,104.8,108),row(108.5,109.3,100.7,101.5)];
// The third candle keeps shadows above 5% of its range so it is not also a Marubozu or Belt Hold.
const gap3Tail=[row(102.5,105.2,102.3,105),row(106,108.2,105.8,108),row(107.5,107.9,103,103.5)];
const sbsUpTail=[row(102,104.7,101.8,104.5),row(105.5,107.2,105.3,107),row(105.55,107.3,105.4,107.1)];
// Hand-built rather than mirrored: mirror() would turn both white lines black.
const sbsDownTail=[row(101.5,101.7,99.3,99.5),row(97.5,99,97.3,98.8),row(97.55,99.1,97.4,98.9)];
const matHoldTail=[row(102,106.2,101.8,106),row(106.8,107,106.1,106.3),row(106.2,106.4,105.4,105.7),row(105.9,106,105.1,105.4),row(105.6,108.2,105.5,108)];
export const CANDLE_FIXTURES:{id:string;bars:CatalogueCandle[]}[]=[
{id:"white_candle",bars:make([row(102,104,101,103)])},
{id:"black_candle",bars:make([row(103,104,101,102)])},
{id:"long_body",bars:make([row(102,107,101,106)])},
{id:"short_body",bars:make([row(102,103,101,102.3)])},
{id:"spinning_top",bars:make([row(102,103.2,101.2,102.4)])},
{id:"high_wave",bars:make([row(102,105,99,102.8)])},
{id:"bullish_marubozu",bars:make([row(102,106,102,106)])},
{id:"bearish_marubozu",bars:make([row(106,106,102,102)])},
{id:"opening_marubozu",bars:make([row(102,107,102,106)])},
{id:"closing_marubozu",bars:make([row(102,106,101,106)])},
{id:"doji",bars:make([row(102,104,100,102.1)])},
{id:"long_legged_doji",bars:make([row(102,104,100,102.1)])},
{id:"dragonfly_doji",bars:make([row(102,102.15,98,102.1)])},
{id:"gravestone_doji",bars:mirror(make([row(102,102.15,98,102.1)]))},
{id:"four_price_doji",bars:make([row(102,102,102,102)])},
{id:"rickshaw_man",bars:make([row(102,104,100,102.1)])},
{id:"takuri_line",bars:make([row(102,102.15,98,102.1)],"down")},
{id:"hammer",bars:make([row(102,103,99,102.8)],"down")},
{id:"hanging_man",bars:make([row(102,103,99,102.8)],"up")},
{id:"inverted_hammer",bars:make([row(102,106,101.8,102.8)],"down")},
{id:"bullish_belt_hold",bars:make([row(102,107,102,106)],"down")},
{id:"bearish_belt_hold",bars:mirror(make([row(102,107,102,106)],"down"))},
{id:"bullish_harami",bars:make([first,row(100,101,99.8,100.8)],"down")},
{id:"bearish_harami",bars:mirror(make([first,row(100,101,99.8,100.8)],"down"))},
{id:"bullish_harami_cross",bars:make([first,row(101,101.4,100.6,101.01)],"down")},
{id:"bearish_harami_cross",bars:mirror(make([first,row(101,101.4,100.6,101.01)],"down"))},
{id:"piercing_line",bars:make([first,row(98,102.5,97.5,102)],"down")},
{id:"dark_cloud_cover",bars:mirror(make([first,row(98,102.5,97.5,102)],"down"))},
{id:"tweezer_bottom",bars:make([first,row(99,101.5,98.55,101)],"down")},
{id:"tweezer_top",bars:mirror(make([first,row(99,101.5,98.55,101)],"down"))},
{id:"morning_star",bars:make(morningTail,"down")},
{id:"evening_star",bars:mirror(make(morningTail,"down"))},
{id:"morning_doji_star",bars:make(morningDojiTail,"down")},
{id:"evening_doji_star",bars:mirror(make(morningDojiTail,"down"))},
{id:"rising_window",bars:make(windowTail,"up")},
{id:"falling_window",bars:mirror(make(windowTail,"up"))},
{id:"bullish_abandoned_baby",bars:make(abandonedTail,"down")},
{id:"bearish_abandoned_baby",bars:mirror(make(abandonedTail,"down"))},
{id:"three_inside_up",bars:make(insideTail,"down")},
{id:"three_inside_down",bars:mirror(make(insideTail,"down"))},
{id:"three_outside_up",bars:make(outsideTail,"down")},
{id:"three_outside_down",bars:mirror(make(outsideTail,"down"))},
{id:"three_white_soldiers",bars:make(soldierTail,"down")},
{id:"three_black_crows",bars:mirror(make(soldierTail,"down"))},
{id:"bullish_doji_star",bars:make(morningDojiTail.slice(0,2),"down")},
{id:"bearish_doji_star",bars:mirror(make(morningDojiTail.slice(0,2),"down"))},
{id:"bullish_kicking",bars:make(kickerTail)},
{id:"bearish_kicking",bars:mirror(make(kickerTail))},
{id:"bullish_counterattack",bars:make([first,row(95,99.3,94.5,99.05)],"down")},
{id:"bearish_counterattack",bars:mirror(make([first,row(95,99.3,94.5,99.05)],"down"))},
{id:"matching_low",bars:make([first,row(101,101.3,98,99.05)],"down")},
{id:"homing_pigeon",bars:make([first,row(102,102.2,100.8,101)],"down")},
{id:"on_neck",bars:make([first,row(97,98.7,96.8,98.55)],"down")},
{id:"in_neck",bars:make([first,row(97,99.3,96.8,99.05)],"down")},
{id:"thrusting",bars:make([first,row(97,100.3,96.8,100)],"down")},
{id:"bullish_separating_lines",bars:make(separatingTail,"up")},
{id:"bearish_separating_lines",bars:mirror(make(separatingTail,"up"))},
{id:"bullish_tri_star",bars:make(triTail,"down")},
{id:"bearish_tri_star",bars:mirror(make(triTail,"down"))},
{id:"upside_tasuki_gap",bars:make(tasukiTail,"up")},
{id:"downside_tasuki_gap",bars:mirror(make(tasukiTail,"up"))},
{id:"kicking_by_length",bars:make([row(103,103,99,99),row(104,109,104,109)])},
{id:"rising_three_methods",bars:make(risingTail,"up")},
{id:"falling_three_methods",bars:mirror(make(risingTail,"up"))},
{id:"bullish_three_line_strike",bars:make(strikeTail,"up")},
{id:"bearish_three_line_strike",bars:mirror(make(strikeTail,"up"))},
{id:"upside_gap_three_methods",bars:make(gap3Tail,"up")},
{id:"downside_gap_three_methods",bars:mirror(make(gap3Tail,"up"))},
{id:"upside_gap_side_by_side_white_lines",bars:make(sbsUpTail,"up")},
{id:"downside_gap_side_by_side_white_lines",bars:make(sbsDownTail,"down")},
{id:"mat_hold",bars:make(matHoldTail,"up")},
{id:"identical_three_crows",bars:mirror(make([row(101,105.2,100.8,105),row(105,109.2,104.8,109),row(109,113.2,108.8,113)],"down"))},
{id:"two_crows",bars:make([row(102,106.2,101.8,106),row(107,107.5,106.3,106.5),row(106.8,107,103.8,104)],"up")},
{id:"upside_gap_two_crows",bars:make([row(102,106.2,101.8,106),row(107,107.3,106.1,106.6),row(107.2,107.4,106.2,106.3)],"up")},
{id:"stick_sandwich",bars:make([row(101.5,101.7,99.3,99.5),row(100,101.8,99.8,101.5),row(101.6,101.9,99.4,99.55)],"down")},
{id:"unique_three_river_bottom",bars:make([row(103,103.2,99.3,99.5),row(101,101.2,98.5,100.2),row(99.6,100,99.5,99.9)],"down")},
{id:"three_stars_in_the_south",bars:make([row(102,102.2,95,99.5),row(100.5,100.7,97.5,98.5),row(98.6,98.65,98.05,98.1)],"down")},
{id:"ladder_bottom",bars:make([row(101.5,101.7,99.3,99.5),row(100,100.2,97.8,98),row(98.5,98.7,96.3,96.5),row(96.8,97.8,95.6,95.8),row(97,99.2,96.9,99)],"down")},
];
