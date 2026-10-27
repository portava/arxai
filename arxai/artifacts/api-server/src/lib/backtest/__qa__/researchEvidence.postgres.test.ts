import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { cpus, release, totalmem } from "node:os";
import { createRequire } from "node:module";
import type { pool as workspacePool } from "@workspace/db";
type Pool = typeof workspacePool;
// pg exposes the callback overload last; extract its non-null client type.
type PoolClient = NonNullable<Parameters<Parameters<Pool["connect"]>[0]>[1]>;
const pg = createRequire(import.meta.resolve("@workspace/db"))("pg") as { Pool: new(options: { connectionString?:string; max?:number; application_name?:string; options?:string }) => Pool };
import { ResearchEvidenceStore, ResearchEvidenceError, RESEARCH_STORAGE_LIMITS, type ResearchRecordRequest } from "../researchEvidence.js";
import { runCausalResearch } from "@workspace/domain/backtest/research";
import { input, config, workload, workloadConfig } from "./causalResearch.fixture.js";

assert.equal(process.env.ARX_RESEARCH_EVIDENCE_PG,"1","Run only through the disposable PostgreSQL runner");
const url=new URL(process.env.DATABASE_URL!);
assert.ok(url.searchParams.get("host")?.includes("arx-research-evidence-"));
assert.equal(url.pathname,"/arx_research_evidence_test");
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:8}),store=new ResearchEvidenceStore(pool);
let nextOwner=1;
const context=async()=>{const id=nextOwner++;await pool.query("INSERT INTO users(id) VALUES($1)",[id]);return {authenticatedOwnerId:id};};
const request=(bars?:number):ResearchRecordRequest=>{
  const datasetId=randomUUID(),data=bars?workload(bars):input();data.source.reference=datasetId;
  return {requestId:randomUUID(),datasetId,input:data,config:bars?workloadConfig(bars):config()};
};
const code=(expected:string)=>(error:unknown)=>error instanceof ResearchEvidenceError&&error.code===expected;
const digest=(text:string)=>createHash("sha256").update(text).digest("hex");
const migration=readFileSync(new URL("../../../../../../lib/db/migrations/2026-10-26_research_experiments_v1.sql",import.meta.url),"utf8");
before(async()=>{await pool.query("CREATE TABLE users(id integer PRIMARY KEY)");await pool.query(migration);await pool.query(migration);});
after(async()=>{await pool.end();});

test("durable record roundtrips exact engine input/config/output and immutable manifest",async()=>{
  const ctx=await context(),req=request(),expected=runCausalResearch(req.input,req.config),record=await store.record(ctx,req);
  assert.equal(record.storage.committed,true);assert.equal(record.storage.disposition,"created");
  assert.deepEqual(record.result,expected);assert.equal(record.result.authority.persistedExperiment,false);
  assert.deepEqual(record.result.authority,{promotionEligible:false,brokerVerified:false,persistedExperiment:false});
  assert.equal(record.manifest.inputHash,expected.fingerprints.input);assert.equal(record.manifest.resultHash,expected.fingerprints.result);
  const read=await store.read(ctx,record.manifest.experimentId);assert.deepEqual(read!.result,expected);
  assert.equal(read!.storage.manifestHash,record.storage.manifestHash);assert.ok(Object.isFrozen(read!.result.inputSnapshot.bars[0]));
});
test("decimal price-unit values survive exact text roundtrip without legacy float4 loss",async()=>{
  const ctx=await context(),req=request();req.input.bars=req.input.bars.map((b,i)=>({...b,open:1.123456789012+i*.000000001,close:1.123456789012+i*.000000001,high:1.123456799999,low:1.123456700001}));
  req.config.strategy.stopDistancePriceUnits=.00000001;req.config.strategy.targetDistancePriceUnits=.00000002;
  const record=await store.record(ctx,req),read=await store.read(ctx,record.manifest.experimentId);
  assert.deepEqual(read!.result,runCausalResearch(req.input,req.config));assert.equal(read!.result.inputSnapshot.bars[0]!.close,1.123456789012);
});
test("32 concurrent identical submissions accept exactly one experiment",async()=>{
  const ctx=await context(),req=request(),results=await Promise.all(Array.from({length:32},()=>store.record(ctx,structuredClone(req))));
  assert.equal(results.filter(r=>r.storage.disposition==="created").length,1);
  assert.equal(new Set(results.map(r=>r.manifest.experimentId)).size,1);
  const rows=await pool.query("SELECT count(*)::int AS count FROM research_experiments_v1 WHERE owner_id=$1",[ctx.authenticatedOwnerId]);assert.equal(rows.rows[0].count,1);
});
test("conflicting same key cannot replace a result, including dataset/source/config/input changes",async()=>{
  const ctx=await context(),req=request(),original=await store.record(ctx,req);
  for(const change of [
    (r:ResearchRecordRequest)=>{r.datasetId=randomUUID();r.input.source.reference=r.datasetId;},
    (r:ResearchRecordRequest)=>{r.input.source.kind="historical_unattested";},
    (r:ResearchRecordRequest)=>{r.config.costs.feePerFillPriceUnits=.1;},
    (r:ResearchRecordRequest)=>{r.input.bars[0]!.high+=1;},
  ]){const changed=structuredClone(req);change(changed);await assert.rejects(store.record(ctx,changed),code("REQUEST_KEY_CONFLICT"));}
  assert.equal((await store.read(ctx,original.manifest.experimentId))!.storage.manifestHash,original.storage.manifestHash);
});
test("competing different inputs with one key have exactly one durable winner",async()=>{
  const ctx=await context(),a=request(),b=structuredClone(a);b.config.costs.feePerFillPriceUnits=.01;
  const results=await Promise.allSettled([store.record(ctx,a),store.record(ctx,b)]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  const rejected=results.find(r=>r.status==="rejected") as PromiseRejectedResult;assert.ok(code("REQUEST_KEY_CONFLICT")(rejected.reason));
});
test("owner scope covers reads, lists and request keys without cross-owner disclosure",async()=>{
  const a=await context(),b=await context(),req=request(),one=await store.record(a,req),two=await store.record(b,req);
  assert.notEqual(one.manifest.experimentId,two.manifest.experimentId);assert.equal(await store.read(b,one.manifest.experimentId),null);
  const page=await store.listMetadata(b);assert.equal(page.items.length,1);assert.equal(page.items[0]!.manifest.ownerId,b.authenticatedOwnerId);
  assert.equal(page.items[0]!.payloadVerified,false);assert.equal("result" in page.items[0]!,false);
});
test("bounded stable keyset pages expose metadata only and reject invalid limits/cursors",async()=>{
  const ctx=await context();for(let i=0;i<5;i++)await store.record(ctx,request());
  const seen:string[]=[];let cursor:undefined|{recordedAt:string;experimentId:string};
  do{const page=await store.listMetadata(ctx,{limit:2,cursor});seen.push(...page.items.map(i=>i.manifest.experimentId));cursor=page.nextCursor??undefined;}while(cursor);
  assert.equal(seen.length,5);assert.equal(new Set(seen).size,5);
  await assert.rejects(store.listMetadata(ctx,{limit:51}),code("INVALID_RESEARCH_REQUEST"));
  await assert.rejects(store.listMetadata(ctx,{cursor:{recordedAt:"bad",experimentId:randomUUID()}}),code("INVALID_RESEARCH_REQUEST"));
});
test("same-owner storage cap serializes contenders; exact retry still works at capacity",async()=>{
  const ctx=await context(),originalReq=request(),original=await store.record(ctx,originalReq);
  for(let i=1;i<255;i++)await store.record(ctx,request());
  const results=await Promise.allSettled([store.record(ctx,request()),store.record(ctx,request())]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  assert.ok(code("OWNER_STORAGE_LIMIT")((results.find(r=>r.status==="rejected") as PromiseRejectedResult).reason));
  assert.equal((await store.record(ctx,originalReq)).manifest.experimentId,original.manifest.experimentId);
  const conflicting=structuredClone(originalReq);conflicting.config.costs.feePerFillPriceUnits=.1;
  await assert.rejects(store.record(ctx,conflicting),code("REQUEST_KEY_CONFLICT"));
  assert.equal((await store.record(await context(),request())).storage.disposition,"created");
});
async function cloneStoredRow(client:Pick<PoolClient,"query">, row:any) {
  const id=randomUUID(),requestId=randomUUID(),manifest={...JSON.parse(row.canonical_manifest),experimentId:id,requestId};
  const canonical=JSON.stringify(manifest);
  await client.query(`INSERT INTO research_experiments_v1
    SELECT $2::uuid,owner_id,$3::uuid,dataset_id,manifest_version,engine_version,strategy_version,input_hash,configuration_hash,strategy_hash,result_hash,payload_hash,$4,input_bars,payload_bytes,canonical_payload,$5,created_at
    FROM research_experiments_v1 WHERE id=$1`,[row.id,id,requestId,digest(canonical),canonical]);
}
test("nondefault repeatable-read pool is explicitly reset to READ COMMITTED before a quota wait",async()=>{
  const ctx=await context(),original=await store.record(ctx,request());
  const row=(await pool.query("SELECT * FROM research_experiments_v1 WHERE id=$1",[original.manifest.experimentId])).rows[0];
  for(let i=1;i<255;i++)await cloneStoredRow(pool as any,row);
  const rrPool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:2,application_name:"research_rr_quota_test",options:"-c default_transaction_isolation=repeatable\\ read"});
  const blocker=await pool.connect();
  try {
    assert.equal((await rrPool.query("SHOW transaction_isolation")).rows[0].transaction_isolation,"repeatable read");
    await blocker.query("BEGIN");await blocker.query("SELECT pg_advisory_xact_lock(1095915602,$1)",[ctx.authenticatedOwnerId]);
    const pending=Promise.allSettled([new ResearchEvidenceStore(rrPool).record(ctx,request()),new ResearchEvidenceStore(rrPool).record(ctx,request())]);
    let waiting=false;
    for(let i=0;i<100;i++){
      const rows=await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='research_rr_quota_test' AND wait_event='advisory'");
      if(rows.rows[0].n===2){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.ok(waiting,"both actual transactions must wait before quota slot is committed");
    await cloneStoredRow(blocker,row);await blocker.query("COMMIT");
    const results=await pending;assert.equal(results.filter(r=>r.status==="fulfilled").length,0);
    for(const result of results)assert.ok(result.status==="rejected"&&code("OWNER_STORAGE_LIMIT")(result.reason));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM research_experiments_v1 WHERE owner_id=$1",[ctx.authenticatedOwnerId])).rows[0].n,256);
  } finally {await blocker.query("ROLLBACK");blocker.release();await rrPool.end();}
});
test("direct non-READ-COMMITTED inserts are refused instead of using a stale quota snapshot",async()=>{
  const ctx=await context(),original=await store.record(ctx,request()),row=(await pool.query("SELECT * FROM research_experiments_v1 WHERE id=$1",[original.manifest.experimentId])).rows[0];
  for(const level of ["REPEATABLE READ","SERIALIZABLE"]){const client=await pool.connect();
    try{await client.query(`BEGIN ISOLATION LEVEL ${level}`);await assert.rejects(cloneStoredRow(client,row),/RESEARCH_READ_COMMITTED_REQUIRED/);}
    finally{await client.query("ROLLBACK");client.release();}
  }
});
test("rollback failure destroys the uncertain client instead of returning it to the pool",async()=>{
  const ctx=await context(),dedicated=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
  let discarded=false,oldPid=0;
  const fault=new ResearchEvidenceStore({query:dedicated.query.bind(dedicated),connect:async()=>{
    const client=await dedicated.connect();oldPid=(await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    return new Proxy(client,{get(target,key){
      if(key==="query")return async(text:string,...args:unknown[])=>{if(text.startsWith("INSERT")||text==="ROLLBACK")throw new Error("controlled transport failure");return (target.query as any)(text,...args);};
      if(key==="release")return (destroy:boolean)=>{discarded=destroy;target.release(destroy);};
      const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
    }}) as PoolClient;
  }} as any);
  try{await assert.rejects(fault.record(ctx,request()),code("RESEARCH_EVIDENCE_UNAVAILABLE"));assert.equal(discarded,true);
    assert.notEqual((await dedicated.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,oldPid);
    assert.equal((await new ResearchEvidenceStore(dedicated).record(ctx,request())).storage.committed,true);
  }finally{await dedicated.end();}
});
function denseRequest(bars:number):ResearchRecordRequest {
  const req=request(bars);req.config.strategy.lookbackBars=1;req.config.strategy.thresholdPriceUnits=0;
  req.config.strategy.stopDistancePriceUnits=.000123456789012345;req.config.strategy.targetDistancePriceUnits=.000234567890123456;
  req.config.costs={fullSpreadPriceUnits:.000001234567890123,adverseSlippagePerFillPriceUnits:.000001234567890123,feePerFillPriceUnits:.000001234567890123};
  return req;
}
test("actual valid engine output over8MiB is refused before persistence, without padding",async()=>{
  const req=denseRequest(10000),sentinel=new ResearchEvidenceStore({connect:()=>{throw new Error("DB reached");},query:()=>{throw new Error("DB reached");}} as any);
  assert.ok(Buffer.byteLength(JSON.stringify(runCausalResearch(req.input,req.config)))>RESEARCH_STORAGE_LIMITS.artifactBytes);
  await assert.rejects(sentinel.record({authenticatedOwnerId:1},req),code("ARTIFACT_SIZE_LIMIT"));
});
test("actual byte quota serializes two contenders below count cap; exact retry remains available",async()=>{
  const ctx=await context(),req=denseRequest(8000),first=await store.record(ctx,req);
  const row=(await pool.query("SELECT * FROM research_experiments_v1 WHERE id=$1",[first.manifest.experimentId])).rows[0];
  const capacity=Math.floor(RESEARCH_STORAGE_LIMITS.ownerBytes/first.manifest.payloadBytes);
  assert.ok(capacity>2&&capacity<RESEARCH_STORAGE_LIMITS.ownerRecords);
  // Exact valid output is cloned with fresh request/manifest identities solely
  // to seed the actual SQL boundary; no fabricated bytes or altered limits.
  for(let i=1;i<capacity-1;i++)await cloneStoredRow(pool as any,row);
  const candidates=[{...req,requestId:randomUUID()},{...req,requestId:randomUUID()}];
  const results=await Promise.allSettled(candidates.map(r=>store.record(ctx,r)));
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  assert.ok(code("OWNER_STORAGE_LIMIT")((results.find(r=>r.status==="rejected") as PromiseRejectedResult).reason));
  const totals=(await pool.query("SELECT count(*)::int AS n,sum(payload_bytes)::bigint AS bytes FROM research_experiments_v1 WHERE owner_id=$1",[ctx.authenticatedOwnerId])).rows[0];
  assert.equal(totals.n,capacity);assert.ok(Number(totals.bytes)<=RESEARCH_STORAGE_LIMITS.ownerBytes);
  assert.ok(Number(totals.bytes)+first.manifest.payloadBytes>RESEARCH_STORAGE_LIMITS.ownerBytes);
  assert.equal((await store.record(ctx,req)).manifest.experimentId,first.manifest.experimentId);
  assert.equal((await store.record(await context(),request())).storage.committed,true);
});
test("missing migration prevents record acceptance and leaves the ordinary schema untouched",async()=>{
  const ctx=await context(),missingPool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:"-c search_path=pg_catalog"});
  try{await assert.rejects(new ResearchEvidenceStore(missingPool).record(ctx,request()),code("RESEARCH_EVIDENCE_UNAVAILABLE"));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM research_experiments_v1 WHERE owner_id=$1",[ctx.authenticatedOwnerId])).rows[0].n,0);
  }finally{await missingPool.end();}
});
test("owner lock does not serialize another owner's durable work",async()=>{
  const a=await context(),b=await context(),client=await pool.connect();
  await client.query("BEGIN");await client.query("SELECT pg_advisory_xact_lock(1095915602,$1)",[a.authenticatedOwnerId]);
  let aFinished=false;const pending=store.record(a,request()).finally(()=>{aFinished=true;});
  try{assert.equal((await store.record(b,request())).storage.committed,true);assert.equal(aFinished,false);}
  finally{await client.query("ROLLBACK");client.release();}
  assert.equal((await pending).storage.committed,true);
});
function faultStore(when:"before_insert"|"before_commit"|"after_commit"){
  let active=true;
  return new ResearchEvidenceStore({query:pool.query.bind(pool),connect:async()=>{
    const client=await pool.connect();return new Proxy(client,{get(target,key){
      if(key==="query")return async(text:string,...args:unknown[])=>{
        if(active&&((when==="before_insert"&&text.startsWith("INSERT"))||(when==="before_commit"&&text==="COMMIT"))){active=false;throw new Error("controlled disconnect");}
        const result=await (target.query as any)(text,...args);
        if(active&&when==="after_commit"&&text==="COMMIT"){active=false;throw new Error("controlled commit acknowledgement loss");}
        return result;
      };const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
    }}) as PoolClient;
  }} as any);
}
for(const when of ["before_insert","before_commit","after_commit"] as const)test(`${when} failure never reports acceptance; retry resolves actual committed state`,async()=>{
  const ctx=await context(),req=request(),fault=faultStore(when);
  await assert.rejects(fault.record(ctx,req),code("RESEARCH_EVIDENCE_UNAVAILABLE"));
  const record=await store.record(ctx,req);assert.equal(record.storage.disposition,when==="after_commit"?"existing":"created");
  const rows=await pool.query("SELECT count(*)::int AS count FROM research_experiments_v1 WHERE owner_id=$1",[ctx.authenticatedOwnerId]);assert.equal(rows.rows[0].count,1);
});
test("restarting the store/pool preserves deterministic evidence and retry identity",async()=>{
  const ctx=await context(),req=request(),first=await store.record(ctx,req),secondPool=new pg.Pool({connectionString:process.env.DATABASE_URL});
  try{const restarted=new ResearchEvidenceStore(secondPool);assert.deepEqual((await restarted.read(ctx,first.manifest.experimentId))!.result,first.result);assert.equal((await restarted.record(ctx,req)).manifest.experimentId,first.manifest.experimentId);}
  finally{await secondPool.end();}
});
test("mutation of caller input while awaiting owner lock cannot change prepared evidence",async()=>{
  const ctx=await context(),req=request(),expected=runCausalResearch(req.input,req.config),client=await pool.connect();
  await client.query("BEGIN");await client.query("SELECT pg_advisory_xact_lock(1095915602,$1)",[ctx.authenticatedOwnerId]);
  const pending=store.record(ctx,req);req.config.costs.feePerFillPriceUnits=1;req.input.bars[0]!.high+=10;
  await client.query("COMMIT");client.release();assert.deepEqual((await pending).result,expected);
});
test("UPDATE, DELETE, TRUNCATE and owner deletion cannot silently remove ordinary evidence",async()=>{
  const ctx=await context(),record=await store.record(ctx,request());
  for(const sql of ["UPDATE research_experiments_v1 SET result_hash=result_hash WHERE id=$1","DELETE FROM research_experiments_v1 WHERE id=$1"])
    await assert.rejects(pool.query(sql,[record.manifest.experimentId]),/RESEARCH_EVIDENCE_APPEND_ONLY/);
  await assert.rejects(pool.query("TRUNCATE research_experiments_v1"),/RESEARCH_EVIDENCE_APPEND_ONLY/);
  await assert.rejects(pool.query("DELETE FROM users WHERE id=$1",[ctx.authenticatedOwnerId]),(e:any)=>e.code==="23503");
});
test("read refuses self-consistent stored payload/hash changes whose engine semantic result disagrees",async()=>{
  const ctx=await context(),record=await store.record(ctx,request());
  const row=(await pool.query("SELECT * FROM research_experiments_v1 WHERE id=$1",[record.manifest.experimentId])).rows[0];
  const changed=JSON.parse(row.canonical_payload);changed.partitions[0].metrics.completedNetPriceUnits=12345;
  const payload=JSON.stringify(changed),manifest=JSON.parse(row.canonical_manifest);manifest.payloadHash=digest(payload);manifest.payloadBytes=Buffer.byteLength(payload);
  const canonical=JSON.stringify(manifest),client=await pool.connect();
  try{await client.query("BEGIN");await client.query("ALTER TABLE research_experiments_v1 DISABLE TRIGGER research_experiments_v1_no_change");
    await client.query("UPDATE research_experiments_v1 SET canonical_payload=$2,payload_hash=$3,payload_bytes=$4,canonical_manifest=$5,manifest_hash=$6 WHERE id=$1",[row.id,payload,manifest.payloadHash,manifest.payloadBytes,canonical,digest(canonical)]);
    await client.query("ALTER TABLE research_experiments_v1 ENABLE TRIGGER research_experiments_v1_no_change");await client.query("COMMIT");
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
  await assert.rejects(store.read(ctx,row.id),code("RESEARCH_EVIDENCE_INTEGRITY"));
});
test("missing migration fails explicitly, without fallback to legacy backtests",async()=>{
  const ctx=await context(),client=await pool.connect();
  try{await client.query("BEGIN");await client.query("SET LOCAL search_path TO pg_catalog");
    const missing=new ResearchEvidenceStore({query:client.query.bind(client),connect:async()=>new Proxy(client,{get(target,key){if(key==="release")return()=>{};const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}})} as any);
    await assert.rejects(missing.read(ctx,randomUUID()),code("RESEARCH_EVIDENCE_UNAVAILABLE"));
  }finally{await client.query("ROLLBACK");client.release();}
});
test("unexpected/free-text fields, source-reference rewrites, invalid owner and oversize histories never reach DB",async()=>{
  const ctx=await context(),sentinel=new ResearchEvidenceStore({connect:()=>{throw new Error("DB reached");},query:()=>{throw new Error("DB reached");}} as any);
  for(const mutate of [
    (r:any)=>{r.note="do not persist this prompt";},(r:any)=>{r.input.source.reference="opaque reference was not supplied";},
    (r:any)=>{r.input.apiKey="must not persist";},(r:any)=>{r.input.bars[0].privateAccount="must not persist";},
    (r:any)=>{r.config.password="must not persist";},(r:any)=>{r.input.symbol="invalid symbol ?";},
    (r:any)=>{r.config.costs.feePerFillPriceUnits=-0;},(r:any)=>{r.input.bars[0].openTimeMs=-0;},
    (r:any)=>{r.input.bars[0].close=NaN;},(r:any)=>{r.config.costs.fullSpreadPriceUnits=-1;},
    (r:any)=>{r.input.bars=Array(10001);},(r:any)=>{delete r.input.bars[1];},
  ]){const r=request();mutate(r);await assert.rejects(sentinel.record(ctx,r),code("INVALID_RESEARCH_REQUEST"));}
  await assert.rejects(sentinel.record({authenticatedOwnerId:0},request()),code("INVALID_RESEARCH_REQUEST"));
});

test("paired full completion timing (optional): engine versus engine plus committed evidence",{skip:!process.env.ARX_RESEARCH_EVIDENCE_BENCHMARK_PATH},async()=>{
  const output=process.env.ARX_RESEARCH_EVIDENCE_BENCHMARK_PATH!,ctx=await context(),req=request(5000),startedAt=new Date().toISOString();
  const stats=(samples:number[])=>{const s=[...samples].sort((a,b)=>a-b),q=(p:number)=>s[Math.ceil(p*s.length)-1]!;return {count:s.length,medianMs:q(.5),p95Ms:q(.95),p99Ms:q(.99),maxMs:s.at(-1)};};
  const pairs:{order:string;engineMs:number;committedMs:number}[]=[];
  let latest=await store.record(ctx,req);
  for(let i=0;i<5;i++){runCausalResearch(req.input,req.config);await store.record(ctx,{...req,requestId:randomUUID()});}
  for(let i=0;i<60;i++){
    let engineMs=0,committedMs=0;const current={...req,requestId:randomUUID()};
    const old=()=>{const t=performance.now();runCausalResearch(req.input,req.config);engineMs=performance.now()-t;};
    const persisted=async()=>{const t=performance.now();latest=await store.record(ctx,current);committedMs=performance.now()-t;};
    if(i%2){await persisted();old();}else{old();await persisted();}pairs.push({order:i%2?"committed_then_engine":"engine_then_committed",engineMs,committedMs});
  }
  const readSamples:number[]=[];for(let i=0;i<40;i++){const t=performance.now();const r=await store.read(ctx,latest.manifest.experimentId);readSamples.push(performance.now()-t);assert.equal(r!.storage.payloadVerified,true);}
  const database=(await pool.query("SELECT version() AS version,current_setting('fsync') AS fsync,current_setting('synchronous_commit') AS synchronous_commit,current_setting('transaction_isolation') AS isolation")).rows[0];
  const committed=stats(pairs.map(p=>p.committedMs)),receipt={startedAt,finishedAt:new Date().toISOString(),node:process.version,
    machine:{cpu:cpus()[0]?.model,cores:cpus().length,ramBytes:totalmem(),release:release()},bars:5000,warmups:5,database,poolMaximum:8,artifactBytes:latest.manifest.payloadBytes,
    boundary:"Actual completed return after pure calculation, canonical manifest/hash construction, isolated PostgreSQL transaction and COMMIT acknowledgement; no early acceptance. Read includes pinned-engine semantic recomputation.",
    engine:stats(pairs.map(p=>p.engineMs)),committed,verifiedRead:stats(readSamples),target:{committedP95Ms:100,passed:committed.p95Ms<=100},pairs,readSamples,
    sourceHashes:{engine:digest(readFileSync(new URL("../../../../../../lib/domain/src/backtest/research.ts",import.meta.url),"utf8")),store:digest(readFileSync(new URL("../researchEvidence.ts",import.meta.url),"utf8")),migration:digest(migration)},
    limitations:["Local Unix-socket disposable PostgreSQL, no production/network/replication/competitor performance measurement.","Both paths use same generated midpoint input/config; persistence adds durability/integrity work and is not a speedup claim.","No API, UI or broker acknowledgement/completion is measured."]};
  writeFileSync(output,JSON.stringify(receipt,null,2)+"\n");assert.ok(committed.p95Ms<=100,`Committed p95 ${committed.p95Ms}ms exceeds100ms; receipt retained`);
});
