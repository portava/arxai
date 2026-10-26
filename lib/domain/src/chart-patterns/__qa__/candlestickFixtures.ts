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
];
