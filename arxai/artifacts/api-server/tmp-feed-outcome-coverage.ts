import {pool} from '@workspace/db';
import {writeFileSync} from 'node:fs';
const out:any={at:new Date().toISOString(),tables:{}};
await pool.query('BEGIN READ ONLY');for(const t of ['shadow_predictions','chart_decision_receipts','chart_decision_outcomes','agent_prediction_reviews']){const exists=(await pool.query('select to_regclass($1) as name',[t])).rows[0]?.name;if(!exists){out.tables[t]={exists:false};continue;}out.tables[t]=(await pool.query(`select count(*)::int as count from ${t}`)).rows[0];}await pool.query('ROLLBACK');await pool.end();
const r=await fetch('https://api.polygon.io/v3/reference/tickers?market=indices&search=DXY&active=true&limit=100&apiKey='+encodeURIComponent(process.env.POLYGON_API_KEY??''),{signal:AbortSignal.timeout(10000)});const data=await r.json();out.dxyCatalog={status:r.status,data};writeFileSync('/tmp/arx-feed-outcome-coverage.json',JSON.stringify(out,null,2));console.log(JSON.stringify(out));
