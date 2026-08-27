-- Phase 6 additive schema.
--
-- Authored by drizzle-kit 0.31.9 from lib/db/src/schema/index.ts, then filtered
-- to ONLY the Phase 6 delta. Not hand-written, so it cannot drift from the
-- Drizzle definitions it came from.
--
-- WHY THIS FILE EXISTS INSTEAD OF push-force: drizzle-kit push currently fails
-- on PRE-EXISTING drift in broker_hub_accounts, unrelated to Phase 6. It tries
-- to recreate a unique constraint that two foreign keys depend on, without
-- CASCADE. That is a separate defect and this file deliberately does not touch it.
--
-- Every statement below only creates. Re-running is a no-op, not an error.

BEGIN;

CREATE TABLE IF NOT EXISTS "approval_tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"broker" text NOT NULL,
	"account_ref" text NOT NULL,
	"instrument" text NOT NULL,
	"side" text NOT NULL,
	"stake_usd" double precision NOT NULL,
	"multiplier" double precision NOT NULL,
	"stop_loss_usd" double precision,
	"take_profit_usd" double precision,
	"intent_id" text NOT NULL,
	"approved_fingerprint" text,
	"approved_by_user_id" integer,
	"approved_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"rejected_by_user_id" integer,
	"rejection_source" text,
	"rejection_reason" text,
	"dispatch_claimed_at" timestamp with time zone,
	"live_command_id" text,
	"venue_contract_ref" text,
	"expires_at" timestamp with time zone NOT NULL,
	"constitution_version" integer NOT NULL,
	"gate_verdicts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"gate_verdicts_passed" boolean DEFAULT false NOT NULL,
	"disclosure_waived_by_operator" boolean DEFAULT false NOT NULL,
	"scanner_signal_id" text,
	"ruby_explanation" text,
	"risk_evaluation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reference_quote" double precision,
	"expected_payout_usd" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_tickets_ticket_id_unique" UNIQUE("ticket_id")
);

CREATE TABLE IF NOT EXISTS "deriv_order_intents" (
	"id" serial PRIMARY KEY NOT NULL,
	"intent_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"ticket_id" text,
	"live_command_id" text,
	"account_ref" text NOT NULL,
	"instrument" text NOT NULL,
	"side" text NOT NULL,
	"stake_usd" double precision NOT NULL,
	"multiplier" double precision NOT NULL,
	"write_disposition" text DEFAULT 'NOT_ATTEMPTED' NOT NULL,
	"req_id" integer,
	"transport_instance_id" text,
	"venue_contract_ref" text,
	"protection_readback" jsonb,
	"attempted_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"absence_proven_closed_inclusive_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deriv_order_intents_intent_id_unique" UNIQUE("intent_id")
);

CREATE TABLE IF NOT EXISTS "trading_constitutions" (
	"id" serial PRIMARY KEY NOT NULL,
	"constitution_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"version" integer NOT NULL,
	"allowed_brokers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_account_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_instruments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_market_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_sessions_utc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_risk_per_trade_usd" double precision NOT NULL,
	"max_daily_loss_usd" double precision NOT NULL,
	"max_weekly_loss_usd" double precision,
	"max_simultaneous_positions" integer NOT NULL,
	"max_exposure_per_symbol_usd" double precision NOT NULL,
	"max_trades_per_day" integer NOT NULL,
	"require_stop_loss" boolean DEFAULT true NOT NULL,
	"require_take_profit" boolean DEFAULT false NOT NULL,
	"min_stake_usd" double precision NOT NULL,
	"max_stake_usd" double precision NOT NULL,
	"min_multiplier" double precision NOT NULL,
	"max_multiplier" double precision NOT NULL,
	"loss_streak_cooldown" jsonb,
	"forbidden_instruments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"forbidden_conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ruby_authority" text DEFAULT 'EXPLAIN' NOT NULL,
	"supersedes_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "approval_tickets_user_state_idx" ON "approval_tickets" USING btree ("user_id","state");
CREATE INDEX IF NOT EXISTS "approval_tickets_expires_idx" ON "approval_tickets" USING btree ("expires_at");
CREATE UNIQUE INDEX IF NOT EXISTS "approval_tickets_intent_uq" ON "approval_tickets" USING btree ("intent_id");
CREATE UNIQUE INDEX IF NOT EXISTS "approval_tickets_active_uq" ON "approval_tickets" USING btree ("user_id","account_ref","instrument") WHERE state in ('PENDING','APPROVED','DISPATCHING','UNRESOLVED');
CREATE INDEX IF NOT EXISTS "deriv_order_intents_user_idx" ON "deriv_order_intents" USING btree ("user_id");
CREATE INDEX IF NOT EXISTS "deriv_order_intents_ticket_idx" ON "deriv_order_intents" USING btree ("ticket_id");
CREATE UNIQUE INDEX IF NOT EXISTS "deriv_order_intents_req_uq" ON "deriv_order_intents" USING btree ("transport_instance_id","req_id");
CREATE INDEX IF NOT EXISTS "deriv_order_intents_unresolved_idx" ON "deriv_order_intents" USING btree ("user_id","write_disposition") WHERE resolved_at is null and write_disposition in ('WRITTEN','UNRECORDED');
CREATE UNIQUE INDEX IF NOT EXISTS "trading_constitutions_user_version_uq" ON "trading_constitutions" USING btree ("user_id","version");
CREATE INDEX IF NOT EXISTS "trading_constitutions_cid_idx" ON "trading_constitutions" USING btree ("constitution_id");
CREATE INDEX IF NOT EXISTS "trading_constitutions_user_idx" ON "trading_constitutions" USING btree ("user_id");

-- The one change to an existing table: a new column with a backfill default.
-- Every existing arx_live_commands row was bound to an mt5_connection by
-- construction, so recording them as MT5_EA_BRIDGE states something already
-- true. It is NOT a runtime fallback: routeExecutionVenue has no default, and
-- the check-execution-venue-explicit guard requires every INSERT to name a venue.
ALTER TABLE "arx_live_commands" ADD COLUMN IF NOT EXISTS "execution_venue" text DEFAULT 'MT5_EA_BRIDGE' NOT NULL;

COMMIT;
