// Production readiness check — READ ONLY (Tier 1 finalization, items 9 and 10).
//
// Answers, against whatever DATABASE_URL points at:
//   1. Which Tier 1 migrations have their checked schema indicators present.
//      Catalog presence does not prove apply history or data backfills.
//   2. Whether trading is available: the install-wide stop switches the
//      pre-trade Risk Governor reads (lib/safety/tradingHalt.ts), the platform
//      mode and the venue switches. Desired state: TRADING AVAILABLE.
//   3. How many legacy ownerless rows wait for the explicit owner claim. It
//      counts them; it never assigns an owner.
//
// It writes nothing, engages or releases nothing, and claims nothing.
//
// Run: pnpm --filter @workspace/api-server run check:production-readiness [-- --json --strict]

import { pool } from "@workspace/db";
import { KEYED_TABLES, TABLES } from "./claimLegacyBehaviorRows.js";
import { platformStopWith, readPlatformSwitches, stopSourceEngaged } from "../lib/safety/platformSwitches.js";
import { brokerControlBlocks, readBrokerOperatorControls } from "../lib/safety/tradingHalt.js";
import { logger } from "../lib/logger.js";

interface Check { name: string; ok: boolean; detail: string }

async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(text, params)).rows as T[];
}
const hasColumn = async (table: string, column: string) =>
  (await q(`SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`, [table, column])).length > 0;
const columnDefault = async (table: string, column: string) =>
  (await q<{ d: string | null }>(`SELECT column_default AS d FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`, [table, column]))[0]?.d ?? null;
const hasTable = async (table: string) =>
  (await q(`SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1`, [table])).length > 0;
const hasIndex = async (name: string) =>
  (await q(`SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1`, [name])).length > 0;

async function all(checks: Array<Promise<boolean>>): Promise<boolean> {
  return (await Promise.all(checks)).every(Boolean);
}

export async function migrationChecks(): Promise<Check[]> {
  const out: Check[] = [];
  const add = async (name: string, ok: Promise<boolean>, what: string) => out.push({ name, ok: await ok, detail: what });
  await add("2026-10-24_trading_on_by_default", (async () =>
    /LIVE/.test(String(await columnDefault("global_trading_settings", "platform_mode")))
    && /false/.test(String(await columnDefault("global_trading_settings", "emergency_kill_switch")))
    && /true/.test(String(await columnDefault("global_trading_settings", "demo_enabled")))
    && /true/.test(String(await columnDefault("global_trading_settings", "live_enabled"))))(),
    "global_trading_settings defaults: platform_mode LIVE, live_enabled true, emergency_kill_switch false");
  await add("2026-10-24_owner_columns", all([
    hasColumn("weekly_improvement_plans", "user_id"), hasColumn("performance_symbol_snapshots", "user_id"),
    hasColumn("ai_performance_snapshots", "user_id"), hasIndex("weekly_improvement_plans_user_week_uq"),
    hasIndex("perf_sym_snap_user_uq"), hasIndex("ai_perf_snap_user_range_uq"),
  ]), "user_id + per-user unique indexes on 3 shared tables");
  await add("2026-10-24_per_user_risk_limits", all([
    hasColumn("user_risk_settings", "max_leverage"), hasColumn("user_risk_settings", "symbol_limits"),
    hasColumn("user_risk_limits", "max_drawdown_percent"), hasTable("user_equity_peaks"),
  ]), "exposure limit columns + user_equity_peaks");
  await add("2026-10-24_user_risk_profile", all([
    hasColumn("user_risk_settings", "risk_preset"), hasColumn("user_risk_settings", "prop_firm"),
  ]), "risk_preset + prop_firm on user_risk_settings");
  await add("2026-10-24_learning_scopes", all([
    hasColumn("strategy_edges", "scope_type"), hasColumn("mistake_patterns", "scope_owner"),
    hasIndex("strategy_edges_scope_cohort_uq"), hasIndex("mistake_patterns_scope_cohort_uq"),
  ]), "scope columns + scoped unique indexes on strategy_edges / mistake_patterns");
  await add("2026-10-24_trade_action_venue_command", all([
    hasColumn("trade_action_requests", "execution_venue"), hasColumn("trade_action_requests", "venue_command_id"),
  ]), "execution_venue + venue_command_id on trade_action_requests");
  await add("2026-10-24_one_limit_store", hasColumn("user_risk_settings", "legacy_merged_at"),
    "legacy_merged_at column present; data fold requires separate apply/backfill evidence");
  await add("2026-10-25_paper_order_request_key", all([
    hasColumn("paper_orders", "client_request_key"), hasIndex("paper_orders_user_request_key_uq"),
  ]), "client_request_key + per-user unique index on paper_orders (owner decision 13)");
  await add("2026-10-25_trade_action_request_key", all([
    hasColumn("trade_action_requests", "client_request_key"), hasColumn("trade_action_requests", "client_request_hash"),
    hasIndex("trade_action_requests_user_request_key_uq"),
  ]), "user-scoped retry key and immutable request hash on trade actions");
  return out;
}

export interface TradingStatus { verdict: "TRADING AVAILABLE" | "TRADING HALTED" | "UNKNOWN"; checks: Check[] }

export async function tradingStatus(): Promise<TradingStatus> {
  const checks: Check[] = [];
  // Reporting must interpret switches exactly like execution. These readers
  // never seed a row, release a stop or enable a broker control.
  const sw = await readPlatformSwitches();
  const [stop, controls] = await Promise.all([platformStopWith(sw), readBrokerOperatorControls()]);
  let unknown = !sw.readable || !stop.readable || !controls.readable;
  try {
    const [g] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM global_trading_settings`);
    checks.push({ name: "global settings inventory", ok: g?.n === 1,
      detail: `${g?.n ?? 0} row(s); exactly one is expected; duplicates need owner inspection; more than 16 fails closed` });
  } catch { unknown = true; checks.push({ name: "global settings inventory", ok: false, detail: "unreadable" }); }
  checks.push({ name: "global settings readable", ok: sw.readable, detail: sw.readable ? "canonical safety reader" : `unavailable (${sw.unreadableReason}); no row was created` });
  for (const [name, source] of [["platform emergency stop", "platform_emergency_stop"], ["safety-core kill switch", "safety_core_kill_switch"]] as const) {
    const engaged = stopSourceEngaged(stop, source);
    checks.push({ name, ok: !engaged && stop.readable,
      detail: engaged ? `ENGAGED${stop.detail[source] ? ` (${stop.detail[source]})` : ""} — only an owner/operator may release it` : "released" });
  }
  checks.push({ name: "platform mode", ok: sw.platformMode === "LIVE", detail: sw.platformMode });
  for (const venue of ["DEMO", "LIVE"] as const) {
    checks.push({ name: `${venue.toLowerCase()} venue`, ok: sw.venueOpen[venue], detail: sw.venueOpen[venue] ? "open on platform" : "closed by mode or enable flag" });
  }
  const blocks = brokerControlBlocks(controls, { venue: "DEMO", opensNewRisk: true });
  checks.push({ name: "broker operator controls", ok: controls.readable && controls.present && blocks.length === 0,
    detail: !controls.readable ? "unreadable" : !controls.present ? "missing — new broker risk is disabled" : blocks.length ? blocks.join(", ") : "execution enabled; maintenance off" });
  // Intentional disarming is not a deployment failure. Never encourage an
  // operator to arm LIVE just to make a readiness report green.
  checks.push({ name: "live execution arm (informational)", ok: true,
    detail: `environment ${sw.liveBrokerExecution.envEnabled ? "enabled" : "disabled"}; operator ${sw.liveBrokerExecution.operatorArmed ? "armed" : "disarmed"}; individual order gates still apply` });
  try {
    const [t] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM arx_live_arming WHERE kill_switch_engaged`);
    checks.push({ name: "trader kill switches (per user, informational)", ok: true, detail: `${t?.n ?? 0} trader(s) halted themselves` });
  } catch { /* table absent on older installs: informational only */ }
  const halted = checks.some((c) => !c.ok);
  return { verdict: unknown ? "UNKNOWN" : halted ? "TRADING HALTED" : "TRADING AVAILABLE", checks };
}

export async function ownerlessRows(): Promise<Check[]> {
  const out: Check[] = [];
  for (const t of [...TABLES, "weekly_performance_reviews", "weekly_improvement_goals", ...KEYED_TABLES.map((k) => k.table)]) {
    if (!(await hasColumn(t, "user_id"))) { out.push({ name: t, ok: false, detail: "owner column missing (migration not applied)" }); continue; }
    const [r] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE user_id IS NULL`);
    if ((r?.n ?? 0) > 0) out.push({ name: t, ok: true, detail: `${r!.n} ownerless row(s) — retained without assigning an owner; owner must explicitly decide whether to claim` });
  }
  if (!out.length) out.push({ name: "all claimable tables", ok: true, detail: "no ownerless rows" });
  return out;
}

async function main(): Promise<void> {
  // Canonical readers log failures; JSON carries those failures in its checks.
  // Keep stdout a single JSON document even on missing/unreadable state.
  if (process.argv.includes("--json")) logger.level = "silent";
  const [migrations, trading, legacy] = [await migrationChecks(), await tradingStatus(), await ownerlessRows()];
  const pending = migrations.filter((m) => !m.ok).map((m) => m.name);
  const report = {
    at: new Date().toISOString(),
    scope: "Read-only database preflight. No deployment, real provider, broker fill or migration execution history is proven by this report.",
    migrations: { status: pending.length ? "READY — PRODUCTION ACTION REQUIRED" : "SCHEMA INDICATORS PRESENT — APPLY HISTORY UNVERIFIED", pending, checks: migrations },
    trading,
    legacyOwnerRows: legacy,
  };
  if (process.argv.includes("--strict") && (pending.length > 0 || trading.verdict !== "TRADING AVAILABLE" || legacy.some(c => !c.ok))) process.exitCode = 2;
  if (process.argv.includes("--json")) { process.stdout.write(JSON.stringify(report, null, 2) + "\n"); return; }
  const line = (c: Check) => `  ${c.ok ? "ok  " : "TODO"} ${c.name}: ${c.detail}`;
  process.stdout.write([
    `Migrations: ${report.migrations.status}`, ...migrations.map(line), "",
    `Trading: ${trading.verdict}`, ...trading.checks.map(line), "",
    "Legacy ownerless rows (never auto-assigned):", ...legacy.map(line), "",
  ].join("\n"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => pool.end()).catch(async (e) => { process.stderr.write(`${(e as Error).message}\n`); await pool.end(); process.exit(1); });
}
