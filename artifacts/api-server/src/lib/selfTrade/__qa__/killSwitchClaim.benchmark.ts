// Latency of the final agent-entry authority transaction with and without the
// kill-switch check (shared advisory lock + engaged-row read), on a disposable
// local PostgreSQL. No broker, network or shared database is touched.
//
// Run: node src/lib/selfTrade/__qa__/runKillSwitchBenchmarkPostgres.mjs
//   ARX_BENCH_PREVIOUS_AUTHORITY=<abs path to a copy of the pre-change
//   entryAuthority.ts placed next to the current one> enables the A/B
//   comparison; iterations default to 2000 (ARX_BENCH_ITERATIONS).
//
// Interleaved per iteration (prev, current, prev, ...) on one pool so drift
// and cache effects hit both sides equally. Reported: median / p95 / p99 / max
// in milliseconds. Local single-host numbers only; not a production claim.
import assert from "node:assert/strict";
import { getTableColumns, getTableName, SQL } from "drizzle-orm";
import { PgDialect, type PgTable } from "drizzle-orm/pg-core";

const destination = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
assert.equal(process.env.ARX_KILL_SWITCH_BENCH_PG, "1", "Use the disposable PostgreSQL runner");
assert.equal(destination.pathname, "/arx_kill_switch_bench");
assert.match(destination.searchParams.get("host") ?? "", /\/arx-kill-switch-bench-[^/]+\/socket$/);
assert.equal(destination.username, "arx_qa");

const database = await import("@workspace/db");
const {
  db, pool,
  selfTradeAgentsTable: agents, selfTradeAgentSettingsTable: settings, selfTradeAgentLedgerTable: ledger,
  selfTradeDecisionsTable: decisions, selfTradeAgentExecutionsTable: executions, selfTradeAuditLogTable: audit,
  selfTradeLedgerEntriesTable: entries, selfTradeAllocationsTable: allocations, selfTradeKillSwitchesTable: killSwitches,
} = database;
const { reserveAgentEntry } = await import("../entryReservation.js");
const current = await import("../entryAuthority.js");
const previousPath = process.env.ARX_BENCH_PREVIOUS_AUTHORITY;
const previous = previousPath ? await import(previousPath) : null;
const N = Number(process.env.ARX_BENCH_ITERATIONS ?? 2000);

const dialect = new PgDialect();
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
function defaultValue(value: unknown): string {
  if (value instanceof SQL) return dialect.sqlToQuery(value).sql;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return `'${(typeof value === "string" ? value : JSON.stringify(value)).replaceAll("'", "''")}'`;
}
async function createTable(table: PgTable) {
  const defs = Object.values(getTableColumns(table)).map((c) =>
    `${quote(c.name)} ${c.getSQLType()}${c.notNull ? " NOT NULL" : ""}${c.default !== undefined ? ` DEFAULT ${defaultValue(c.default)}` : ""}${c.primary ? " PRIMARY KEY" : ""}`);
  await pool.query(`CREATE TABLE ${quote(getTableName(table))} (${defs.join(",")})`);
}
for (const t of [agents, settings, ledger, decisions, executions, audit, entries, allocations, killSwitches]) await createTable(t);
await pool.query("CREATE UNIQUE INDEX ON self_trade_agents(agent_key)");
await pool.query("CREATE UNIQUE INDEX ON self_trade_agent_settings(agent_id)");
await pool.query("CREATE UNIQUE INDEX ON self_trade_agent_ledger(agent_id)");
await pool.query("CREATE UNIQUE INDEX ON self_trade_kill_switches(scope,scope_ref)");
await pool.query("CREATE INDEX ON self_trade_kill_switches(engaged)");

const now = new Date();
const [agent] = await db.insert(agents).values({
  agentKey: "bench", name: "bench", profileTemplate: "ALPHA", ownerType: "USER", ownerId: 9,
  createdByUserId: 10, status: "ACTIVE", mode: "LIVE", autonomyLevel: 3,
}).returning();
const [config] = await db.insert(settings).values({ agentId: agent!.id, maxLotPerTrade: 1, maxConcurrentPositions: 1, baseMaxTrades: 5 }).returning();
const [balance] = await db.insert(ledger).values({ agentId: agent!.id, allocatedFunds: 1000, availableFunds: 1000 }).returning();
const [decision] = await db.insert(decisions).values({
  agentId: agent!.id, agentKey: "bench", cycleId: "bench", symbol: "EURUSD", timeframe: "M5", side: "BUY",
  outcome: "APPROVED", setupType: "TEST", plannedAction: "EXECUTE", reason: "bench",
  thesis: { side: "BUY", entryZone: { from: 1.1, to: 1.1 }, stopLoss: 1.09, takeProfits: [{ from: 1.12 }] },
  setupExpiresAt: new Date(now.getTime() + 86_400_000), evaluatedAt: now,
}).returning();
const reserved = await reserveAgentEntry({
  agent: agent!, settings: config!, ledger: balance!, decision: decision!, executingUserId: 9,
  side: "BUY", volume: 0.1, stopLoss: 1.09, takeProfit: 1.12, now,
});
assert.ok(reserved.ok, "reservation");
const request = {
  userId: 9, agentId: agent!.id, decisionId: decision!.id, executionId: reserved.ok ? reserved.execution.id : 0,
  symbol: "EURUSD", side: "BUY", volume: 0.1, stopLoss: 1.09, takeProfit: 1.12, symbolBinding: null,
};
const noop = async () => null;

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!;
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return { n: s.length, median: r(q(0.5)), p95: r(q(0.95)), p99: r(q(0.99)), max: r(s[s.length - 1]!) };
}
async function time(fn: () => Promise<unknown>): Promise<number> {
  const t = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - t) / 1e6;
}
async function scenario(label: string) {
  const cur: number[] = [];
  const prev: number[] = [];
  for (let i = 0; i < 200; i++) {
    await current.withEntryAuthority(request, noop);
    if (previous) await previous.withEntryAuthority(request, noop);
  }
  for (let i = 0; i < N; i++) {
    if (previous) prev.push(await time(() => previous.withEntryAuthority(request, noop)));
    cur.push(await time(() => current.withEntryAuthority(request, noop)));
  }
  return { label, current: stats(cur), ...(previous ? { previous: stats(prev) } : {}) };
}

const results = [];
results.push(await scenario("no engaged switches"));
// 50 engaged switches that do NOT cover this entry (other agents/symbols/strategies).
await db.insert(killSwitches).values(Array.from({ length: 50 }, (_, i) => ({
  scope: ["AGENT", "SYMBOL", "STRATEGY"][i % 3]!, scopeRef: `OTHER_${i}`, engaged: true, reason: "bench",
})));
results.push(await scenario("50 engaged non-covering switches"));

// Sanity: the current build refuses once a covering switch is engaged.
await db.insert(killSwitches).values({ scope: "AGENT", scopeRef: "bench", engaged: true, reason: "bench" });
await assert.rejects(current.withEntryAuthority(request, noop), /ENTRY_KILL_SWITCH_ENGAGED/);
if (previous) assert.equal(await previous.withEntryAuthority(request, noop), null);

console.log(JSON.stringify({ iterations: N, abComparison: !!previous, results }, null, 2));
await pool.end();
