// Autonomous-cycle coordination across API processes, and bounded database
// waits, against a disposable PostgreSQL cluster. Every API process is a real
// OS process (cycleCoordination.child.ts, forked) serving the real route; this
// file only seeds rows, drives the children over HTTP/IPC, injects failures
// (SIGKILL, row locks held by another connection, a terminated lock session,
// an exhausted pool, a loopback TCP proxy that goes silent like a half-open
// connection) and reads the database afterwards. The pooler cases call the
// coordinator in this process with statements routed to chosen server
// sessions. No broker, terminal, bridge or network endpoint is contacted.
//
// Run only via: pnpm --filter @workspace/api-server run test:self-trade-cycle-coordination-postgres
import { after, before, beforeEach, it } from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns, getTableName, SQL } from "drizzle-orm";
import { PgDialect, type PgTable } from "drizzle-orm/pg-core";

const destination = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
assert.equal(process.env.ARX_CYCLE_COORDINATION_PG, "1", "Use the disposable PostgreSQL runner");
assert.equal(destination.pathname, "/arx_cycle_coordination_test");
assert.match(destination.searchParams.get("host") ?? "", /\/arx-cycle-coordination-[^/]+\/socket$/);
assert.equal(destination.username, "arx_qa");

const database = await import("@workspace/db");
const { db, pool } = database;
const tables: PgTable[] = [
  database.selfTradeAgentsTable,
  database.selfTradeAgentSettingsTable,
  database.selfTradeAgentLedgerTable,
  database.selfTradeLedgerEntriesTable,
  database.selfTradeDecisionsTable,
  database.selfTradeAgentExecutionsTable,
  database.selfTradeAuditLogTable,
  database.selfTradeAllocationsTable,
  database.selfTradeKillSwitchesTable,
  database.arxLiveCommandsTable,
  database.arxLivePositionsTable,
  database.liveTradingAuditTable,
  database.mt5CommandsTable,
  database.mt5ConnectionTable,
  database.executionEventsTable,
  database.securityEventsTable,
  database.userOneClickSettingsTable,
  database.oneClickAuditTable,
  database.arxSymbolSpecsTable,
  database.userSlotAllocationTable,
  database.arxDispatchExposureReservationsTable,
  database.sharedMasterAccountsTable,
  database.sharedTradeAttributionTable,
  database.symbolsTable,
];
const dialect = new PgDialect();
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
function defaultValue(value: unknown): string {
  if (value instanceof SQL) {
    const query = dialect.sqlToQuery(value);
    assert.equal(query.params.length, 0);
    return query.sql;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return `'${(typeof value === "string" ? value : JSON.stringify(value)).replaceAll("'", "''")}'`;
}
async function createTable(table: PgTable) {
  const definitions = Object.values(getTableColumns(table)).map(
    (c) =>
      `${quote(c.name)} ${c.getSQLType()}${c.notNull ? " NOT NULL" : ""}${c.default !== undefined ? ` DEFAULT ${defaultValue(c.default)}` : ""}${c.primary ? " PRIMARY KEY" : ""}`,
  );
  await pool.query(`CREATE TABLE ${quote(getTableName(table))} (${definitions.join(",")})`);
}

/** ARX_LOCK_NS.SELF_TRADE_CYCLE (0x4152_5805), keyB 1: the cross-process cycle lock. */
const CYCLE_LOCK = { classid: 0x4152_5805, objid: 1 };
const ENTRY_DECISION_CYCLE = "qa-cycle";

before(async () => {
  for (const table of tables) await createTable(table);
  await pool.query("CREATE UNIQUE INDEX qa_agent_key ON self_trade_agents(agent_key)");
  await pool.query("CREATE UNIQUE INDEX qa_agent_settings ON self_trade_agent_settings(agent_id)");
  await pool.query("CREATE UNIQUE INDEX qa_agent_ledger ON self_trade_agent_ledger(agent_id)");
  await pool.query("CREATE UNIQUE INDEX qa_kill_scope ON self_trade_kill_switches(scope,scope_ref)");
  await pool.query(
    "CREATE UNIQUE INDEX self_trade_agent_executions_idem_active_uq ON self_trade_agent_executions(agent_id,idempotency_key) WHERE status IN ('PENDING_TICKET','DISPATCHED','FILLED')",
  );
  await pool.query("CREATE UNIQUE INDEX qa_command_identity ON arx_live_commands(command_id)");
  await pool.query("CREATE UNIQUE INDEX execution_events_command_seq_uq ON execution_events(command_id,sequence_no)");
  await pool.query(
    "CREATE UNIQUE INDEX arx_disp_reserv_cmd_reserved_uq ON arx_dispatch_exposure_reservations(command_id) WHERE status = 'RESERVED'",
  );
});
after(async () => {
  for (const child of children) child.proc.kill("SIGKILL");
  await pool.end();
});

let entryDecisionId = 0;
beforeEach(async () => {
  for (const child of children.splice(0)) child.proc.kill("SIGKILL");
  await waitForLockFree();
  await pool.query(`TRUNCATE ${tables.map((t) => quote(getTableName(t))).join(",")} RESTART IDENTITY`);
  const now = new Date();
  await db.insert(database.mt5ConnectionTable).values({
    id: 1,
    userId: 9,
    accountNumber: "A",
    brokerName: "Venue Company",
    serverName: "Venue-Server-1",
    capabilities: { supportsManagementTargetV1: true },
    apiKeyHash: "fixture-a",
    status: "connected",
    accountType: "live",
    mode: "LIVE",
  });
  await db.insert(database.sharedMasterAccountsTable).values({
    id: 1,
    connectionId: 1,
    accountType: "live",
    status: "active",
    isActive: true,
  } as typeof database.sharedMasterAccountsTable.$inferInsert);
  await db.insert(database.userOneClickSettingsTable).values({ userId: 9, liveOneClickEnabled: true });

  // Entry agent (id 1) with one APPROVED decision in the seeded cycle.
  await db.insert(database.selfTradeAgentsTable).values({
    id: 1,
    agentKey: "alpha",
    name: "QA alpha",
    profileTemplate: "ALPHA",
    ownerType: "USER",
    ownerId: 9,
    createdByUserId: 10,
    status: "ACTIVE",
    mode: "LIVE",
    autonomyLevel: 3,
  });
  await db.insert(database.selfTradeAgentSettingsTable).values({
    agentId: 1,
    maxLotPerTrade: 1,
    maxConcurrentPositions: 1,
    baseMaxTrades: 5,
  });
  await db.insert(database.selfTradeAgentLedgerTable).values({ agentId: 1, allocatedFunds: 1000, availableFunds: 1000 });
  entryDecisionId = await insertEntryDecision();

  // Management agent (id 4): a FILLED entry with a live broker position far
  // enough in profit that the real manager moves the stop (management fixture).
  await db.insert(database.selfTradeAgentsTable).values({
    id: 4,
    agentKey: "agent",
    name: "Offline fixture",
    profileTemplate: "ALPHA",
    ownerType: "USER",
    ownerId: 9,
    status: "ACTIVE",
    mode: "LIVE",
    autonomyLevel: 3,
  } as typeof database.selfTradeAgentsTable.$inferInsert);
  await db.insert(database.selfTradeAgentSettingsTable).values({ agentId: 4, maxLotPerTrade: 1, dailyMinTrades: 0 });
  await db.insert(database.selfTradeAgentLedgerTable).values({ agentId: 4, allocatedFunds: 1000, availableFunds: 1000 });
  await db.insert(database.selfTradeDecisionsTable).values({
    id: 7,
    agentId: 4,
    agentKey: "agent",
    cycleId: "fixture",
    symbol: "EURUSD",
    side: "BUY",
    outcome: "APPROVED",
    plannedAction: "EXECUTE",
    reason: "Offline fixture",
    thesis: { stopLoss: 1.09, takeProfits: [], invalidation: null },
  });
  await pool.query("SELECT setval(pg_get_serial_sequence('self_trade_decisions','id'), 100, true)");
  await db.insert(database.arxLiveCommandsTable).values({
    commandId: "entry-1",
    userId: 9,
    bridgeConnectionId: 1,
    accountLogin: "A",
    brokerServer: "Venue Company",
    commandType: "PLACE_LIVE_MARKET_ORDER",
    status: "LIVE_FILLED",
    symbol: "EURUSD.a",
    side: "BUY",
    orderType: "MARKET_BUY",
    requestedVolume: 0.1,
    executedVolume: 0.1,
    fillPrice: 1.1,
    brokerTicket: "123",
    selfTradeAgentId: 4,
    selfTradeDecisionId: 7,
    filledAt: new Date(now.getTime() - 60_000),
    payload: {
      selfTradeSymbolBinding: { requestedSymbol: "EURUSD", brokerSymbol: "EURUSD.a" },
      agentOwnership: { selfTradeAgentId: 4, selfTradeDecisionId: 7, selfTradeAgentKey: "agent" },
    },
  });
  await db.insert(database.selfTradeAgentExecutionsTable).values({
    id: 1,
    agentId: 4,
    agentKey: "agent",
    decisionId: 7,
    executingUserId: 9,
    symbol: "EURUSD",
    side: "BUY",
    intendedVolume: 0.1,
    mode: "LIVE",
    fillPrice: 1.1,
    slPrice: 1.09,
    commandId: "entry-1",
    status: "FILLED",
    brokerTicket: "123",
    idempotencyKey: "entry",
    managementState: {},
    filledAt: new Date(now.getTime() - 60_000),
  });
  await pool.query("SELECT setval(pg_get_serial_sequence('self_trade_agent_executions','id'), 1, true)");
  await db.insert(database.arxLivePositionsTable).values({
    id: 1,
    userId: 9,
    bridgeConnectionId: 1,
    accountLogin: "A",
    brokerServer: "Venue Company",
    brokerTicket: "123",
    symbol: "EURUSD.a",
    side: "BUY",
    volume: 0.1,
    entryPrice: 1.1,
    currentPrice: 1.112,
    stopLoss: 1.09,
    takeProfit: 1.12,
    openedAt: new Date(now.getTime() - 60_000),
    lastSyncedAt: now,
    sourceCommandId: "entry-1",
  });
});

async function insertEntryDecision(): Promise<number> {
  const [row] = await db
    .insert(database.selfTradeDecisionsTable)
    .values({
      agentId: 1,
      agentKey: "alpha",
      cycleId: ENTRY_DECISION_CYCLE,
      symbol: "EURUSD",
      timeframe: "M5",
      side: "BUY",
      outcome: "APPROVED",
      setupType: "TEST",
      plannedAction: "EXECUTE",
      reason: "isolated cycle coordination test",
      thesis: { side: "BUY", entryZone: { from: 1.1, to: 1.1 }, stopLoss: 1.09, takeProfits: [{ from: 1.12 }] },
      setupExpiresAt: new Date(Date.now() + 7 * 86_400_000),
      evaluatedAt: new Date(),
    })
    .returning();
  return row!.id;
}

// ── Child processes ─────────────────────────────────────────────────────────
type Message = { type: string; name?: string; port?: number; level?: string; msg?: string; fields?: unknown };
interface ApiProcess {
  proc: ChildProcess;
  port: number;
  messages: Message[];
  stderr: string[];
  exited: Promise<number | string | null>;
}
const children: ApiProcess[] = [];
const childPath = join(dirname(fileURLToPath(import.meta.url)), "cycleCoordination.child.ts");

async function spawnApi(env: Record<string, string> = {}): Promise<ApiProcess> {
  const proc = fork(childPath, [], {
    execArgv: ["--import", "tsx", "--experimental-test-module-mocks", "--no-warnings"],
    env: { ...process.env, ARX_QA_CYCLE_ID: ENTRY_DECISION_CYCLE, ...env },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages: Message[] = [];
  const stderr: string[] = [];
  proc.stderr!.on("data", (d) => stderr.push(String(d)));
  proc.stdout!.on("data", () => undefined);
  proc.on("message", (m: Message) => messages.push(m));
  const exited = new Promise<number | string | null>((r) => proc.on("exit", (code, signal) => r(signal ?? code)));
  const api: ApiProcess = { proc, port: 0, messages, stderr, exited };
  children.push(api);
  await waitFor(() => messages.some((m) => m.type === "ready"), 90_000, () => `child did not start: ${stderr.join("")}`);
  api.port = messages.find((m) => m.type === "ready")!.port!;
  return api;
}
async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, why: () => string = () => "condition not reached") {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) assert.fail(why());
    await new Promise((r) => setTimeout(r, 20));
  }
}
const paused = (api: ApiProcess, name: string) => api.messages.some((m) => m.type === "paused" && m.name === name);
const resume = (api: ApiProcess, name: string) => api.proc.send({ type: "resume", name });
function deadline<T>(promise: Promise<T>, ms: number, why: () => string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(why())), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
async function post(api: ApiProcess): Promise<{ status: number; body: any; ms: number }> {
  const started = Date.now();
  const res = await fetch(`http://127.0.0.1:${api.port}/self-trade-ai/run-autonomous-cycle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "qa cycle coordination" }),
  });
  return { status: res.status, body: await res.json(), ms: Date.now() - started };
}
/** Child log lines, for assertion messages. */
const logsOf = (api: ApiProcess) =>
  JSON.stringify(api.messages.filter((m) => m.type === "log" || m.type === "point").slice(-40));
async function killHard(api: ApiProcess) {
  api.proc.kill("SIGKILL");
  assert.equal(await api.exited, "SIGKILL");
}

// ── Database reads ─────────────────────────────────────────────────────────
async function lockHolders(): Promise<number[]> {
  const r = await pool.query<{ pid: number }>(
    `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = ${CYCLE_LOCK.classid}::oid AND objid = ${CYCLE_LOCK.objid}::oid AND objsubid = 2 AND granted`,
  );
  return r.rows.map((x) => x.pid);
}
async function waitForLockFree() {
  await waitFor(async () => (await lockHolders()).length === 0, 10_000, () => "cycle lock still held");
}
async function rows<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(text, params)).rows as T[];
}
async function state() {
  const entryCommands = await rows(
    "SELECT command_id, status FROM arx_live_commands WHERE self_trade_decision_id = $1 AND command_type = 'PLACE_LIVE_MARKET_ORDER'",
    [entryDecisionId],
  );
  const managementCommands = await rows(
    "SELECT command_id, status, command_type FROM arx_live_commands WHERE command_type IN ('CLOSE_LIVE_POSITION','MODIFY_LIVE_SLTP')",
  );
  const mirrors = await rows("SELECT id, status, payload->>'liveCommandId' AS command_id FROM mt5_commands");
  const reservations = await rows("SELECT command_id, status FROM arx_dispatch_exposure_reservations");
  const entryExecutions = await rows("SELECT id, decision_id, status, command_id FROM self_trade_agent_executions WHERE agent_id = 1");
  const [managed] = await rows("SELECT status, management_state FROM self_trade_agent_executions WHERE id = 1");
  const claimAudits = await rows("SELECT * FROM live_trading_audit WHERE event_type = 'ENTRY_AUTHORITY_DISPATCH_CLAIMED'");
  return { entryCommands, managementCommands, mirrors, reservations, entryExecutions, managed, claimAudits };
}
const TERMINAL_COMMAND = ["LIVE_FILLED", "LIVE_EXPIRED", "LIVE_CANCELLED", "LIVE_FAILED", "LIVE_REJECTED", "LIVE_CLOSED"];
const RELEASED_EXECUTION = ["BLOCKED", "REJECTED", "CLOSED", "EXPIRED", "CANCELLED", "FILLED"];

// ── (a) two API processes ──────────────────────────────────────────────────
it("two API processes started together: exactly one runs, the other gets 409 CYCLE_ALREADY_RUNNING", { timeout: 240_000 }, async () => {
  const [a, b] = await Promise.all([
    spawnApi({ ARX_QA_PAUSE_AT: "cycle:decisions" }),
    spawnApi({ ARX_QA_PAUSE_AT: "cycle:decisions" }),
  ]);
  const ra = post(a);
  const rb = post(b);
  // One of them reaches the decision step and stops there; the other must be
  // refused without starting (it never reaches the step).
  await waitFor(() => paused(a, "cycle:decisions") || paused(b, "cycle:decisions"), 60_000);
  const [runner, refusedProc, refusedResponse, runnerResponse] = paused(a, "cycle:decisions")
    ? [a, b, rb, ra]
    : [b, a, ra, rb];
  const refused = await Promise.race([
    refusedResponse,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("second process was not refused")), 20_000)),
  ]);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "CYCLE_ALREADY_RUNNING");
  assert.match(refused.body.message, /is still running on the server, so this run was not started/);
  assert.equal(paused(refusedProc, "cycle:decisions"), false, "refused process never started a cycle");
  assert.deepEqual(await lockHolders().then((p) => p.length), 1);

  resume(runner, "cycle:decisions");
  const ran = await deadline(runnerResponse, 60_000, () => `runner did not answer: ${logsOf(runner)} ${runner.stderr.join("").slice(-2000)}`);
  assert.equal(ran.status, 200, JSON.stringify(ran.body));
  assert.equal(ran.body.completion.status, "COMPLETED", JSON.stringify(ran.body.completion));
  const s = await state();
  assert.equal(s.entryCommands.length, 1);
  assert.equal(s.managementCommands.length, 1);
  await waitForLockFree();

  // The refused process can run once the first has finished; nothing repeats.
  const pendingAgain = post(refusedProc);
  // Its own pause point is still armed (it never reached it before).
  await waitFor(() => paused(refusedProc, "cycle:decisions"), 60_000);
  resume(refusedProc, "cycle:decisions");
  const again = await deadline(pendingAgain, 60_000, () => `second run did not answer: ${logsOf(refusedProc)}`);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.executed.SKIPPED_DUPLICATE, 1);
  const s2 = await state();
  assert.equal(s2.entryCommands.length, 1);
  assert.equal(s2.managementCommands.length, 1);
  assert.equal(s2.mirrors.length, 2);
});

// ── (b) SIGKILL of the lock holder mid-dispatch ───────────────────────────
const killPoints = [
  "entry:before-claim",
  "entry:after-claim",
  "entry:after-mirror",
  "manage:before-claim",
  "manage:after-claim",
  "manage:after-mirror",
] as const;
for (const point of killPoints) {
  it(`SIGKILL at ${point}: the lock frees, the next cycle never re-dispatches and keeps uncertain exposure held`, { timeout: 240_000 }, async () => {
    const a = await spawnApi({ ARX_QA_PAUSE_AT: point });
    const pending = post(a).catch((e) => e);
    await waitFor(() => paused(a, point), 60_000, () => `did not reach ${point}: ${a.stderr.join("")}`);
    assert.equal((await lockHolders()).length, 1, "the running cycle holds the cross-process lock");
    await killHard(a);
    assert.ok((await pending) instanceof Error, "killed process never answered");
    await waitForLockFree();

    const before = await state();
    const b = await spawnApi();
    // A fresh decision for the same agent arrives with the next cycle: the
    // uncertain entry must still occupy the agent's only slot.
    await insertEntryDecision();
    const next = await post(b);
    assert.equal(next.status, 200, JSON.stringify(next.body));
    const after = await state();

    // Never a second command for the killed decision or management action.
    assert.equal(after.entryCommands.length, 1, "one entry command for the decision");
    assert.ok(after.managementCommands.length <= 1, "at most one management command");
    if (point.startsWith("manage:")) assert.equal(after.managementCommands.length, 1);
    const entryCommandIds = after.entryCommands.map((c) => c.command_id);
    assert.equal(
      after.mirrors.filter((m) => entryCommandIds.includes(m.command_id)).length,
      point === "entry:after-mirror" || point.startsWith("manage:") ? 1 : 0,
    );
    const mgmtIds = after.managementCommands.map((c) => c.command_id);
    assert.ok(after.mirrors.filter((m) => mgmtIds.includes(m.command_id)).length <= 1);
    // No entry command was created by the new cycle for the new decision either.
    assert.equal(
      (await rows("SELECT count(*)::int AS n FROM arx_live_commands WHERE command_type = 'PLACE_LIVE_MARKET_ORDER' AND command_id <> 'entry-1'"))[0].n,
      1,
    );

    if (point.startsWith("entry:")) {
      // The killed entry: reservation and agent slot still held, outcome open.
      const [cmd] = after.entryCommands;
      assert.ok(!TERMINAL_COMMAND.includes(cmd.status), `entry command ${cmd.status}`);
      assert.equal(cmd.status, point === "entry:before-claim" ? "LIVE_APPROVED" : "SENT_TO_MT5_LIVE");
      assert.deepEqual(after.reservations.map((r) => [r.command_id, r.status]), [[cmd.command_id, "RESERVED"]]);
      const killed = after.entryExecutions.find((e) => e.decision_id === entryDecisionId)!;
      // The final claim moves the reservation to DISPATCHED in its own
      // transaction; both statuses keep the agent's slot.
      assert.equal(killed.status, point === "entry:before-claim" ? "PENDING_TICKET" : "DISPATCHED");
      assert.equal(killed.command_id, cmd.command_id);
      assert.ok(!RELEASED_EXECUTION.includes(killed.status));
      assert.equal(next.body.executed.SKIPPED_DUPLICATE, 1, "the same decision is not replayed");
      assert.equal(next.body.executed.DISPATCHED, 0);
    } else {
      // The killed management action: its claim is retained and holds.
      const memory = after.managed.management_state;
      assert.ok(memory.pendingManagement, "claim retained");
      assert.equal(after.managed.status, "FILLED", "position not marked closed");
      const [cmd] = after.managementCommands;
      assert.ok(!TERMINAL_COMMAND.includes(cmd.status), `management command ${cmd.status}`);
      assert.deepEqual(before.managementCommands, after.managementCommands, "the new cycle did not touch it");
      assert.equal(next.body.positionsModified, 0);
    }
    assert.equal(next.body.completion.status, "COMPLETED", JSON.stringify(next.body.completion));
    await waitForLockFree();
  });
}

// ── (c) statement / lock timeout on a row another connection holds ─────────
for (const bound of [
  { name: "lock_timeout", env: { ARX_CYCLE_DB_LOCK_TIMEOUT_MS: "400", ARX_CYCLE_DB_STATEMENT_TIMEOUT_MS: "30000" }, code: "55P03" },
  { name: "statement_timeout", env: { ARX_CYCLE_DB_LOCK_TIMEOUT_MS: "30000", ARX_CYCLE_DB_STATEMENT_TIMEOUT_MS: "400" }, code: "57014" },
]) {
  it(`${bound.name}: a final claim blocked by another connection fails within the bound, rolls back and is reported`, { timeout: 240_000 }, async () => {
    const a = await spawnApi({ ...bound.env, ARX_QA_PAUSE_AT: "entry:before-claim" });
    const pending = post(a);
    await waitFor(() => paused(a, "entry:before-claim"), 60_000);
    const [cmd] = (await state()).entryCommands;
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM arx_live_commands WHERE command_id = $1 FOR UPDATE", [cmd.command_id]);
      resume(a, "entry:before-claim");
      // Answers while the blocker still holds the row.
      const res = await Promise.race([
        pending,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("cycle did not answer within the bound")), 20_000)),
      ]);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.ok(a.messages.some((m) => m.name === `entry:error:${bound.code}`), `claim failed with the bounded-wait error: ${logsOf(a)}`);
      assert.equal(res.body.completion.status, "INCOMPLETE");
      assert.ok(res.body.completion.dbWaitTimeouts >= 1);
      assert.equal(res.body.executed.DISPATCHED, 0);
      const s = await state();
      assert.equal(s.entryCommands[0].status, "LIVE_APPROVED", "claim rolled back: nothing sent");
      assert.equal(s.claimAudits.length, 0, "no claim audit committed");
      assert.equal(s.mirrors.filter((m) => m.command_id === cmd.command_id).length, 0);
      const exec = s.entryExecutions.find((e) => e.decision_id === entryDecisionId)!;
      assert.equal(exec.status, "PENDING_TICKET", "slot kept until non-execution is reconciled");
      // The single flight and the lock are free although the row is still locked.
      await waitForLockFree();
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    const later = await post(a);
    assert.equal(later.status, 200, JSON.stringify(later.body));
    assert.equal(later.body.completion.status, "COMPLETED", JSON.stringify(later.body.completion));
    const s = await state();
    assert.equal(s.entryCommands.length, 1, "no duplicate entry");
    assert.equal(s.mirrors.filter((m) => m.command_id === cmd.command_id).length, 0);
    assert.equal(s.managementCommands.length, 1, "management dispatched once across both cycles");
  });
}

// ── (d) connection acquisition timeout ────────────────────────────────────
it("an exhausted cycle pool times out the connection wait, reports it and frees the guard", { timeout: 240_000 }, async () => {
  // The seam takes both cycle connections at the first agent's AACI step and
  // returns them after ARX_QA_HOLD_MS; every later cycle query has to wait.
  const a = await spawnApi({
    ARX_CYCLE_DB_POOL_MAX: "2",
    ARX_CYCLE_DB_CONNECT_TIMEOUT_MS: "300",
    ARX_QA_HOLD_CONNECTIONS: "2",
    ARX_QA_HOLD_MS: "8000",
  });
  const res = await post(a);
  assert.equal(res.status, 200, `${JSON.stringify(res.body)} ${logsOf(a)}`);
  assert.ok(a.messages.some((m) => m.name === "aaci:connections-held"));
  assert.equal(
    a.messages.some((m) => m.name === "aaci:connections-released"),
    false,
    "answered while the pool was still exhausted",
  );
  assert.equal(res.body.completion.status, "INCOMPLETE", JSON.stringify(res.body.completion));
  assert.ok(res.body.completion.dbWaitTimeouts >= 1);
  assert.ok(res.body.completion.agentsFailed >= 1);
  assert.equal(res.body.executed.DISPATCHED, 1, "the entry before the stall is still reported");
  await waitForLockFree();

  // Still exhausted: the next run cannot even write its invocation audit. It
  // fails within the bound, says so, and dispatches nothing.
  const blocked = await post(a);
  assert.equal(blocked.status, 500, JSON.stringify(blocked.body));
  assert.equal(blocked.body.error, "CYCLE_FAILED");
  assert.match(blocked.body.message, /database wait exceeded its limit/);
  assert.ok(blocked.ms < 5_000, `answered in ${blocked.ms} ms`);
  await waitForLockFree();
  const s1 = await state();
  assert.equal(s1.managementCommands.length, 0, "no management command while connections were unavailable");

  await waitFor(() => a.messages.some((m) => m.name === "aaci:connections-released"), 30_000);
  const later = await post(a);
  assert.equal(later.status, 200, `${JSON.stringify(later.body)} ${logsOf(a)}`);
  assert.equal(later.body.completion.status, "COMPLETED", JSON.stringify(later.body.completion));
  assert.equal(later.body.executed.SKIPPED_DUPLICATE, 1);
  const s2 = await state();
  assert.equal(s2.entryCommands.length, 1);
  assert.equal(s2.managementCommands.length, 1);
});

// ── (e) the lock session is lost mid-cycle ────────────────────────────────
it("a lost lock session stops the cycle before its next dispatch while another process takes over", { timeout: 240_000 }, async () => {
  const a = await spawnApi({ ARX_QA_PAUSE_AT: "cycle:decisions" });
  const pendingA = post(a);
  await waitFor(() => paused(a, "cycle:decisions"), 60_000);
  const [holder] = await lockHolders();
  assert.ok(holder, "A holds the lock");
  await pool.query("SELECT pg_terminate_backend($1)", [holder]);
  await waitForLockFree();

  const b = await spawnApi();
  const ranB = await post(b);
  assert.equal(ranB.status, 200, JSON.stringify(ranB.body));
  assert.equal(ranB.body.executed.DISPATCHED, 1);

  resume(a, "cycle:decisions");
  const ranA = await pendingA;
  assert.equal(ranA.status, 200, JSON.stringify(ranA.body));
  assert.equal(ranA.body.completion.status, "STOPPED");
  assert.equal(ranA.body.completion.stopReason, "LEASE_LOST");
  assert.equal(ranA.body.completion.decisionsNotStarted, 1);
  assert.equal(ranA.body.agentsManaged, 0);
  const pointsA = a.messages.filter((m) => m.type === "point").map((m) => m.name);
  assert.ok(!pointsA.some((n) => n!.startsWith("entry:") || n!.startsWith("manage:")), `A dispatched after losing the lock: ${pointsA}`);
  const s = await state();
  assert.equal(s.entryCommands.length, 1);
  assert.equal(s.managementCommands.length, 1);
  await waitForLockFree();
  const again = await post(a);
  assert.equal(again.status, 200, "A recovers for the next run");
});

// Lost at the other two safe points: between agents, and before the drain.
it("a lock lost between agents stops before the next agent's management", { timeout: 240_000 }, async () => {
  const a = await spawnApi({ ARX_QA_PAUSE_AT: "aaci:agent-1" });
  const pendingA = post(a);
  await waitFor(() => paused(a, "aaci:agent-1"), 60_000, () => `did not reach agent 1: ${logsOf(a)}`);
  const [holder] = await lockHolders();
  assert.ok(holder, "A holds the lock");
  await pool.query("SELECT pg_terminate_backend($1)", [holder]);
  await waitForLockFree();
  const lostAt = a.messages.length;
  resume(a, "aaci:agent-1");
  const ranA = await deadline(pendingA, 60_000, () => `A did not answer: ${logsOf(a)}`);
  assert.equal(ranA.status, 200, JSON.stringify(ranA.body));
  assert.equal(ranA.body.completion.status, "STOPPED", JSON.stringify(ranA.body.completion));
  assert.equal(ranA.body.completion.stopReason, "LEASE_LOST");
  assert.equal(ranA.body.completion.decisionsNotStarted, 0);
  assert.equal(ranA.body.completion.agentsNotStarted, 1, "agent 4 not started");
  assert.equal(ranA.body.executed.DISPATCHED, 1, "the entry before the loss is still reported");
  const after = a.messages.slice(lostAt).filter((m) => m.type === "point").map((m) => m.name!);
  assert.ok(!after.some((n) => n.startsWith("manage:") || n === "aaci:agent-4"), `A went on after losing the lock: ${after}`);
  const s = await state();
  assert.equal(s.managementCommands.length, 0, "no management command after the loss");
  assert.equal(s.entryCommands.length, 1);

  // The next run manages agent 4 once and does not repeat the entry.
  const again = await deadline(post(a), 60_000, () => `second run did not answer: ${logsOf(a)}`);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.completion.status, "COMPLETED", JSON.stringify(again.body.completion));
  assert.equal(again.body.executed.SKIPPED_DUPLICATE, 1);
  const s2 = await state();
  assert.equal(s2.entryCommands.length, 1);
  assert.equal(s2.managementCommands.length, 1);
});

it("a lock lost after the last agent leaves the protective drain unrun (nothing claimed)", { timeout: 240_000 }, async () => {
  const a = await spawnApi({ ARX_QA_PAUSE_AT: "quota:agent-4", ARX_QA_PROTECTIVE_STUB: "1" });
  const pendingA = post(a);
  await waitFor(() => paused(a, "quota:agent-4"), 60_000, () => `did not reach the end of agent 4: ${logsOf(a)}`);
  const [holder] = await lockHolders();
  await pool.query("SELECT pg_terminate_backend($1)", [holder]);
  await waitForLockFree();
  const lostAt = a.messages.length;
  resume(a, "quota:agent-4");
  const ranA = await deadline(pendingA, 60_000, () => `A did not answer: ${logsOf(a)}`);
  assert.equal(ranA.status, 200, JSON.stringify(ranA.body));
  assert.equal(ranA.body.completion.status, "STOPPED", JSON.stringify(ranA.body.completion));
  assert.equal(ranA.body.completion.agentsNotStarted, 0);
  assert.equal(ranA.body.completion.protectiveNotRun, 1);
  assert.equal(ranA.body.protective.considered, 0);
  const after = a.messages.slice(lostAt).filter((m) => m.type === "point").map((m) => m.name!);
  assert.ok(!after.includes("protective:drain"), `drain ran after losing the lock: ${after}`);
  assert.ok(!after.some((n) => n.startsWith("manage:") || n.startsWith("entry:")), `dispatch after the loss: ${after}`);
  const s = await state();
  assert.equal(s.managementCommands.length, 1, "agent 4 was managed before the loss, once");

  const again = await deadline(post(a), 60_000, () => `second run did not answer: ${logsOf(a)}`);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.completion.status, "COMPLETED", JSON.stringify(again.body.completion));
  assert.ok(a.messages.slice(lostAt).some((m) => m.name === "protective:drain"), "the next run drains");
  assert.equal((await state()).managementCommands.length, 1);
});

// ── (f) half-open connections: the server's cancel never arrives ─────────────
/**
 * Loopback TCP proxy to the cluster's socket. A connection whose startup
 * packet names `app` goes silent in both directions (nothing forwarded,
 * nothing closed) from the first chunk matching `match`, like a flow a NAT or
 * load balancer dropped without a reset.
 */
async function silentProxy() {
  const socketPath = join(destination.searchParams.get("host")!, `.s.PGSQL.${destination.searchParams.get("port")}`);
  let rule: { app: string; match: RegExp } | null = null;
  let silenced = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((down) => {
    const up = net.connect({ path: socketPath });
    sockets.add(down).add(up);
    let app: string | null = null;
    let silent = false;
    down.on("data", (chunk) => {
      const text = chunk.toString("latin1");
      app ??= /application_name\0([^\0]*)\0/.exec(text)?.[1] ?? "";
      if (!silent && rule && app === rule.app && rule.match.test(text)) {
        silent = true;
        silenced++;
      }
      if (!silent) up.write(chunk);
    });
    up.on("data", (chunk) => {
      if (!silent) down.write(chunk);
    });
    const close = () => {
      down.destroy();
      up.destroy();
    };
    for (const sock of [down, up]) {
      sock.on("close", close);
      sock.on("error", close);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `postgresql://arx_qa@127.0.0.1:${port}/arx_cycle_coordination_test`,
    stall: (app: string, match: RegExp) => {
      rule = { app, match };
    },
    clear: () => {
      rule = null;
    },
    silenced: () => silenced,
    close: () => {
      for (const sock of sockets) sock.destroy();
      server.close();
    },
  };
}

it("a cycle connection that goes silent mid-query ends the cycle within the client bound and frees both locks", { timeout: 240_000 }, async () => {
  const proxy = await silentProxy();
  try {
    const a = await spawnApi({
      DATABASE_URL: proxy.url,
      ARX_CYCLE_DB_STATEMENT_TIMEOUT_MS: "1500",
      ARX_CYCLE_DB_CLIENT_READ_GRACE_MS: "500",
    });
    // The cycle's first read of the decisions table never gets an answer.
    proxy.stall("arx-autonomous-cycle-work", /"self_trade_decisions"/);
    const res = await deadline(post(a), 20_000, () => `cycle did not answer within the bound: ${logsOf(a)}`);
    assert.equal(proxy.silenced(), 1, "the work connection went silent");
    assert.equal(res.status, 500, JSON.stringify(res.body));
    assert.equal(res.body.error, "CYCLE_FAILED");
    assert.match(res.body.message, /database wait exceeded its limit/);
    assert.ok(res.ms < 10_000, `answered in ${res.ms} ms`);
    assert.ok(a.messages.some((m) => m.level === "error" && (m.fields as any)?.dbWaitTimeout === true), logsOf(a));
    await waitForLockFree();
    const s = await state();
    assert.equal(s.entryCommands.length, 0, "nothing dispatched");
    assert.equal(s.managementCommands.length, 0);

    // The silent connection was discarded, not handed to the next cycle.
    proxy.clear();
    const later = await deadline(post(a), 60_000, () => `later run did not answer: ${logsOf(a)}`);
    assert.equal(later.status, 200, JSON.stringify(later.body));
    assert.equal(later.body.completion.status, "COMPLETED", JSON.stringify(later.body.completion));
    assert.equal(later.body.executed.DISPATCHED, 1);
    const s2 = await state();
    assert.equal(s2.entryCommands.length, 1);
    assert.equal(s2.managementCommands.length, 1);
  } finally {
    proxy.close();
  }
});

it("a lock connection that goes silent during acquisition refuses within the bound and starts nothing", { timeout: 240_000 }, async () => {
  const proxy = await silentProxy();
  try {
    const a = await spawnApi({ DATABASE_URL: proxy.url, ARX_CYCLE_LEASE_CHECK_TIMEOUT_MS: "800" });
    proxy.stall("arx-autonomous-cycle", /pg_try_advisory_lock/);
    const res = await deadline(post(a), 20_000, () => `acquisition did not answer within the bound: ${logsOf(a)}`);
    assert.equal(proxy.silenced(), 1);
    assert.equal(res.status, 500, JSON.stringify(res.body));
    assert.match(res.body.message, /No cycle was started/);
    assert.ok(res.ms < 8_000, `answered in ${res.ms} ms`);
    assert.deepEqual(await lockHolders(), []);
    assert.equal((await rows("SELECT count(*)::int AS n FROM self_trade_audit_log WHERE event_type = 'AUTONOMOUS_CYCLE_RUN'"))[0].n, 0);

    proxy.clear();
    const later = await deadline(post(a), 60_000, () => `later run did not answer: ${logsOf(a)}`);
    assert.equal(later.status, 200, "the single flight was freed");
  } finally {
    proxy.close();
  }
});

// ── (g) transaction-mode pooler: statements land on other server sessions ────
const coordinator = await import("../cycleCoordinator.js");
type LockClient = InstanceType<typeof database.PgClient>;
async function serverSessions(n: number): Promise<LockClient[]> {
  return Promise.all(
    Array.from({ length: n }, async () => {
      const c = new database.PgClient({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      return c;
    }),
  );
}
/** One "pooled" client whose i-th statement runs on sessions[route[i]] (the last entry repeats). */
function routed(sessions: LockClient[], route: number[]): LockClient {
  let i = 0;
  const pick = () => sessions[route[Math.min(i++, route.length - 1)]!]!;
  const fake = {
    connect: async () => undefined,
    query: (...args: unknown[]) => (pick().query as (...a: unknown[]) => unknown)(...args),
    on: () => fake,
    off: () => fake,
    end: async () => undefined,
  };
  return fake as unknown as LockClient;
}
const unlockOn = async (c: LockClient) =>
  (await c.query("SELECT pg_advisory_unlock($1::int4, $2::int4) AS ok", [CYCLE_LOCK.classid, CYCLE_LOCK.objid])).rows[0].ok;
const pidOf = async (c: LockClient) => (await c.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;

it("pooler: a server session that already holds the lock (re-entrant) is refused without bumping its count", { timeout: 60_000 }, async () => {
  const [x] = await serverSessions(1);
  try {
    await x!.query("SELECT pg_advisory_lock($1::int4, $2::int4)", [CYCLE_LOCK.classid, CYCLE_LOCK.objid]);
    await assert.rejects(
      coordinator.acquireCycleLease(coordinator.readCycleDbBounds(), () => routed([x!], [0])),
      (e: Error) => e instanceof coordinator.CycleCoordinationError && /already held by this database session/.test(e.message),
    );
    assert.equal(await unlockOn(x!), true);
    assert.equal(await unlockOn(x!), false, "held once: the refused attempt did not take it again");
    assert.deepEqual(await lockHolders(), []);
  } finally {
    await x!.end();
  }
});

it("pooler: verification on another session refuses, and unlocks only on the session that took the lock", { timeout: 60_000 }, async () => {
  const [x, y] = await serverSessions(2);
  try {
    // try on X, verify on Y (refused), unlock lands on X: freed.
    await assert.rejects(
      coordinator.acquireCycleLease(coordinator.readCycleDbBounds(), () => routed([x!, y!], [0, 1, 0])),
      /could not be verified on the session that took it/,
    );
    assert.deepEqual(await lockHolders(), []);

    // try on X, verify and unlock on Y: Y never unlocks X's lock; X keeps it
    // until the pooler recycles that session (later runs see 409).
    await assert.rejects(
      coordinator.acquireCycleLease(coordinator.readCycleDbBounds(), () => routed([x!, y!], [0, 1, 1])),
      /could not be verified/,
    );
    assert.deepEqual(await lockHolders(), [await pidOf(x!)]);
    const refused = await coordinator.acquireCycleLease();
    assert.equal(refused.acquired, false);
  } finally {
    await x!.end();
    await y!.end();
  }
  await waitForLockFree();
});

it("pooler: a lease whose check lands on another session is lost, so the cycle stops", { timeout: 60_000 }, async () => {
  const [x, y] = await serverSessions(2);
  try {
    const attempt = await coordinator.acquireCycleLease(coordinator.readCycleDbBounds(), () => routed([x!, y!], [0, 0, 1]));
    assert.ok(attempt.acquired);
    assert.equal(attempt.lease.backendPid, await pidOf(x!));
    assert.equal(await attempt.lease.stillHeld(), false);
    assert.match(attempt.lease.lostReason ?? "", /^LOCK_SESSION_MOVED/);
    await attempt.lease.release();
  } finally {
    await x!.end();
    await y!.end();
  }
  await waitForLockFree();
});
