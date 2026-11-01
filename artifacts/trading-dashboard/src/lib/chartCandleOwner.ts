/** One owner check for the normalized transport response and every contained
 * candle. This proves selection consistency only, not provider authenticity. */
export function matchesChartCandleOwner(value:unknown,symbol:string,timeframe:string):boolean {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const r=value as Record<string,unknown>,feed=r.feedStatus as Record<string,unknown>|null;
 if(r.symbol!==symbol||r.timeframe!==timeframe||!Array.isArray(r.candles)||!feed||typeof feed!=='object'||Array.isArray(feed)||feed.symbol!==symbol||typeof feed.source!=='string'||!feed.source.trim())return false;
 return r.candles.every(row=>row&&typeof row==='object'&&!Array.isArray(row)&&row.symbol===symbol&&row.timeframe===timeframe&&row.source===feed.source);
}
