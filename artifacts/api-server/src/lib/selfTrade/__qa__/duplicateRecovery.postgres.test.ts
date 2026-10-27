// Duplicate-prevention and crash-recovery races against a disposable
// PostgreSQL cluster. Interleavings are forced with real row locks held by a
// second connection; no broker, terminal or network endpoint is contacted.
import { before, beforeEach, after, it, mock } from "node:test";
import assert from "node:assert/strict";
import { eq, getTableColumns, getTableName, SQL } from "drizzle-orm";
import { PgDialect, type PgTable } from "drizzle-orm/pg-core";
const destination = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
assert.equal(process.env.ARX_DUPLICATE_RECOVERY_PG, "1", "Use the disposable PostgreSQL runner");
assert.equal(destination.pathname, "/arx_duplicate_recovery_test");
assert.match(destination.searchParams.get("host") ?? "", /\/arx-duplicate-recovery-[^/]+\/socket$/);
assert.equal(destination.username, "arx_qa");
const database = await import("@workspace/db");
const {
  db,
  pool,
  arxLiveCommandsTable: commands,
  mt5CommandsTable: mailbox,
  liveTradingAuditTable: liveAudit,
  executionEventsTable: executionEvents,
  selfTradeAgentExecutionsTable: executions,
  selfTradeAuditLogTable: selfAudit,
} = database;
process.env.SESSION_SECRET = "synthetic-offline-duplicate-recovery-material";
mock.method(globalThis, "fetch", async () => {
  throw new Error("Unexpected external request");
});
const realSecurityEvents = await import("../../security/events.js");
mock.module("../../security/events.js", {
  namedExports: {
    ...realSecurityEvents,
    mirrorCriticalEvent: async () => undefined,
    recordSecurityEvent: async () => undefined,
  },
});
mock.module("../../security/handshake.js", {
  namedExports: { enforceSensitiveAction: async () => ({ ok: true }) },
});
mock.module("../../joinRequests/notifyAdmins.js", {
  namedExports: { listAdminUserIds: async () => [] },
});
mock.module("../../notificationService.js", {
  namedExports: { createNotification: async () => undefined },
});
const pipeline = await import("../../live/liveCommandPipeline.js");
const { cancelLiveCommand, sweepExpiredLiveCommands } = pipeline;
const { reconcileAgentExecutions } = await import("../agentReconciliation.js");
const { default: mt5Router } = await import("../../../routes/mt5.js");

const tables = [commands, mailbox, liveAudit, executionEvents, executions, selfAudit];
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

before(async () => {
  for (const table of tables) await createTable(table);
  await pool.query("CREATE UNIQUE INDEX arx_live_commands_command_id_uq ON arx_live_commands(command_id)");
  await pool.query("CREATE UNIQUE INDEX execution_events_command_seq_uq ON execution_events(command_id, sequence_no)");
});
beforeEach(async () => {
  await pool.query(`TRUNCATE ${tables.map((t) => quote(getTableName(t))).join(",")} RESTART IDENTITY`);
});
after(async () => {
  await pool.end();
});

const USER = 9;
const BRIDGE = 1;
let sequence = 0;
async function command(patch: Partial<typeof commands.$inferInsert>) {
  sequence++;
  return (
    await db
      .insert(commands)
      .values({
        commandId: `qa-cmd-${sequence}`,
        userId: USER,
        commandType: "PLACE_LIVE_MARKET_ORDER",
        status: "LIVE_APPROVED",
        symbol: "EURUSD",
        side: "BUY",
        orderType: "MARKET_BUY",
        requestedVolume: 0.1,
        selfTradeAgentId: 1,
        selfTradeDecisionId: 100 + sequence,
        ...patch,
      })
      .returning()
  )[0]!;
}
/** A reserved self-trade entry linked to the command, as createAgentEntryDraft leaves it. */
async function linkedExecution(row: typeof commands.$inferSelect) {
  return (
    await db
      .insert(executions)
      .values({
        agentId: row.selfTradeAgentId!,
        agentKey: "alpha",
        decisionId: row.selfTradeDecisionId!,
        symbol: row.symbol,
        side: row.side,
        autonomyLevel: 3,
        mode: "LIVE",
        executingUserId: row.userId,
        intendedVolume: row.requestedVolume,
        idempotencyKey: `decision:${row.selfTradeDecisionId}`,
        status: "PENDING_TICKET",
        commandId: row.commandId,
      })
      .returning()
  )[0]!;
}
async function mirror(row: typeof commands.$inferSelect, status = "PENDING") {
  return (
    await db
      .insert(mailbox)
      .values({
        userId: USER,
        mt5ConnectionId: BRIDGE,
        requestedByUserId: row.userId,
        action: "OPEN_MARKET",
        symbol: row.symbol,
        side: row.side,
        lot: row.requestedVolume,
        status,
        payload: {
          bridged: "LIVE_PHASE_B",
          liveCommandId: row.commandId,
          liveCommandOwnerUserId: row.userId,
          liveCommandType: row.commandType,
          confirmedByUser: true,
        },
      })
      .returning()
  )[0]!;
}
async function current(commandId: string) {
  return (await db.select().from(commands).where(eq(commands.commandId, commandId)))[0]!;
}
async function mailboxRow(id: number) {
  return (await db.select().from(mailbox).where(eq(mailbox.id, id)))[0]!;
}
/** The real legacy mailbox handler the v1.50/v1.54 EA polls (GET /api/mt5/commands). */
async function eaPoll() {
  const route = mt5Router.stack.find((layer: any) => layer.route?.path === "/mt5/commands" && layer.route?.methods?.get)!.route!;
  let body: any;
  let status = 200;
  const response: any = {
    json: (value: unknown) => ((body = value), response),
    status: (value: number) => ((status = value), response),
    type: () => response,
    send: (value: string) => ((body = JSON.parse(value)), response),
  };
  await route.stack.at(-1)!.handle(
    {
      mt5Connection: { id: BRIDGE, userId: USER, capabilities: null },
      get: () => undefined,
      log: { info() {}, warn() {}, error() {} },
      body: {},
      headers: {},
    } as any,
    response,
    () => {},
  );
  assert.equal(status, 200, JSON.stringify(body));
  return body.commands as Array<{ id: number; payload: Record<string, unknown> }>;
}
/** Wait until another backend is blocked on a row lock, or `settled` resolves first. */
async function lockWaitOr(settled: Promise<unknown>): Promise<"waiting" | "settled"> {
  let done = false;
  void settled.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 400; i++) {
    if (done) return "settled";
    const { rows } = await pool.query(
      "select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()",
    );
    if (rows[0].n > 0) return "waiting";
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Neither a lock wait nor completion was observed");
}

// ── 1. Cancellation must be a compare-and-set ───────────────────────────────

for (const [label, from, concurrent] of [
  ["a concurrent dispatch that already sent the order", "LIVE_APPROVED", "SENT_TO_MT5_LIVE"],
  ["a fill that lands on a partially filled order", "LIVE_PARTIALLY_FILLED", "LIVE_FILLED"],
] as const) {
  it(`cancel cannot overwrite ${label}`, async () => {
    const row = await command({ status: from, bridgeConnectionId: BRIDGE, accountLogin: "A", brokerServer: "S" });
    const execution = await linkedExecution(row);
    const writer = await pool.connect();
    try {
      await writer.query("begin");
      // The competing writer has transitioned the row but not yet committed;
      // cancellation reads the committed (old) status and then must not win.
      await writer.query("update arx_live_commands set status = $1, sent_to_mt5_at = now() where command_id = $2", [concurrent, row.commandId]);
      const cancelling = cancelLiveCommand({ userId: USER, commandId: row.commandId, reason: "USER_CANCELLED" });
      assert.equal(await lockWaitOr(cancelling), "waiting", "cancel must reach its write while the competitor holds the row");
      await writer.query("commit");
      const result = await cancelling;
      assert.equal(result.ok, false, "a lost race is a refusal, not a cancellation");
    } finally {
      writer.release();
    }
    const after = await current(row.commandId);
    assert.equal(after.status, concurrent, "the sent/filled order must not be relabelled as cancelled");
    assert.equal(
      (await db.select().from(liveAudit)).filter((a) => a.eventType === "LIVE_CANCELLED").length,
      0,
      "no cancellation audit for a cancellation that did not happen",
    );
    // Self-trade consequence: a LIVE_CANCELLED entry is confirmed non-execution
    // and would release the reservation, admitting a second order.
    await reconcileAgentExecutions(execution.agentId);
    const [exec] = await db.select().from(executions).where(eq(executions.id, execution.id));
    assert.ok(["PENDING_TICKET", "DISPATCHED"].includes(exec!.status), `execution stayed reserved, got ${exec!.status}`);
  });
}

it("cancel of an untouched draft still cancels exactly once", async () => {
  const row = await command({ status: "LIVE_CONFIRMATION_REQUIRED" });
  const results = await Promise.all(
    Array.from({ length: 6 }, () => cancelLiveCommand({ userId: USER, commandId: row.commandId, reason: "USER_CANCELLED" })),
  );
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal((await current(row.commandId)).status, "LIVE_CANCELLED");
  assert.equal((await db.select().from(liveAudit)).filter((a) => a.eventType === "LIVE_CANCELLED").length, 1);
});

// ── 2. TTL expiry must neutralise the transport mirror atomically ───────────

it("an expired never-served entry cannot be delivered to the EA afterwards", async () => {
  const row = await command({
    status: "SENT_TO_MT5_LIVE",
    bridgeConnectionId: BRIDGE,
    sentToMt5At: new Date(Date.now() - 70_000),
    expiresAt: new Date(Date.now() - 10_000),
  });
  const execution = await linkedExecution(row);
  const mail = await mirror(row);
  const swept = await sweepExpiredLiveCommands({ userId: USER });
  assert.equal(swept.expired, 1);
  assert.equal((await current(row.commandId)).status, "LIVE_EXPIRED");
  await reconcileAgentExecutions(execution.agentId);
  assert.equal((await db.select().from(executions).where(eq(executions.id, execution.id)))[0]!.status, "EXPIRED");
  // ARX now says "never executed" and the self-trade slot is free. The mirror
  // (EA expiry is 120 s against the 60 s server TTL) must not still be served.
  const delivered = await eaPoll();
  assert.deepEqual(delivered.map((c) => c.id), [], "the EA must not receive an order ARX already declared expired");
  assert.notEqual((await mailboxRow(mail.id)).status, "PENDING");
});

it("an EA mailbox claim that commits during the sweep makes the outcome UNKNOWN, never EXPIRED", async () => {
  const row = await command({
    status: "SENT_TO_MT5_LIVE",
    bridgeConnectionId: BRIDGE,
    sentToMt5At: new Date(Date.now() - 70_000),
    expiresAt: new Date(Date.now() - 10_000),
  });
  const execution = await linkedExecution(row);
  const mail = await mirror(row);
  const ea = await pool.connect();
  let sweeping: ReturnType<typeof sweepExpiredLiveCommands>;
  try {
    // Same lock and claim the GET /api/mt5/commands transaction takes.
    await ea.query("begin");
    await ea.query("select id from mt5_commands where id = $1 for update", [mail.id]);
    await ea.query("update mt5_commands set status = 'DELIVERED', delivered_at = now() where id = $1 and status = 'PENDING'", [mail.id]);
    sweeping = sweepExpiredLiveCommands({ userId: USER });
    await lockWaitOr(sweeping);
    await ea.query("commit");
  } finally {
    ea.release();
  }
  await sweeping!;
  assert.equal((await mailboxRow(mail.id)).status, "DELIVERED");
  assert.equal((await current(row.commandId)).status, "LIVE_UNKNOWN", "delivered to the EA ⇒ outcome unknown");
  await reconcileAgentExecutions(execution.agentId);
  assert.equal((await db.select().from(executions).where(eq(executions.id, execution.id)))[0]!.status, "DISPATCHED");
});

it("a live-commands-poll pickup that commits during the sweep is never expired", async () => {
  const row = await command({
    status: "SENT_TO_MT5_LIVE",
    bridgeConnectionId: BRIDGE,
    sentToMt5At: new Date(Date.now() - 70_000),
    expiresAt: new Date(Date.now() - 10_000),
  });
  const execution = await linkedExecution(row);
  await mirror(row);
  const ea = await pool.connect();
  let sweeping: ReturnType<typeof sweepExpiredLiveCommands>;
  try {
    // Same lock and claim pickupNextLiveCommand takes on the authoritative row.
    await ea.query("begin");
    await ea.query("select id from arx_live_commands where command_id = $1 for update", [row.commandId]);
    await ea.query("update arx_live_commands set picked_by_ea_at = now() where command_id = $1 and picked_by_ea_at is null", [row.commandId]);
    sweeping = sweepExpiredLiveCommands({ userId: USER });
    assert.equal(await lockWaitOr(sweeping), "waiting");
    await ea.query("commit");
  } finally {
    ea.release();
  }
  await sweeping!;
  assert.notEqual((await current(row.commandId)).status, "LIVE_EXPIRED", "picked up by the EA ⇒ never expired");
  await sweepExpiredLiveCommands({ userId: USER });
  assert.equal((await current(row.commandId)).status, "LIVE_UNKNOWN");
  await reconcileAgentExecutions(execution.agentId);
  assert.equal((await db.select().from(executions).where(eq(executions.id, execution.id)))[0]!.status, "DISPATCHED");
});

it("already delivered mirrors keep the sweep verdict UNKNOWN and are left untouched", async () => {
  const row = await command({
    status: "SENT_TO_MT5_LIVE",
    bridgeConnectionId: BRIDGE,
    sentToMt5At: new Date(Date.now() - 70_000),
    expiresAt: new Date(Date.now() - 10_000),
  });
  const mail = await mirror(row, "DELIVERED");
  const swept = await sweepExpiredLiveCommands({ userId: USER });
  assert.equal(swept.unknown, 1);
  assert.equal((await current(row.commandId)).status, "LIVE_UNKNOWN");
  assert.equal((await mailboxRow(mail.id)).status, "DELIVERED");
});

it("an unexpired sent command and its mirror are not touched by the sweep", async () => {
  const row = await command({
    status: "SENT_TO_MT5_LIVE",
    bridgeConnectionId: BRIDGE,
    sentToMt5At: new Date(),
    expiresAt: new Date(Date.now() + 50_000),
  });
  const mail = await mirror(row);
  const swept = await sweepExpiredLiveCommands({ userId: USER });
  assert.equal(swept.expired + swept.unknown, 0);
  assert.equal((await current(row.commandId)).status, "SENT_TO_MT5_LIVE");
  assert.equal((await mailboxRow(mail.id)).status, "PENDING");
  assert.deepEqual((await eaPoll()).map((c) => c.id), [mail.id], "normal delivery is unchanged");
});

// ── 3. Mirror enqueue failure after an ambiguous commit ─────────────────────

it("a failed enqueue whose mirror actually committed is neutralised before the command is failed", async () => {
  const row = await command({ status: "SENT_TO_MT5_LIVE", bridgeConnectionId: BRIDGE, sentToMt5At: new Date() });
  const mail = await mirror(row); // INSERT committed; the client saw an error.
  assert.equal(typeof pipeline.neutralizeUndeliveredMirrors, "function");
  const verdict = await db.transaction((tx) => pipeline.neutralizeUndeliveredMirrors(tx, row.commandId));
  assert.equal(verdict, "NOT_DELIVERABLE");
  assert.equal((await mailboxRow(mail.id)).status, "cancelled");
  assert.deepEqual(await eaPoll(), []);
});

it("a failed enqueue whose mirror the EA already claimed is never reported as non-execution", async () => {
  const row = await command({ status: "SENT_TO_MT5_LIVE", bridgeConnectionId: BRIDGE, sentToMt5At: new Date() });
  const mail = await mirror(row, "DELIVERED");
  const verdict = await db.transaction((tx) => pipeline.neutralizeUndeliveredMirrors(tx, row.commandId));
  assert.equal(verdict, "MAY_BE_DELIVERED");
  assert.equal((await mailboxRow(mail.id)).status, "DELIVERED");
});

it("no mirror at all is provably undeliverable", async () => {
  const row = await command({ status: "SENT_TO_MT5_LIVE", bridgeConnectionId: BRIDGE, sentToMt5At: new Date() });
  const verdict = await db.transaction((tx) => pipeline.neutralizeUndeliveredMirrors(tx, row.commandId));
  assert.equal(verdict, "NOT_DELIVERABLE");
});

it("dispatch fails an enqueue error only after neutralising mirrors in the same transaction (source order)", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../../live/liveCommandPipeline.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function dispatchLiveCommand");
  const deliver = source.indexOf("mt5ExecutionAdapter.deliver({", start);
  const handler = source.indexOf("catch (bridgeErr", deliver);
  const neutralise = source.indexOf("neutralizeUndeliveredMirrors(tx, args.commandId)", handler);
  const failedWrite = source.indexOf('status: "LIVE_FAILED"', handler);
  const release = source.indexOf("releaseReservation(reservationId)", handler);
  assert.ok(start > -1 && deliver > start && handler > deliver);
  assert.ok(neutralise > handler && neutralise < failedWrite, "mirrors are neutralised before LIVE_FAILED is written");
  assert.ok(failedWrite < release, "reservation release follows the failure write");
  const between = source.slice(handler, release);
  assert.match(between, /eq\(arxLiveCommandsTable\.status, "SENT_TO_MT5_LIVE"\)/, "the failure write is a CAS");
  assert.match(between, /if \(failed && reservationId != null\)/, "release only after a committed failure");
});

it("the shared-trade attribution fail-safe never force-blocks a command that already left LIVE_APPROVED (source)", async () => {
  // cancelLiveCommand now refuses a lost race; its force-block fallback must
  // not then overwrite a command the alternate dispatch route already sent.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../../../routes/tradesLiveShared.ts", import.meta.url), "utf8");
  const start = source.indexOf('reason: "ATTRIBUTION_INSERT_FAILED",');
  const block = source.slice(start, source.indexOf("ATTRIBUTION_FAILSAFE_CASCADE_FAILED", start));
  assert.ok(start > -1 && block.includes('status: "LIVE_BLOCKED"'));
  assert.match(block, /eq\(arxLiveCommandsTable\.status, "LIVE_APPROVED"\)/, "force-block is a CAS from LIVE_APPROVED");
  assert.match(block, /madeTerminal = blocked\.length === 1/, "terminal only when the CAS matched");
});
