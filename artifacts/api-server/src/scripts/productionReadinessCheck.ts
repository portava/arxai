// Production readiness check — READ ONLY (Tier 1 finalization, items 9 and 10).
//
// Answers, against whatever DATABASE_URL points at:
//   1. Which of the Tier 1 migrations are applied (by the columns,
//      defaults, tables and indexes each one creates).
//   2. Whether trading is available: the install-wide stop switches the
//      pre-trade Risk Governor reads (lib/safety/tradingHalt.ts), the platform
//      mode and the venue switches. Desired state: TRADING AVAILABLE.
//   3. How many legacy ownerless rows wait for the explicit owner claim. It
//      counts them; it never assigns an owner.
//
// It writes nothing, engages or releases nothing, and claims nothing.
//
// Run: pnpm --filter @workspace/api-server run check:production-readiness [-- --json]

import { pool } from "@workspace/db";
import { KEYED_TABLES, TABLES } from "./claimLegacyBehaviorRows.js";

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
    && /true/.test(String(await columnDefault("global_trading_settings", "live_enabled"))))(),
    "global_trading_settings defaults: platform_mode LIVE, live_enabled true, emergency_kill_switch false");
  await add("2026-10-24_owner_columns", all([
    hasColumn("weekly_improvement_plans", "user_id"), hasColumn("performance_symbol_snapshots", "user_id"),
    hasColumn("ai_performance_snapshots", "user_id"), hasIndex("weekly_improvement_plans_user_week_uq"),
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
    "risk_settings limits folded into user_risk_settings (legacy_merged_at)");
  await add("2026-10-25_paper_order_request_key", all([
    hasColumn("paper_orders", "client_request_key"), hasIndex("paper_orders_user_request_key_uq"),
  ]), "client_request_key + per-user unique index on paper_orders (owner decision 13)");
  return out;
}

export interface TradingStatus { verdict: "TRADING AVAILABLE" | "TRADING HALTED" | "UNKNOWN"; checks: Check[] }

export async function tradingStatus(): Promise<TradingStatus> {
  const checks: Check[] = [];
  let unknown = false;
  try {
    const [g] = await q<{ platform_mode: string; demo_enabled: boolean; live_enabled: boolean; emergency_kill_switch: boolean; kill_switch_reason: string | null }>(
      `SELECT platform_mode, demo_enabled, live_enabled, emergency_kill_switch, kill_switch_reason FROM global_trading_settings ORDER BY id ASC LIMIT 1`);
    if (!g) {
      checks.push({ name: "global_trading_settings row", ok: true, detail: "absent — created on first read with the column defaults" });
    } else {
      checks.push({ name: "platform emergency stop", ok: !g.emergency_kill_switch, detail: g.emergency_kill_switch ? `ENGAGED${g.kill_switch_reason ? ` (${g.kill_switch_reason})` : ""} — only an owner/operator may release it` : "released" });
      checks.push({ name: "platform mode", ok: g.platform_mode !== "OFF", detail: g.platform_mode });
      checks.push({ name: "demo venue", ok: g.demo_enabled, detail: g.demo_enabled ? "enabled" : "disabled" });
      checks.push({ name: "live venue", ok: g.live_enabled, detail: g.live_enabled ? "enabled" : "disabled" });
    }
  } catch (e) { unknown = true; checks.push({ name: "global_trading_settings", ok: false, detail: `unreadable: ${(e as Error).message}` }); }
  try {
    const [s] = await q<{ on: boolean }>(`SELECT kill_switch_engaged AS on FROM safety_core ORDER BY id ASC LIMIT 1`);
    checks.push({ name: "safety-core kill switch", ok: !s?.on, detail: s?.on ? "ENGAGED" : "released" });
  } catch (e) { unknown = true; checks.push({ name: "safety-core kill switch", ok: false, detail: `unreadable: ${(e as Error).message}` }); }
  try {
    const [t] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM arx_live_arming WHERE kill_switch_engaged`);
    checks.push({ name: "trader kill switches (per user, informational)", ok: true, detail: `${t?.n ?? 0} trader(s) halted themselves` });
  } catch { /* table absent on older installs: informational only */ }
  const halted = checks.some((c) => !c.ok);
  return { verdict: unknown ? "UNKNOWN" : halted ? "TRADING HALTED" : "TRADING AVAILABLE", checks };
}

export async function ownerlessRows(): Promise<Check[]> {
  const out: Check[] = [];
  for (const t of [...TABLES, ...KEYED_TABLES.map((k) => k.table)]) {
    if (!(await hasColumn(t, "user_id"))) { out.push({ name: t, ok: false, detail: "owner column missing (migration not applied)" }); continue; }
    const [r] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE user_id IS NULL`);
    if ((r?.n ?? 0) > 0) out.push({ name: t, ok: true, detail: `${r!.n} ownerless row(s) — hidden from every reader until claimed for an explicitly named owner` });
  }
  if (!out.length) out.push({ name: "all claimable tables", ok: true, detail: "no ownerless rows" });
  return out;
}

async function main(): Promise<void> {
  const [migrations, trading, legacy] = [await migrationChecks(), await tradingStatus(), await ownerlessRows()];
  const pending = migrations.filter((m) => !m.ok).map((m) => m.name);
  const report = {
    migrations: { status: pending.length ? "READY — PRODUCTION ACTION REQUIRED" : "APPLIED", pending, checks: migrations },
    trading,
    legacyOwnerRows: legacy,
  };
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
