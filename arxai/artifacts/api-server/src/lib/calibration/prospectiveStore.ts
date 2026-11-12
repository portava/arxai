// Explicit operator harness. No worker, HTTP endpoint, model activation or order path.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, calibrationFitsTable } from "@workspace/db";
import { stableStringify } from "@workspace/features/event-chain";
import type { CalibrationFit } from "@workspace/domain/calibration";
import { evaluateProspective, prospectiveHash, validateProspectivePlan, PROSPECTIVE_METHOD, type ProspectivePlan, type Receipt } from "./prospectiveEvaluation.js";

const iso = (value: unknown) => (value instanceof Date ? value : new Date(String(value))).toISOString();

type Scope = Pick<ProspectivePlan,"userId"|"strategy"|"symbol"|"timeframe"|"collectionStart"|"collectionEnd"|"labelDeadline">;
export async function registerProspective(input: Scope & { candidateVersion: number; baselineVersion: number; minSample?: number; minImprovement?: number }): Promise<{id:string;planHash:string;registeredAt:string}> {
  return db.transaction(async tx => {
    const capture = await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='eleanor_signal_outcomes'::regclass AND tgname='calibration_prospective_capture' AND tgenabled IN ('O','A')) AS enabled`);
    if (capture.rows[0]?.enabled !== true) throw new Error("PROSPECTIVE_CAPTURE_NOT_INSTALLED");
    const key = `${input.strategy}|${input.symbol}|${input.timeframe}`;
    const freeze = async (version:number) => {
      const [row] = await tx.select().from(calibrationFitsTable).where(and(eq(calibrationFitsTable.fitKey,key),eq(calibrationFitsTable.version,version))).limit(1);
      if (!row || !row.dataTo) throw new Error("FROZEN_CALIBRATION_VERSION_MISSING");
      return {fitKey:key,version,fittedAt:row.fittedAt.toISOString(),dataTo:row.dataTo.toISOString(),fit:row.fit as unknown as CalibrationFit};
    };
    const result = await tx.execute(sql`SELECT clock_timestamp() AS now`);
    const at = iso(result.rows[0].now);
    const plan:ProspectivePlan = {method:PROSPECTIVE_METHOD,userId:input.userId,strategy:input.strategy,symbol:input.symbol,timeframe:input.timeframe,
      collectionStart:input.collectionStart,collectionEnd:input.collectionEnd,labelDeadline:input.labelDeadline,minSample:input.minSample??100,minImprovement:input.minImprovement??0.005,
      candidate:await freeze(input.candidateVersion),baseline:await freeze(input.baselineVersion)};
    validateProspectivePlan(plan,at);
    const id=randomUUID(), canonical=stableStringify(plan), hash=prospectiveHash(plan);
    const inserted=await tx.execute(sql`INSERT INTO calibration_prospective_runs_v1(id,owner_id,strategy,symbol,timeframe,collection_start,collection_end,label_deadline,canonical_plan,plan_hash)
      VALUES(${id},${plan.userId},${plan.strategy},${plan.symbol},${plan.timeframe},${plan.collectionStart},${plan.collectionEnd},${plan.labelDeadline},${canonical},${hash}) RETURNING registered_at`);
    return {id,planHash:hash,registeredAt:iso(inserted.rows[0].registered_at)};
  });
}

export async function readProspectiveReport(userId:number,id:string) {
  // One consistent DB snapshot prevents labels/receipt coverage changing midway.
  return db.transaction(async tx => {
    const result=await tx.execute(sql`SELECT canonical_plan,plan_hash,registered_at,clock_timestamp() AS now FROM calibration_prospective_runs_v1 WHERE id=${id} AND owner_id=${userId}`);
    const run=result.rows[0]; if(!run) throw new Error("PROSPECTIVE_RUN_NOT_FOUND");
    const plan=JSON.parse(String(run.canonical_plan)) as ProspectivePlan;
    if(prospectiveHash(plan)!==run.plan_hash) throw new Error("PROSPECTIVE_PLAN_INTEGRITY_FAILED");
    const registeredAt=iso(run.registered_at);
    const capture=await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='eleanor_signal_outcomes'::regclass AND tgname='calibration_prospective_capture' AND tgenabled IN ('O','A')) AS enabled,
      (SELECT max(installed_at) FROM calibration_prospective_installations_v1) AS installed_at`);
    if(capture.rows[0]?.enabled!==true || Date.parse(iso(capture.rows[0].installed_at))>Date.parse(registeredAt)) throw new Error("PROSPECTIVE_CAPTURE_CONTINUITY_UNVERIFIED");
    const records=await tx.execute(sql`SELECT outcome_id,phase,observed_at,payload FROM calibration_prospective_receipts_v1 WHERE run_id=${id} ORDER BY id LIMIT 100001`);
    if(records.rows.length>100000) throw new Error("PROSPECTIVE_RECEIPT_LIMIT_EXCEEDED");
    const receipts:Receipt[]=records.rows.map(r=>({outcomeId:String(r.outcome_id),phase:String(r.phase),observedAt:iso(r.observed_at),payload:r.payload as Record<string,unknown>}));
    return evaluateProspective(plan,registeredAt,receipts,Date.parse(iso(run.now)));
  },{isolationLevel:"repeatable read",accessMode:"read only"});
}
