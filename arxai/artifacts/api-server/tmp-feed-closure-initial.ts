import {writeFileSync} from 'node:fs';
import {pool} from '@workspace/db';
import {getMarketProvider} from './src/lib/assistant/marketProvider.js';
import {getMarketHttpObservations} from './src/lib/assistant/marketHttp.js';
const evidence:any={at:new Date().toISOString(),configured:Object.fromEntries(['TWELVEDATA_API_KEY','POLYGON_API_KEY','FINNHUB_API_KEY','ALPHA_VANTAGE_API_KEY'].map(k=>[k,!!process.env[k]])),database:{},provider:getMarketProvider().name,feeds:[]};
await pool.query('BEGIN READ ONLY');
for(const t of ['eleanor_signal_outcomes','agent_predictions']){
 const present=await pool.query('select to_regclass($1) as name',[t]);
 if(!present.rows[0]?.name){evidence.database[t]={exists:false};continue;}
 evidence.database[t]=(await pool.query(`select symbol,timeframe,direction,decision,outcome_status,count(*)::int as count from ${t} group by 1,2,3,4,5 order by count(*) desc limit 30`)).rows;
}
await pool.query('ROLLBACK');
for(const symbol of ['CADJPY','CHFJPY','DXY']){
 const p=getMarketProvider();const bars=await p.getCandles(symbol,'M1',30);const q=await p.getLiveQuote(symbol);
 evidence.feeds.push({symbol,candles:{count:bars.candles.length,source:bars.source,freshness:bars.freshness,notes:bars.notes,last:bars.candles.at(-1)},quote:q});
}
evidence.http=getMarketHttpObservations();writeFileSync('/tmp/arx-feed-closure-initial.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));await pool.end();process.exit(0);
