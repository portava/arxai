import {writeFileSync} from 'node:fs';
const p=process.env.POLYGON_API_KEY,f=process.env.FINNHUB_API_KEY;
const calls=[['polygon_fx','https://api.polygon.io/v3/reference/tickers?market=fx&search=CADJPY&active=true&limit=10&apiKey='+encodeURIComponent(p??'')],['polygon_index','https://api.polygon.io/v3/reference/tickers?market=indices&search=Dollar&active=true&limit=100&apiKey='+encodeURIComponent(p??'')],['finnhub_fx','https://finnhub.io/api/v1/forex/symbol?exchange=oanda&token='+encodeURIComponent(f??'')]];
const out=[];for(const [label,url] of calls){try{const r=await fetch(url!,{signal:AbortSignal.timeout(12000)});const j=await r.json();out.push({label,status:r.status,data:label==='finnhub_fx'&&Array.isArray(j)?j.filter(x=>/CAD.JPY|CHF.JPY|USD.*index|dollar.*index/i.test(JSON.stringify(x))):j})}catch{out.push({label,error:'transport'})}}
writeFileSync('/tmp/arx-feed-catalog.json',JSON.stringify(out,null,2));console.log(JSON.stringify(out));
