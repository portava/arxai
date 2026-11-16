// Opt-in migration supplies capture/immutability triggers; schema push alone is
// insufficient. Snapshots are calibration diagnostics, never live permission.
import {pgTable,uuid,integer,text,timestamp,jsonb,bigserial,index} from "drizzle-orm/pg-core";
export const calibrationProspectiveRuns = pgTable("calibration_prospective_runs_v1",{
 id:uuid("id").primaryKey(),ownerId:integer("owner_id").notNull(),strategy:text("strategy").notNull(),symbol:text("symbol").notNull(),timeframe:text("timeframe").notNull(),
 collectionStart:timestamp("collection_start",{withTimezone:true}).notNull(),collectionEnd:timestamp("collection_end",{withTimezone:true}).notNull(),labelDeadline:timestamp("label_deadline",{withTimezone:true}).notNull(),
 canonicalPlan:text("canonical_plan").notNull(),planHash:text("plan_hash").notNull(),registeredAt:timestamp("registered_at",{withTimezone:true}).notNull().defaultNow(),
},t=>({scope:index("calibration_prospective_scope_idx").on(t.ownerId,t.symbol,t.timeframe,t.collectionEnd)}));
export const calibrationProspectiveReceipts=pgTable("calibration_prospective_receipts_v1",{
 id:bigserial("id",{mode:"number"}).primaryKey(),runId:uuid("run_id").notNull().references(()=>calibrationProspectiveRuns.id),outcomeId:text("outcome_id").notNull(),phase:text("phase").notNull(),
 observedAt:timestamp("observed_at",{withTimezone:true}).notNull().defaultNow(),payload:jsonb("payload").notNull(),
},t=>({receipt:index("calibration_prospective_receipt_idx").on(t.runId,t.outcomeId),outcome:index("calibration_prospective_outcome_idx").on(t.outcomeId,t.phase,t.runId)}));
export const calibrationProspectiveInstallations=pgTable("calibration_prospective_installations_v1",{
 id:bigserial("id",{mode:"number"}).primaryKey(),installedAt:timestamp("installed_at",{withTimezone:true}).notNull().defaultNow(),
});
