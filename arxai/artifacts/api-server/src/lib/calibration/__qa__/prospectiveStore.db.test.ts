import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {setTimeout as delay} from "node:timers/promises";
import {db,calibrationFitsTable,eleanorSignalOutcomesTable} from "@workspace/db";
import {eq,sql} from "drizzle-orm";
import {registerProspective,readProspectiveReport} from "../prospectiveStore.js";
import {evaluateProspective} from "../prospectiveEvaluation.js";
import {fixturePlan} from "./prospectiveFixtures.js";
const dbError=(text:string)=>(error:unknown)=>String((error as {cause?:Error}).cause?.message??(error as Error).message).includes(text);
const migrationUrl=new URL("../../../../../../lib/db/migrations/2026-11-12_calibration_prospective_v1.sql",import.meta.url);
const rollbackUrl=new URL("../../../../../../lib/db/migrations/2026-11-12_calibration_prospective_v1.rollback.sql",import.meta.url);

test("prospective Postgres registration/capture is scoped, frozen, complete and safely reversible",async()=>{
 const migration=await readFile(migrationUrl,"utf8"),rollback=await readFile(rollbackUrl,"utf8");
 await db.execute(sql.raw(migration));
 const symbol=`PR${randomUUID().replaceAll("-","").slice(0,12)}`,owner=990042;
 const fixture=fixturePlan();
 for(const [version,fit] of [[1,fixture.baseline.fit],[2,fixture.candidate.fit]] as const) await db.insert(calibrationFitsTable).values({
 fitKey:`eleanor|${symbol}|M15`,version,source:"test",strategy:"eleanor",symbol,timeframe:"M15",method:fit.method,status:fit.status,model:fit.model,n:fit.n,wins:fit.wins,fit:fit as unknown as Record<string,unknown>,
 fittedAt:new Date(Date.now()-60000),dataTo:new Date(Date.now()-120000)});
 const start=Date.now()+600,end=start+1000,deadline=end+1000;
 const input={userId:owner,strategy:"eleanor" as const,symbol,timeframe:"M15",candidateVersion:2,baselineVersion:1,
 collectionStart:new Date(start).toISOString(),collectionEnd:new Date(end).toISOString(),labelDeadline:new Date(deadline).toISOString()};
 const run=await registerProspective(input);
 await assert.rejects(registerProspective(input),dbError("Overlapping"));
 await assert.rejects(readProspectiveReport(owner+1,run.id),/NOT_FOUND/);
 await assert.rejects(db.execute(sql`UPDATE calibration_prospective_runs_v1 SET canonical_plan='{}' WHERE id=${run.id}`),dbError("append-only"));
 // Source fit changes cannot rewrite the already registered model snapshot.
 await db.update(calibrationFitsTable).set({fit:{...fixture.candidate.fit,baseRate:0.1}}).where(eq(calibrationFitsTable.fitKey,`eleanor|${symbol}|M15`));
 const snapshot=await db.execute(sql`SELECT canonical_plan FROM calibration_prospective_runs_v1 WHERE id=${run.id}`);
 assert.equal(JSON.parse(String(snapshot.rows[0].canonical_plan)).candidate.fit.baseRate,0.9);
 await delay(Math.max(0,start-Date.now()+10));
 const outcomeId=randomUUID(),now=new Date();
 const values={outcomeId,userId:owner,symbol,timeframe:"M15",direction:"BUY",decision:"approve",confidenceScore:50,locked:true,lockedAt:now,createdAt:now};
 await db.insert(eleanorSignalOutcomesTable).values(values);
 await db.insert(eleanorSignalOutcomesTable).values({...values,outcomeId:randomUUID(),userId:owner+1});
 await db.insert(eleanorSignalOutcomesTable).values({...values,outcomeId:randomUUID(),direction:"NONE"});
 await delay(5);
 await db.update(eleanorSignalOutcomesTable).set({outcomeStatus:"WIN",resolvedAt:new Date(),evidence:{method:"observed_move",favorableMovePct:1,adverseMovePct:0}}).where(eq(eleanorSignalOutcomesTable.outcomeId,outcomeId));
 let receipts=await db.execute(sql`SELECT phase FROM calibration_prospective_receipts_v1 WHERE run_id=${run.id} ORDER BY id`);
 assert.deepEqual(receipts.rows.map(r=>r.phase),["prediction","outcome"]);
 const captured=await db.execute(sql`SELECT outcome_id,phase,observed_at,payload FROM calibration_prospective_receipts_v1 WHERE run_id=${run.id} ORDER BY id`);
 const honest=evaluateProspective(JSON.parse(String(snapshot.rows[0].canonical_plan)),run.registeredAt,captured.rows.map(r=>({outcomeId:String(r.outcome_id),phase:String(r.phase),observedAt:(r.observed_at instanceof Date ? r.observed_at : new Date(String(r.observed_at))).toISOString(),payload:r.payload as Record<string,unknown>})),deadline+1);
 assert.equal(honest.resolved,1,"real DB capture preserves millisecond prediction/label chronology");
 assert.ok(!honest.reasons.includes("INVALID_OBSERVATION_TIMING_OR_SCOPE"));
 await db.update(eleanorSignalOutcomesTable).set({confidenceScore:99}).where(eq(eleanorSignalOutcomesTable.outcomeId,outcomeId));
 await db.delete(eleanorSignalOutcomesTable).where(eq(eleanorSignalOutcomesTable.outcomeId,outcomeId));
 receipts=await db.execute(sql`SELECT phase FROM calibration_prospective_receipts_v1 WHERE run_id=${run.id} ORDER BY id`);
 assert.deepEqual(receipts.rows.map(r=>r.phase),["prediction","outcome","mutation","deletion"]);
 await assert.rejects(db.execute(sql`DELETE FROM calibration_prospective_receipts_v1 WHERE run_id=${run.id}`),dbError("append-only"));
 // Terminal closed-trade evidence cannot be silently restated after capture.
 const closedId=randomUUID(),closedAt=new Date();
 await db.insert(eleanorSignalOutcomesTable).values({...values,outcomeId:closedId,createdAt:closedAt,lockedAt:closedAt});
 await delay(5);
 await db.update(eleanorSignalOutcomesTable).set({outcomeStatus:"WIN",resolvedAt:new Date(),evidence:{method:"closed_trade"},pnlR:1,tradeId:111}).where(eq(eleanorSignalOutcomesTable.outcomeId,closedId));
 await db.update(eleanorSignalOutcomesTable).set({pnlR:-1}).where(eq(eleanorSignalOutcomesTable.outcomeId,closedId));
 await db.update(eleanorSignalOutcomesTable).set({tradeId:222}).where(eq(eleanorSignalOutcomesTable.outcomeId,closedId));
 const revised=await db.execute(sql`SELECT phase,payload FROM calibration_prospective_receipts_v1 WHERE run_id=${run.id} AND outcome_id=${closedId} ORDER BY id`);
 assert.deepEqual(revised.rows.map(r=>r.phase),["prediction","outcome","outcome","outcome"]);
 assert.deepEqual(revised.rows.slice(1).map(r=>(r.payload as Record<string,unknown>).pnl_r),[1,-1,-1]);
 assert.equal((revised.rows[3].payload as Record<string,unknown>).trade_id,222);
 assert.equal((await readProspectiveReport(owner,run.id)).status,"COLLECTING");
 await delay(Math.max(0,deadline-Date.now()+10));
 const report=await readProspectiveReport(owner,run.id);
 assert.equal(report.status,"REFUSED");assert.equal(report.captured,2);assert.equal(report.liveAllowed,false);
 // Rollback removes only capture. Old evidence remains readable via SQL; app
 // evaluation refuses absent capture, including after reinstallation's new epoch.
 await db.execute(sql.raw(rollback));
 await assert.rejects(readProspectiveReport(owner,run.id),/CONTINUITY_UNVERIFIED/);
 await assert.rejects(registerProspective({...input,collectionStart:new Date(Date.now()+1000).toISOString()}),/NOT_INSTALLED/);
 const before=Number((await db.execute(sql`SELECT count(*)::int AS n FROM calibration_prospective_receipts_v1 WHERE run_id=${run.id}`)).rows[0].n);
 await db.insert(eleanorSignalOutcomesTable).values({...values,outcomeId:randomUUID()});
 assert.equal(Number((await db.execute(sql`SELECT count(*)::int AS n FROM calibration_prospective_receipts_v1 WHERE run_id=${run.id}`)).rows[0].n),before);
 await db.execute(sql.raw(migration));
 await assert.rejects(readProspectiveReport(owner,run.id),/CONTINUITY_UNVERIFIED/);
 // Both apply and rollback work after schema push; legacy source writes remain
 // functional without registered matching cohorts.
 await db.insert(eleanorSignalOutcomesTable).values({...values,outcomeId:randomUUID(),symbol:"UNREGISTERED"});
});
