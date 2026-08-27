-- Phase 6 additive schema, part 2 — the guided forensic ledger.
--
-- Authored by drizzle-kit from lib/db/src/schema/index.ts, filtered to the one
-- new table. Additive only: no DROP, no CASCADE, no ALTER of anything existing.
-- Re-running is a no-op.
--
-- Still avoids the pre-existing broker_hub_accounts drift that blocks
-- drizzle-kit push. That remains a separate, unfixed defect.

BEGIN;

CREATE TABLE IF NOT EXISTS "guided_attempt_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"intent_id" text NOT NULL,
	"ticket_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"live_command_id" text,
	"event_type" text NOT NULL,
	"sequence_no" integer NOT NULL,
	"constitution_version" integer NOT NULL,
	"venue_contract_ref" text,
	"scanner_signal_id" text,
	"ruby_explanation" text,
	"detail" text DEFAULT '' NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "guided_attempt_events_intent_seq_uq" ON "guided_attempt_events" USING btree ("intent_id","sequence_no");
CREATE INDEX IF NOT EXISTS "guided_attempt_events_intent_idx" ON "guided_attempt_events" USING btree ("intent_id");
CREATE INDEX IF NOT EXISTS "guided_attempt_events_user_idx" ON "guided_attempt_events" USING btree ("user_id");
CREATE INDEX IF NOT EXISTS "guided_attempt_events_ticket_idx" ON "guided_attempt_events" USING btree ("ticket_id");

COMMIT;
