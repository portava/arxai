// Runs the real manager/reconciler against an in-memory SQL seam and a fake
// guardian. A network/database call is a test failure. No broker account exists.
import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { getTableColumns, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type {
  ArxLiveCommand,
  SelfTradeAgent,
  SelfTradeAgentExecution,
} from "@workspace/db";

process.env.DATABASE_URL =
  "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");
mock.method(database.pool, "query", () => {
  throw new Error("Unexpected database access");
});
mock.method(database.pool, "connect", () => {
  throw new Error("Unexpected database access");
});
const {
  selfTradeAgentExecutionsTable: executions,
  selfTradeDecisionsTable: decisions,
  arxLiveCommandsTable: commands,
  arxLivePositionsTable: positions,
  mt5ConnectionTable: connections,
} = database;
const dialect = new PgDialect();
const stamp = new Date("2026-10-25T23:59:58Z");
let execution: SelfTradeAgentExecution;
/** Further FILLED executions of the same agent (protective shared-deadline case). */
let extraExecutions: SelfTradeAgentExecution[] = [];
let commandRows: ArxLiveCommand[];
/** The decision thesis the manager reads (protective cases set an invalidation). */
let thesisRow: Record<string, unknown>;
/** The agent's bridge connection row (raw mt5_connection shape); undefined → no row. */
let connectionRow: Record<string, unknown> | undefined;
let connectionReadThrows: boolean;
/** Audit event types written this test, in order (the audit writer is a fixture). */
let auditEvents: string[];
/** The same audit rows with their reason text and afterState. */
let auditRows: Array<{ eventType: string; reason?: string; afterState?: Record<string, unknown> }>;
/** Further bridge connection rows (protective per-bridge cases). */
let extraConnections: Record<string, unknown>[] = [];
// Broker-affecting commands for the managed ticket (fresh-facts ordering check).
let ticketCommands: Partial<ArxLiveCommand>[] = [];
let entryCommand: ArxLiveCommand;
let position: Record<string, unknown>;
let competingPosition: Record<string, unknown> | undefined;
let extraPositions: Record<string, unknown>[] = [];
let dispatches: unknown[];
let submit: () => Promise<
  | { ok: true; commandId?: string }
  | { ok: false; error: string; commandId?: string }
>;
let auditFails: boolean;
let failCommandLinkWrite: boolean;

function queryFor(table: unknown) {
  let predicate: SQL;
  const query = {
    where(value: SQL) {
      predicate = value;
      return query;
    },
    limit() {
      return query;
    },
    orderBy() {
      return query;
    },
    then(
      resolve: (rows: unknown[]) => unknown,
      reject: (err: unknown) => unknown,
    ) {
      try {
        const params = dialect.sqlToQuery(predicate).params;
        let rows: unknown[] = [];
        if (table === executions) {
          rows = [execution, ...extraExecutions]
            .filter((e) => e.agentId === params[0] && params.includes(e.status))
            .map((e) => structuredClone(e));
        } else if (table === decisions)
          rows = [{ id: 7, thesis: structuredClone(thesisRow) }];
        else if (table === connections) {
          if (connectionReadThrows) throw new Error("connection seam unavailable");
          rows = [connectionRow, ...extraConnections]
            .filter((c) => c && c.id === params[0])
            .slice(0, 1)
            .map((c) => structuredClone(c));
        } else if (
          table === commands &&
          dialect.sqlToQuery(predicate).sql.includes("->>'brokerTicket'")
        )
          rows = ticketCommands.map((c) => structuredClone(c));
        else if (table === commands)
          rows = [
            ...commandRows,
            ...(commandRows.some((c) => c.commandId === "entry-1")
              ? []
              : [entryCommand]),
          ]
            .filter((c) => params.includes(c.commandId))
            .map((c) => structuredClone(c));
        else throw new Error("Unexpected select table");
        return Promise.resolve(rows).then(resolve, reject);
      } catch (err) {
        return Promise.reject(err).then(resolve, reject);
      }
    },
  };
  return query;
}
const fakeDb = {
  select: () => ({ from: queryFor }),
  update: (table: unknown) => {
    assert.equal(table, executions);
    return {
      set: (patch: Partial<SelfTradeAgentExecution>) => ({
        where: (predicate: SQL) => ({
          returning: async () => {
            const { sql, params } = dialect.sqlToQuery(predicate);
            // Every state update must use both execution ID and previous state.
            assert.match(sql, /"id" = \$1/);
            assert.match(sql, /"status" = \$2/);
            const row = [execution, ...extraExecutions].find((e) => e.id === params[0]);
            if (!row || row.status !== params[1]) return [];
            if (sql.includes("management_state")) {
              assert.match(sql, /"management_state" = \$3::jsonb/);
              if (JSON.stringify(row.managementState) !== params[2])
                return [];
            }
            if (
              failCommandLinkWrite &&
              (
                patch.managementState as
                  | { pendingManagement?: { commandId?: string } }
                  | undefined
              )?.pendingManagement?.commandId
            ) {
              throw new Error(
                "simulated database loss after broker acceptance",
              );
            }
            Object.assign(row, structuredClone(patch));
            return [{ id: row.id }];
          },
        }),
      }),
    };
  },
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });
mock.module("../../positions/ledger.js", {
  namedExports: {
    livePositionColumns: getTableColumns(positions),
    livePositionLedger: {
      read: async (args: { where: SQL; limit: number }) => {
        const query = dialect.sqlToQuery(args.where);
        if (query.sql.includes('"id" = ')) {
          // Protective path: exact 9-field row scope (managementPositionScope).
          for (const column of [
            "id",
            "user_id",
            "bridge_connection_id",
            "account_login",
            "broker_server",
            "broker_ticket",
            "source_command_id",
            "symbol",
            "side",
          ]) {
            assert.ok(query.sql.includes(`"${column}" = `), `scope must pin ${column}`);
          }
          const [id, userId, bridge, login, server, ticket, source, symbol, side] = query.params;
          return [competingPosition, position, ...extraPositions]
            .filter(
              (p) =>
                p &&
                p.id === id &&
                p.userId === userId &&
                p.bridgeConnectionId === bridge &&
                p.accountLogin === login &&
                p.brokerServer === server &&
                p.brokerTicket === ticket &&
                p.sourceCommandId === source &&
                p.symbol === symbol &&
                p.side === side,
            )
            .slice(0, args.limit)
            .map((p) => structuredClone(p));
        }
        for (const column of [
          "user_id",
          "broker_ticket",
          "bridge_connection_id",
          "account_login",
          "broker_server",
          "symbol",
        ]) {
          assert.ok(
            query.sql.includes(`"${column}" = `),
            `lookup must scope ${column}`,
          );
        }
        const [userId, ticket, bridge, login, server, symbol] = query.params;
        return [competingPosition, position, ...extraPositions]
          .filter(
            (p) =>
              p &&
              p.userId === userId &&
              p.brokerTicket === ticket &&
              p.bridgeConnectionId === bridge &&
              p.accountLogin === login &&
              p.brokerServer === server &&
              p.symbol === symbol,
          )
          .slice(0, args.limit)
          .map((p) => structuredClone(p));
      },
    },
  },
});
mock.module("../../positionGuardian/manage.js", {
  namedExports: {
    guardianInstantManage: async (args: unknown) => {
      dispatches.push(args);
      return submit();
    },
  },
});
mock.module("../audit.js", {
  namedExports: {
    writeSelfTradeAudit: async (
      _db: unknown,
      row: { eventType: string; reason?: string; afterState?: Record<string, unknown> },
    ) => {
      if (auditFails) throw new Error("audit unavailable");
      auditEvents.push(row.eventType);
      auditRows.push(structuredClone(row));
    },
  },
});
mock.module("../../mt5/contractSize.js", {
  namedExports: {
    resolveContractSize: async () => ({
      contractSize: 100_000,
      profitCurrency: "USD",
    }),
    resolveQuoteToAccountFx: () => ({ factor: 1 }),
  },
});
mock.module("../../live/accountCurrency.js", {
  namedExports: { getAccountCurrency: async () => "USD" },
});
// This in-memory orchestration suite supplies a trusted evidence seam. The real
// signed-target/receipt/lock gate is exercised by managementTarget.postgres.test.
// The exact 9-field row scope is the real (pure SQL-builder) one.
const { managementPositionScope } = await import("../managementConsumers.js");
mock.module("../managementConsumers.js", {
  namedExports: {
    managementPositionScope,
    withBoundManagementClose: async (
      command: ArxLiveCommand,
      apply: Function,
    ) => {
      execution.managementState = {
        ...(execution.managementState as object),
        closeAccounting: {
          status: "UNVERIFIED",
          reason: "HISTORICAL_ACCOUNTING_EVIDENCE_MISSING",
          entryCommandId: entryCommand.commandId,
          symbol: entryCommand.symbol,
        },
      };
      return apply(fakeDb, {}, position, {
        execution,
        entry: entryCommand,
        command,
      });
    },
  },
});
const { manageAgentPositions } = await import("../livePositionManager.js");
const { createProtectiveCycle, drainProtectiveCycle } = await import("../protectiveActionPath.js");
const { reconcileAgentExecutions } = await import("../agentReconciliation.js");
const agent = { id: 5, agentKey: "alpha", autonomyLevel: 3 } as SelfTradeAgent;

function fullEntry() {
  return {
    commandId: "entry-1",
    userId: 9,
    selfTradeAgentId: 5,
    selfTradeDecisionId: 7,
    commandType: "PLACE_LIVE_MARKET_ORDER",
    symbol: "EURUSD",
    side: "BUY",
    status: "LIVE_FILLED",
    fillPrice: 1.1,
    brokerTicket: "123",
    filledAt: stamp,
    bridgeConnectionId: 12,
    accountLogin: "synthetic-demo",
    brokerServer: "synthetic-server",
    requestedVolume: 0.1,
    executedVolume: 0.1,
  } as ArxLiveCommand;
}

beforeEach(() => {
  execution = {
    id: 1,
    agentId: 5,
    decisionId: 7,
    executingUserId: 9,
    commandId: "entry-1",
    symbol: "EURUSD",
    side: "BUY",
    brokerTicket: "123",
    status: "FILLED",
    fillPrice: 1.1,
    intendedVolume: 0.1,
    slPrice: 1.09,
    managementState: {},
    updatedAt: stamp,
  } as SelfTradeAgentExecution;
  extraExecutions = [];
  commandRows = [];
  entryCommand = fullEntry();
  competingPosition = undefined;
  extraPositions = [];
  thesisRow = { stopLoss: 1.09, takeProfits: [], invalidation: null };
  connectionRow = undefined;
  connectionReadThrows = false;
  auditEvents = [];
  auditRows = [];
  extraConnections = [];
  const synced = new Date();
  position = {
    id: 1,
    userId: 9,
    brokerTicket: "123",
    symbol: "EURUSD",
    side: "BUY",
    volume: 0.1,
    bridgeConnectionId: 12,
    accountLogin: "synthetic-demo",
    brokerServer: "synthetic-server",
    sourceCommandId: "entry-1",
    entryPrice: 1.1,
    currentPrice: 1.112,
    stopLoss: 1.09,
    takeProfit: null,
    closedAt: null,
    reconcileState: null,
    // arx_live_positions.last_synced_at is NOT NULL DEFAULT now() in the schema.
    lastSyncedAt: synced,
    // The complete sweep writes both (routes/mt5Live.ts); reconcilers write lastSyncedAt alone.
    lastReliableSnapshotAt: synced,
    brokerAbsentSnapshotCount: 0,
  };
  ticketCommands = [];
  dispatches = [];
  submit = async () => ({ ok: true, commandId: "modify-1" });
  auditFails = false;
  failCommandLinkWrite = false;
});
function settledModify(status = "LIVE_FILLED") {
  return {
    commandId: "modify-1",
    userId: 9,
    commandType: "MODIFY_LIVE_SLTP",
    symbol: "EURUSD",
    status,
    filledAt: stamp,
    bridgeConnectionId: 12,
    accountLogin: "synthetic-demo",
    brokerServer: "synthetic-server",
    requestedVolume: 0.1,
    executedVolume: 0.1,
    stopLoss: 1.1,
    payload: { brokerTicket: "123" },
  } as ArxLiveCommand;
}

describe("actual manager orchestration", () => {
  it("reserves one management request across concurrent cycles, never marks acceptance complete", async () => {
    await Promise.all([
      manageAgentPositions(agent),
      manageAgentPositions(agent),
      manageAgentPositions(agent),
    ]);
    assert.equal(dispatches.length, 1);
    assert.deepEqual(
      (dispatches[0] as { intent: { selfTradeManagement: unknown } }).intent
        .selfTradeManagement,
      {
        executionId: execution.id,
        positionRowId: 1,
        claimId: (
          execution.managementState as {
            pendingManagement: { claimId: string };
          }
        ).pendingManagement.claimId,
      },
    );
    assert.equal(execution.slPrice, 1.09);
    assert.equal(
      (execution.managementState as { beMoved?: boolean }).beMoved,
      undefined,
    );
    assert.equal(
      (
        execution.managementState as {
          pendingManagement: { commandId: string };
        }
      ).pendingManagement.commandId,
      "modify-1",
    );
    commandRows = [settledModify("LIVE_ACKNOWLEDGED")];
    await manageAgentPositions(agent);
    assert.equal(dispatches.length, 1);
  });
  it("only confirms break-even after the command settles and broker stop agrees", async () => {
    assert.equal((await manageAgentPositions(agent)).modified, 0);
    commandRows = [settledModify()];
    assert.equal((await manageAgentPositions(agent)).modified, 0);
    position.stopLoss = 1.1;
    assert.equal((await manageAgentPositions(agent)).modified, 1);
    assert.equal(execution.slPrice, 1.1);
    assert.equal(
      (execution.managementState as { beMoved: boolean }).beMoved,
      true,
    );
    assert.equal((await manageAgentPositions(agent)).modified, 0);
    assert.equal(dispatches.length, 1);
  });
  it("a confirmed rejection clears the claim and permits a fresh evaluated attempt next cycle", async () => {
    await manageAgentPositions(agent);
    commandRows = [settledModify("LIVE_REJECTED")];
    await manageAgentPositions(agent);
    assert.equal(dispatches.length, 1);
    assert.equal(
      (execution.managementState as { pendingManagement?: unknown })
        .pendingManagement,
      undefined,
    );
    assert.equal(execution.slPrice, 1.09);
    await manageAgentPositions(agent);
    assert.equal(dispatches.length, 2);
  });
  it("tracks a refused command instead of assuming the broker never saw it", async () => {
    submit = async () => ({
      ok: false,
      error: "OUTCOME_UNKNOWN",
      commandId: "modify-1",
    });
    await manageAgentPositions(agent);
    commandRows = [settledModify("LIVE_UNKNOWN")];
    await manageAgentPositions(agent);
    assert.equal(dispatches.length, 1);
    assert.equal(
      (
        execution.managementState as {
          pendingManagement: { commandId: string };
        }
      ).pendingManagement.commandId,
      "modify-1",
    );
  });
  it("a pre-draft refusal frees the claim because no command was created", async () => {
    submit = async () => ({ ok: false, error: "USER_NOT_ARMED_FOR_LIVE" });
    await manageAgentPositions(agent);
    assert.deepEqual(execution.managementState, {});
    assert.equal(execution.slPrice, 1.09);
  });
  it("retains a claim after an ambiguous exception, with no blind retry", async () => {
    submit = async () => {
      throw new Error("connection lost after submission");
    };
    await manageAgentPositions(agent);
    await manageAgentPositions(agent);
    assert.equal(dispatches.length, 1);
    assert.ok(
      (execution.managementState as { pendingManagement?: unknown })
        .pendingManagement,
    );
  });
  it("a crash after acceptance preserves the durable claim across restart and never expires it", async () => {
    failCommandLinkWrite = true;
    await manageAgentPositions(agent);
    assert.equal(dispatches.length, 1);
    const memory = execution.managementState as {
      pendingManagement: {
        claimId: string;
        commandId?: string;
        requestedAt: string;
      };
    };
    const claimId = memory.pendingManagement.claimId;
    assert.ok(claimId);
    assert.equal(memory.pendingManagement.commandId, undefined);
    // A process can disappear before it saved the accepted command ID. The DB
    // reservation survives, while a newly imported manager has no old memory.
    memory.pendingManagement.requestedAt = "2000-01-01T00:00:00Z";
    failCommandLinkWrite = false;
    const url = new URL("../livePositionManager.js", import.meta.url);
    url.searchParams.set("restart", "crash-after-acceptance");
    const restarted = await import(url.href);
    await restarted.manageAgentPositions(agent);
    await restarted.manageAgentPositions(agent);
    assert.equal(dispatches.length, 1);
    assert.equal(
      (execution.managementState as typeof memory).pendingManagement.claimId,
      claimId,
    );
    assert.equal(execution.slPrice, 1.09);
  });
  it("an aged UNKNOWN command stays reserved after restart; time never proves rejection", async () => {
    await manageAgentPositions(agent);
    const memory = execution.managementState as {
      pendingManagement: { claimId: string; requestedAt: string };
    };
    const claimId = memory.pendingManagement.claimId;
    memory.pendingManagement.requestedAt = "2000-01-01T00:00:00Z";
    commandRows = [settledModify("LIVE_UNKNOWN")];
    const url = new URL("../livePositionManager.js", import.meta.url);
    url.searchParams.set("restart", "old-unknown-command");
    const restarted = await import(url.href);
    assert.equal((await restarted.manageAgentPositions(agent)).held, 1);
    assert.equal(dispatches.length, 1);
    assert.equal(
      (execution.managementState as typeof memory).pendingManagement.claimId,
      claimId,
    );
  });
  it("another account's rejection cannot free this position's management reservation", async () => {
    await manageAgentPositions(agent);
    const before = structuredClone(execution.managementState);
    commandRows = [{ ...settledModify("LIVE_REJECTED"), userId: 99 }];
    await manageAgentPositions(agent);
    assert.deepEqual(execution.managementState, before);
    assert.equal(dispatches.length, 1);
  });
  it("missing command evidence never becomes a completed stop or a retry", async () => {
    submit = async () => ({ ok: true });
    await manageAgentPositions(agent);
    await manageAgentPositions(agent);
    assert.equal(dispatches.length, 1);
    assert.equal(execution.slPrice, 1.09);
  });
  it("audit failure stops the request before the guardian", async () => {
    auditFails = true;
    await manageAgentPositions(agent);
    assert.equal(dispatches.length, 0);
    assert.deepEqual(execution.managementState, {});
  });
  it("repairs legacy optimistic break-even memory using actual broker protection", async () => {
    execution.managementState = { beMoved: true };
    position.currentPrice = 1.12;
    await manageAgentPositions(agent);
    const request = dispatches[0] as { intent: { newStopLoss: number } };
    assert.equal(request.intent.newStopLoss, 1.1);
  });
  it("does not repeatedly close while a previous close is unresolved", async () => {
    position.currentPrice = 1.08;
    // Override the real thesis fixture with an invalidation by using a stop
    // manager-independent legacy pending EXIT: it must hold before evaluation.
    execution.managementState = {
      lastAction: "EXIT",
      closeCommandId: "close-1",
    };
    commandRows = [
      {
        ...settledModify("LIVE_UNKNOWN"),
        commandId: "close-1",
        commandType: "CLOSE_LIVE_POSITION",
      },
    ];
    assert.equal((await manageAgentPositions(agent)).held, 1);
    assert.equal(dispatches.length, 0);
  });
  it("L2 remains advisory and does not claim or dispatch", async () => {
    assert.equal(
      (await manageAgentPositions({ ...agent, autonomyLevel: 2 })).alerted,
      1,
    );
    assert.equal(dispatches.length, 0);
    assert.deepEqual(execution.managementState, {});
  });
});

describe("actual execution reconciliation", () => {
  it("prepared human-confirmed fill advances exactly once even with overlapping sweeps", async () => {
    execution.status = "PENDING_TICKET";
    commandRows = [fullEntry()];
    const results = await Promise.all([
      reconcileAgentExecutions(5),
      reconcileAgentExecutions(5),
    ]);
    assert.equal(
      results.reduce((total, result) => total + result.filled, 0),
      1,
    );
    assert.equal(execution.status, "FILLED");
    assert.equal(execution.filledAt?.toISOString(), "2026-10-25T23:59:58.000Z");
  });
  it("cancellation resolves a prepared draft and a partial fill remains unsettled", async () => {
    execution.status = "PENDING_TICKET";
    commandRows = [{ ...fullEntry(), status: "LIVE_PARTIALLY_FILLED" }];
    assert.equal((await reconcileAgentExecutions(5)).filled, 0);
    assert.equal(execution.status, "DISPATCHED");
    commandRows[0].status = "LIVE_CANCELLED";
    commandRows[0].executedVolume = 0;
    await reconcileAgentExecutions(5);
    assert.equal(execution.status, "BLOCKED");
  });
  it("settled close uses broker time once and withholds uncertified profit", async () => {
    execution.managementState = { closeCommandId: "close-1" };
    commandRows = [
      {
        ...settledModify(),
        actorType: "SELF_TRADE_AGENT",
        selfTradeAgentId: 5,
        selfTradeDecisionId: 7,
        commandId: "close-1",
        commandType: "CLOSE_LIVE_POSITION",
        fillPrice: 1.11,
      },
    ];
    const results = await Promise.all([
      reconcileAgentExecutions(5),
      reconcileAgentExecutions(5),
    ]);
    assert.equal(
      results.reduce((total, result) => total + result.closed, 0),
      1,
    );
    assert.equal(execution.status, "CLOSED");
    assert.equal(execution.closedAt?.getTime(), stamp.getTime());
    assert.equal(execution.realizedPnl, null);
    assert.equal(
      (execution.managementState as { closeAccounting: { status: string } })
        .closeAccounting.status,
      "UNVERIFIED",
    );
  });
  it("legacy manual close retains its prior calculation path", async () => {
    execution.managementState = { closeCommandId: "close-1" };
    commandRows = [
      {
        ...settledModify(),
        commandId: "close-1",
        commandType: "CLOSE_LIVE_POSITION",
        fillPrice: 1.11,
      },
    ];
    assert.equal((await reconcileAgentExecutions(5)).closed, 1);
    assert.ok(Math.abs(execution.realizedPnl! - 100) < 1e-8);
  });
  it("an invalid or cross-account close never mutates the execution", async () => {
    execution.managementState = { closeCommandId: "close-1" };
    commandRows = [
      {
        ...settledModify(),
        commandId: "close-1",
        commandType: "CLOSE_LIVE_POSITION",
        fillPrice: NaN,
      },
    ];
    assert.equal((await reconcileAgentExecutions(5)).closed, 0);
    commandRows[0].fillPrice = 1.11;
    commandRows[0].userId = 99;
    assert.equal((await reconcileAgentExecutions(5)).closed, 0);
    assert.equal(execution.status, "FILLED");
  });
});

describe("full broker identity and quantity orchestration", () => {
  it("manages a proven decorated symbol but holds a different same-user account", async () => {
    entryCommand.symbol = "EURUSD.a";
    entryCommand.payload = {
      selfTradeSymbolBinding: {
        requestedSymbol: "EURUSD",
        brokerSymbol: "EURUSD.a",
      },
    };
    position.symbol = "EURUSD.a";
    position.accountLogin = "different-account";
    await manageAgentPositions(agent);
    assert.equal(dispatches.length, 0);
    position.accountLogin = "synthetic-demo";
    await manageAgentPositions(agent);
    assert.equal(dispatches.length, 1);
  });
  it("holds missing entry identity without making a management request", async () => {
    entryCommand = { ...entryCommand, symbol: "EURUSD.a", payload: {} };
    await manageAgentPositions(agent);
    assert.equal(dispatches.length, 0);
  });
  it("never books full P&L when the close command reports a smaller quantity", async () => {
    execution.managementState = { closeCommandId: "close-1" };
    commandRows = [
      {
        ...settledModify(),
        commandId: "close-1",
        commandType: "CLOSE_LIVE_POSITION",
        fillPrice: 1.11,
        executedVolume: 0.05,
      },
    ];
    assert.equal((await reconcileAgentExecutions(5)).closed, 0);
    assert.equal(execution.status, "FILLED");
    assert.equal(execution.realizedPnl, undefined);
    commandRows[0].requestedVolume = 0.05;
    assert.equal((await reconcileAgentExecutions(5)).closed, 0);
    commandRows[0].requestedVolume = commandRows[0].executedVolume = 0.1;
    commandRows[0].accountLogin = "other-account";
    assert.equal((await reconcileAgentExecutions(5)).closed, 0);
  });
});

it("ticket reuse selects the exact account even when another account's row comes first", async () => {
  competingPosition = {
    ...position,
    bridgeConnectionId: 99,
    accountLogin: "other-account",
  };
  await manageAgentPositions(agent);
  assert.equal(dispatches.length, 1);
});

describe("fresh position observation before automatic management", () => {
  async function heldWith(reason: string) {
    const result = await manageAgentPositions(agent);
    assert.equal(dispatches.length, 0);
    assert.equal(result.held, 1);
    assert.equal(result.evaluated, 0);
    assert.equal(result.heldReasons?.[reason], 1);
    // No claim is taken: the next fresh observation can be evaluated normally.
    assert.deepEqual(execution.managementState, {});
  }
  it("a stale broker snapshot never drives a stop move", async () => {
    position.lastSyncedAt = new Date(Date.now() - 91_000);
    await heldWith("MANAGEMENT_OBSERVATION_STALE");
  });
  it("a snapshot dated beyond clock-skew tolerance is refused", async () => {
    position.lastSyncedAt = new Date(Date.now() + 60_000);
    await heldWith("MANAGEMENT_OBSERVATION_FUTURE_DATED");
  });
  for (const lastSyncedAt of [null, "garbage", new Date(Number.NaN)])
    it(`malformed snapshot time ${String(lastSyncedAt)} is refused`, async () => {
      position.lastSyncedAt = lastSyncedAt;
      await heldWith("MANAGEMENT_OBSERVATION_TIMESTAMP_INVALID");
    });
  it("a snapshot older than the entry fill is refused", async () => {
    entryCommand.filledAt = new Date();
    position.lastSyncedAt = new Date(Date.now() - 1_000);
    await heldWith("MANAGEMENT_OBSERVATION_PREDATES_COMMAND");
  });
  it("a snapshot older than the last command sent for this ticket is refused", async () => {
    ticketCommands = [
      { commandId: "manual-modify", sentToMt5At: new Date(Date.now() - 1_000), filledAt: null, rejectedAt: null },
    ];
    position.lastSyncedAt = new Date(Date.now() - 5_000);
    await heldWith("MANAGEMENT_OBSERVATION_PREDATES_COMMAND");
  });
  it("a fresh snapshot newer than every command still manages normally", async () => {
    ticketCommands = [
      { commandId: "old-modify", sentToMt5At: new Date(Date.now() - 60_000), filledAt: new Date(Date.now() - 59_000), rejectedAt: null },
    ];
    position.lastSyncedAt = new Date(Date.now() - 1_000);
    const result = await manageAgentPositions(agent);
    assert.equal(dispatches.length, 1);
    assert.equal(result.evaluated, 1);
  });
});

// ── Protective-action path (owner decision 2026-10-27) ───────────────────────
// Starts FROM an ordinary observation hold. The stale row never drives an
// action; only a strictly newer complete sweep that passes the stricter
// standard may. Every case keeps the ordinary hold assertions intact.
describe("protective-action path from an observation hold", () => {
  let clock: number;
  let sleeps: number[];
  let onSleep: ((poll: number) => void) | undefined;
  let stopEngaged: boolean;
  let arming: { isArmed: boolean; killSwitchEngaged: boolean } | null;
  const seams = () => ({
    protective: {
      now: () => clock,
      // Virtual time: concurrent sleepers (one per bridge) wake together
      // instead of adding up; a single sleeper advances the clock by ms.
      sleep: async (ms: number) => {
        const wake = clock + ms;
        sleeps.push(ms);
        await Promise.resolve();
        clock = Math.max(clock, wake);
        onSleep?.(sleeps.length);
      },
      readPlatformStop: async () => ({
        engaged: stopEngaged,
        sources: stopEngaged ? (["platform_emergency_stop"] as const) : [],
        reason: stopEngaged ? "platform emergency stop engaged" : null,
        detail: stopEngaged ? { platform_emergency_stop: "engaged by fixture" } : {},
        readable: true,
        engagedAt: {},
      }) as never,
      readArming: async () => arming,
    },
  });
  function liveConnection(): Record<string, unknown> {
    return {
      id: 12,
      userId: 9,
      accountNumber: "synthetic-demo",
      brokerName: "synthetic-server",
      serverName: "Synthetic-Live-1",
      status: "connected",
      apiKeyHash: "fixture-hash",
      tokenRevokedAt: null,
      accountType: "live",
      mode: "LIVE",
      capabilities: { supportsManagementTargetV1: true },
      eaVersion: "1.54",
      lastHeartbeat: new Date(clock),
      lastPositionsSnapshotAt: new Date(clock - 91_000),
    };
  }
  /** A complete sweep lands now: row and marker written together, heartbeat refreshed. */
  function sweepLands(patch: Record<string, unknown> = {}) {
    const at = new Date(clock);
    Object.assign(position, { lastSyncedAt: at, lastReliableSnapshotAt: at, brokerAbsentSnapshotCount: 0 }, patch);
    connectionRow!.lastPositionsSnapshotAt = new Date(clock + 5);
    connectionRow!.lastHeartbeat = at;
  }
  beforeEach(() => {
    clock = Date.now();
    sleeps = [];
    onSleep = undefined;
    stopEngaged = false;
    arming = { isArmed: true, killSwitchEngaged: false };
    connectionRow = liveConnection();
    // Invalidation breached on the STALE row: a protective EXIT candidate.
    thesisRow = { stopLoss: 1.09, takeProfits: [], invalidation: 1.095 };
    position.currentPrice = 1.094;
    const stale = new Date(clock - 91_000);
    position.lastSyncedAt = stale;
    position.lastReliableSnapshotAt = stale;
  });
  async function run() {
    const result = await manageAgentPositions(agent, 1, "admin", seams());
    // The ordinary hold is unchanged in every case.
    assert.equal(result.held, 1);
    assert.equal(result.evaluated, 0);
    assert.equal(result.heldReasons.MANAGEMENT_OBSERVATION_STALE, 1);
    return result;
  }
  async function heldProtective(reason: string) {
    const result = await run();
    assert.equal(dispatches.length, 0);
    assert.deepEqual(result.protective.held, { [reason]: 1 });
    assert.equal(result.protective.acted, 0);
    assert.deepEqual(execution.managementState, {});
    assert.ok(auditEvents.includes("PROTECTIVE_ACTION_HELD"));
    return result;
  }

  it("1. no bridge connection row holds before any wait", async () => {
    connectionRow = undefined;
    await heldProtective("PROTECTIVE_BRIDGE_UNVERIFIED");
    assert.equal(sleeps.length, 0);
  });
  it("2. a strictly newer sweep with the breach still present dispatches one protective close", async () => {
    onSleep = (poll) => {
      if (poll === 3) sweepLands();
    };
    const result = await run();
    assert.equal(dispatches.length, 1);
    const request = dispatches[0] as { ruleId: string; intent: Record<string, unknown> };
    assert.equal(request.ruleId, "self-trade-manage");
    assert.equal(request.intent.action, "CLOSE");
    assert.equal("newStopLoss" in request.intent, false);
    assert.equal(result.protective.acted, 1);
    assert.deepEqual(result.protective.held, {});
    assert.equal(result.protective.considered, 1);
    assert.equal(result.protective.waitedMs, 3000);
    assert.equal(sleeps.length, 3);
    const memory = execution.managementState as {
      pendingManagement: { action: string; commandId?: string; protective: { trigger: string; heldReason: string; evidence: { lastSyncedAt: string } } };
      closeCommandId?: string;
    };
    assert.equal(memory.pendingManagement.action, "EXIT");
    assert.equal(memory.pendingManagement.commandId, "modify-1");
    assert.equal(memory.closeCommandId, "modify-1");
    assert.equal(memory.pendingManagement.protective.trigger, "EXIT_INVALIDATION");
    assert.equal(memory.pendingManagement.protective.heldReason, "MANAGEMENT_OBSERVATION_STALE");
    assert.equal(
      memory.pendingManagement.protective.evidence.lastSyncedAt,
      (position.lastSyncedAt as Date).toISOString(),
    );
    assert.deepEqual(auditEvents, ["MANAGEMENT_DISPATCH_INTENT", "MANAGEMENT_EXIT_DISPATCH"]);
  });
  it("3. a fresh sweep showing price recovered clears the trigger; nothing is sent", async () => {
    onSleep = (poll) => {
      if (poll === 3) sweepLands({ currentPrice: 1.1 });
    };
    await heldProtective("PROTECTIVE_HOLD_TRIGGER_CLEARED");
  });
  it("4. a fresh sweep showing a different size holds for review", async () => {
    onSleep = (poll) => {
      if (poll === 3) sweepLands({ volume: 0.05 });
    };
    await heldProtective("PROTECTIVE_IDENTITY_VOLUME_CHANGED");
  });
  it("5. no sweep within the budget holds with a bounded wait", async () => {
    const result = await heldProtective("PROTECTIVE_HOLD_NO_FRESH_SWEEP");
    assert.ok(sleeps.length >= 1 && sleeps.length <= 20, String(sleeps.length));
    assert.equal(result.protective.waitedMs, 20_000);
  });
  it("6. a final-target EXIT is profit-taking, not protective: no wait, no audit", async () => {
    thesisRow = { stopLoss: 1.09, takeProfits: [{ from: 1.105, to: 1.11 }], invalidation: null };
    position.currentPrice = 1.112;
    const result = await run();
    assert.equal(result.protective.considered, 0);
    assert.equal(sleeps.length, 0);
    assert.equal(dispatches.length, 0);
    assert.deepEqual(auditEvents, []);
  });
  it("7. an L2 agent never enters the protective path", async () => {
    const result = await manageAgentPositions({ ...agent, autonomyLevel: 2 }, 1, "admin", seams());
    assert.equal(result.held, 1);
    assert.equal(result.alerted, 0);
    assert.equal(result.protective.considered, 0);
    assert.equal(sleeps.length, 0);
    assert.deepEqual(auditEvents, []);
  });
  it("8. the platform emergency stop holds before any wait", async () => {
    stopEngaged = true;
    await heldProtective("PROTECTIVE_HOLD_PLATFORM_STOP_ENGAGED");
    assert.equal(sleeps.length, 0);
  });
  it("9. a manual command settled during the wait is ordered before the evidence", async () => {
    let filledAt: Date | undefined;
    onSleep = (poll) => {
      if (poll === 1) {
        filledAt = new Date(clock);
        ticketCommands = [
          { commandId: "manual-modify", status: "LIVE_FILLED", sentToMt5At: new Date(clock - 200), filledAt, rejectedAt: null },
        ];
      }
      // A sweep older than the manual command is not evidence yet.
      if (poll === 2) sweepLands({ lastSyncedAt: new Date(clock - 1_500), lastReliableSnapshotAt: new Date(clock - 1_500) });
      if (poll === 4) sweepLands();
    };
    const result = await run();
    assert.equal(dispatches.length, 1);
    assert.equal(result.protective.acted, 1);
    assert.equal(sleeps.length, 4);
    // The claim carries the newest ticket-command time it was ordered after.
    const evidence = (execution.managementState as { pendingManagement: { protective: { evidence: { ticketCommandAt: string } } } })
      .pendingManagement.protective.evidence;
    assert.equal(evidence.ticketCommandAt, filledAt!.toISOString());
  });
  it("9b. a manual command still in flight holds at once, without waiting", async () => {
    ticketCommands = [
      { commandId: "manual-close", status: "SENT_TO_MT5_LIVE", sentToMt5At: new Date(clock - 95_000), filledAt: null, rejectedAt: null },
    ];
    await heldProtective("PROTECTIVE_HOLD_MANUAL_COMMAND_IN_FLIGHT");
    assert.equal(sleeps.length, 0);
    const held = auditRows.find((r) => r.eventType === "PROTECTIVE_ACTION_HELD")!;
    assert.match(held.reason!, /manual-close/);
    assert.match(held.reason!, /in flight/);
  });
  it("9c. a manual command sent during the wait and not yet settled holds as in flight", async () => {
    onSleep = (poll) => {
      if (poll === 1)
        ticketCommands = [
          { commandId: "manual-modify", status: "SENT_TO_MT5_LIVE", sentToMt5At: new Date(clock), filledAt: null, rejectedAt: null },
        ];
      // Even a sweep newer than the send time is not proof the modify is reflected.
      if (poll === 2) sweepLands();
    };
    await heldProtective("PROTECTIVE_HOLD_MANUAL_COMMAND_IN_FLIGHT");
    assert.equal(sleeps.length, 1);
  });
  it("10. a newer row written by a reconciler, not a sweep, is never evidence", async () => {
    onSleep = () => {
      position.lastSyncedAt = new Date(clock);
    };
    await heldProtective("PROTECTIVE_OBSERVATION_NOT_FROM_SWEEP");
    assert.equal(sleeps.length, 20);
  });
  it("11. a break-even move is deferred to the next cycle without waiting", async () => {
    thesisRow = { stopLoss: 1.09, takeProfits: [], invalidation: null };
    position.currentPrice = 1.112;
    await heldProtective("PROTECTIVE_HOLD_DEFERRED_TO_NEXT_CYCLE");
    assert.equal(sleeps.length, 0);
  });
  it("12. a degraded heartbeat at the claim holds instead of claiming a command the gate would block", async () => {
    connectionRow!.lastHeartbeat = new Date(clock - 20_000);
    onSleep = (poll) => {
      if (poll === 3) {
        sweepLands();
        connectionRow!.lastHeartbeat = new Date(clock - 23_000);
      }
    };
    await heldProtective("PROTECTIVE_BRIDGE_HEARTBEAT_NOT_FRESH");
  });
  it("13. a pipeline refusal before any command frees the claim", async () => {
    submit = async () => ({ ok: false, error: "USER_NOT_ARMED_FOR_LIVE" });
    onSleep = (poll) => {
      if (poll === 3) sweepLands();
    };
    const result = await run();
    assert.equal(dispatches.length, 1);
    assert.deepEqual(result.protective.held, { PROTECTIVE_HOLD_PIPELINE_REFUSED: 1 });
    assert.deepEqual(execution.managementState, {});
  });
  it("14. a throwing seam fails closed with every ordinary hold assertion intact", async () => {
    connectionReadThrows = true;
    await heldProtective("PROTECTIVE_HOLD_INTERNAL_ERROR");
    assert.equal(dispatches.length, 0);
  });
  it("15. two held positions on one bridge share one evidence deadline; the later one says the budget was used", async () => {
    extraExecutions = [{ ...execution, id: 2, brokerTicket: "124" }];
    extraPositions = [{ ...position, id: 2, brokerTicket: "124" }];
    const started = clock;
    const result = await manageAgentPositions(agent, 1, "admin", seams());
    assert.equal(result.held, 2);
    assert.equal(result.heldReasons.MANAGEMENT_OBSERVATION_STALE, 2);
    assert.deepEqual(result.protective.held, {
      PROTECTIVE_HOLD_NO_FRESH_SWEEP: 1,
      PROTECTIVE_HOLD_WAIT_BUDGET_USED: 1,
    });
    assert.equal(clock - started, 20_000);
    assert.equal(sleeps.reduce((a, b) => a + b, 0), 20_000, String(sleeps));
    assert.equal(dispatches.length, 0);
    const texts = auditRows.filter((r) => r.eventType === "PROTECTIVE_ACTION_HELD").map((r) => r.reason!);
    assert.equal(texts.length, 2);
    assert.match(texts[0]!, /within 20s/);
    assert.match(texts[1]!, /already used this cycle/);
    assert.ok(texts.every((t) => !/within 0s/.test(t)), JSON.stringify(texts));
  });
  it("15b. a sweep that arrives during the first position's wait serves every position on the bridge", async () => {
    commandRows = [{ ...entryCommand, commandId: "entry-2", brokerTicket: "124" }];
    extraExecutions = [{ ...execution, id: 2, commandId: "entry-2", brokerTicket: "124" }];
    extraPositions = [{ ...position, id: 2, brokerTicket: "124", sourceCommandId: "entry-2" }];
    onSleep = (poll) => {
      if (poll === 3) {
        sweepLands();
        Object.assign(extraPositions[0]!, {
          lastSyncedAt: position.lastSyncedAt,
          lastReliableSnapshotAt: position.lastReliableSnapshotAt,
          brokerAbsentSnapshotCount: 0,
        });
      }
    };
    const result = await manageAgentPositions(agent, 1, "admin", seams());
    assert.equal(result.protective.acted, 2);
    assert.deepEqual(result.protective.held, {});
    assert.equal(sleeps.length, 3);
    assert.deepEqual(
      dispatches.map((d) => (d as { intent: { selfTradeManagement: { executionId: number } } }).intent.selfTradeManagement.executionId),
      [1, 2],
    );
  });
  it("16. a position already closed at the broker holds as absent at once, without burning the wait", async () => {
    // The sweep stopped listing the ticket: lastSyncedAt froze 91 s ago, each
    // later sweep bumped the absent count and the bridge marker is fresh.
    position.brokerAbsentSnapshotCount = 1;
    position.lastReliableSnapshotAt = new Date(clock - 2_000);
    connectionRow!.lastPositionsSnapshotAt = new Date(clock - 2_000);
    await heldProtective("PROTECTIVE_POSITION_ABSENT_AT_BROKER");
    assert.equal(sleeps.length, 0);
    const held = auditRows.find((r) => r.eventType === "PROTECTIVE_ACTION_HELD")!;
    assert.match(held.reason!, /did not list ticket 123/);
  });
  it("16b. a ticket that goes absent during the wait stops polling at once", async () => {
    onSleep = (poll) => {
      if (poll === 2) position.brokerAbsentSnapshotCount = 1;
    };
    await heldProtective("PROTECTIVE_POSITION_ABSENT_AT_BROKER");
    assert.equal(sleeps.length, 2);
  });
  for (const [label, change, reason] of [
    ["account number", { accountNumber: "other-login" }, "PROTECTIVE_BRIDGE_ACCOUNT_MISMATCH"],
    ["server name cleared", { serverName: "" }, "PROTECTIVE_BRIDGE_ACCOUNT_MISMATCH"],
    ["account type demo", { accountType: "demo" }, "PROTECTIVE_BRIDGE_NOT_LIVE"],
    ["capability withdrawn", { capabilities: {} }, "PROTECTIVE_HOLD_TERMINAL_UPGRADE_REQUIRED"],
    ["token revoked", { tokenRevokedAt: new Date() }, "PROTECTIVE_BRIDGE_REVOKED"],
  ] as const)
    it(`17. bridge identity is re-verified on the final record before the claim: ${label}`, async () => {
      onSleep = (poll) => {
        if (poll === 3) {
          sweepLands();
          Object.assign(connectionRow!, change);
        }
      };
      await heldProtective(reason);
    });
  it("18. a pipeline refusal after the command exists is reported as a hold, and the command is kept", async () => {
    submit = async () => ({ ok: false, error: "CLOSE_ONLY_GATE_BLOCKED", commandId: "cmd-9" });
    onSleep = (poll) => {
      if (poll === 3) sweepLands();
    };
    const result = await run();
    assert.equal(dispatches.length, 1);
    assert.equal(result.protective.acted, 0);
    assert.deepEqual(result.protective.held, { PROTECTIVE_HOLD_REFUSED_WITH_COMMAND: 1 });
    // Not rolled back: the command row exists and reconciliation settles it.
    const memory = execution.managementState as { pendingManagement: { commandId: string } };
    assert.equal(memory.pendingManagement.commandId, "cmd-9");
    assert.ok(auditEvents.includes("MANAGEMENT_REFUSAL_WITH_COMMAND"));
    const held = auditRows.find((r) => r.eventType === "PROTECTIVE_ACTION_HELD")!;
    assert.match(held.reason!, /cmd-9/);
    assert.match(held.reason!, /CLOSE_ONLY_GATE_BLOCKED/);
  });
  it("19. a missing heartbeat is explained as missing, a future one as ahead of the clock", async () => {
    connectionRow!.lastHeartbeat = null;
    await heldProtective("PROTECTIVE_BRIDGE_OFFLINE");
    assert.match(auditRows.at(-1)!.reason!, /no recorded heartbeat \(missing\)/);
    auditRows = [];
    auditEvents = [];
    connectionRow!.lastHeartbeat = new Date(clock + 2_000);
    await heldProtective("PROTECTIVE_BRIDGE_OFFLINE");
    assert.match(auditRows.at(-1)!.reason!, /2s ahead of the server clock/);
    assert.doesNotMatch(auditRows.at(-1)!.reason!, /-2s old/);
  });
  // ── Cycle ordering (F1): ordinary dispatches first, protective waits after ──
  const executionIdOf = (d: unknown) =>
    (d as { intent: { selfTradeManagement: { executionId: number } } }).intent.selfTradeManagement.executionId;
  /** A second FILLED execution of the same agent whose row is fresh and breached. */
  function freshBreachedSecond(agentId = 5) {
    commandRows = [{ ...entryCommand, commandId: "entry-2", brokerTicket: "124", selfTradeAgentId: agentId }];
    extraExecutions = [{ ...execution, id: 2, agentId, commandId: "entry-2", brokerTicket: "124" }];
    const synced = new Date(clock - 1_000);
    extraPositions = [
      { ...position, id: 2, brokerTicket: "124", sourceCommandId: "entry-2", lastSyncedAt: synced, lastReliableSnapshotAt: synced },
    ];
  }
  it("20. a later position's justified exit dispatches before an earlier held position waits", async () => {
    freshBreachedSecond();
    let sleepsAtDispatch = -1;
    submit = async () => {
      sleepsAtDispatch = sleeps.length;
      return { ok: true, commandId: "close-2" };
    };
    const result = await manageAgentPositions(agent, 1, "admin", seams());
    assert.deepEqual(dispatches.map(executionIdOf), [2]);
    assert.equal(sleepsAtDispatch, 0, "the ordinary exit never waited behind the held position");
    assert.equal(result.evaluated, 1);
    assert.equal(result.protective.queued, 1);
    assert.deepEqual(result.protective.held, { PROTECTIVE_HOLD_NO_FRESH_SWEEP: 1 });
    assert.equal(result.protective.waitedMs, 20_000);
  });
  it("21. with a cycle queue the manager never waits; a later agent's exit runs before any protective wait", async () => {
    const agentB = { ...agent, id: 6 } as SelfTradeAgent;
    freshBreachedSecond(6);
    const cycle = createProtectiveCycle();
    const a = await manageAgentPositions(agent, 1, "admin", { ...seams(), protectiveCycle: cycle });
    assert.equal(sleeps.length, 0);
    assert.equal(a.protective.queued, 1);
    assert.equal(a.protective.considered, 0);
    assert.equal(a.held, 1);
    assert.equal(a.heldReasons.MANAGEMENT_OBSERVATION_STALE, 1);
    const b = await manageAgentPositions(agentB, 1, "admin", { ...seams(), protectiveCycle: cycle });
    assert.deepEqual(dispatches.map(executionIdOf), [2]);
    assert.equal(sleeps.length, 0);
    assert.equal(b.evaluated, 1);
    assert.equal(cycle.candidates.length, 1);
    const drained = await drainProtectiveCycle(cycle);
    assert.deepEqual(drained.held, { PROTECTIVE_HOLD_NO_FRESH_SWEEP: 1 });
    assert.equal(drained.bridges, 1);
    assert.equal(drained.elapsedMs, 20_000);
    assert.equal(cycle.candidates.length, 0);
    assert.deepEqual(execution.managementState, {});
  });
  it("22. held positions on two bridges are waited on concurrently: one budget, not one per bridge", async () => {
    // Second agent position on bridge 13 (its own entry, account and row).
    connectionRow!.id = 12;
    extraConnections = [{ ...liveConnection(), id: 13, accountNumber: "acct-13", brokerName: "company-13" }];
    commandRows = [
      { ...entryCommand, commandId: "entry-2", brokerTicket: "124", bridgeConnectionId: 13, accountLogin: "acct-13", brokerServer: "company-13" },
    ];
    extraExecutions = [{ ...execution, id: 2, commandId: "entry-2", brokerTicket: "124" }];
    extraPositions = [
      { ...position, id: 2, brokerTicket: "124", sourceCommandId: "entry-2", bridgeConnectionId: 13, accountLogin: "acct-13", brokerServer: "company-13" },
    ];
    const cycle = createProtectiveCycle();
    await manageAgentPositions(agent, 1, "admin", { ...seams(), protectiveCycle: cycle });
    const started = clock;
    const drained = await drainProtectiveCycle(cycle);
    assert.equal(drained.bridges, 2);
    assert.deepEqual(drained.held, { PROTECTIVE_HOLD_NO_FRESH_SWEEP: 2 });
    assert.equal(drained.waitedMs, 40_000, "each bridge waited its full window");
    assert.equal(clock - started, 20_000, "but the windows overlapped");
    assert.equal(drained.elapsedMs, 20_000);
  });
  it("23. a kill switch engaged after queueing still holds the deferred candidate", async () => {
    const cycle = createProtectiveCycle();
    await manageAgentPositions(agent, 1, "admin", { ...seams(), protectiveCycle: cycle });
    arming = { isArmed: true, killSwitchEngaged: true };
    const drained = await drainProtectiveCycle(cycle);
    assert.deepEqual(drained.held, { PROTECTIVE_HOLD_USER_KILL_SWITCH: 1 });
    assert.equal(sleeps.length, 0);
    assert.equal(dispatches.length, 0);
  });
  it("23b. a platform stop engaged after queueing still holds the deferred candidate", async () => {
    const cycle = createProtectiveCycle();
    await manageAgentPositions(agent, 1, "admin", { ...seams(), protectiveCycle: cycle });
    stopEngaged = true;
    const drained = await drainProtectiveCycle(cycle);
    assert.deepEqual(drained.held, { PROTECTIVE_HOLD_PLATFORM_STOP_ENGAGED: 1 });
    assert.equal(dispatches.length, 0);
  });
  it("24. an empty cycle drains without any read", async () => {
    const drained = await drainProtectiveCycle(createProtectiveCycle());
    assert.deepEqual(drained, { considered: 0, acted: 0, waitedMs: 0, held: {}, bridges: 0, elapsedMs: 0 });
  });
  // ── Final-claim refusals name their own cause; account-scoped ticket commands;
  //    bridge identity re-verified on every poll ──
  it("25. a final-claim refusal for a manual command in flight is held under that reason, naming the manual command", async () => {
    onSleep = (poll) => {
      if (poll === 3) sweepLands();
    };
    submit = async () => {
      // The user's manual modify reaches the terminal between the path's
      // evidence and the server-side claim, which refuses it.
      ticketCommands = [
        { commandId: "manual-late", status: "SENT_TO_MT5_LIVE", sentToMt5At: new Date(clock), filledAt: null, rejectedAt: null },
      ];
      return { ok: false, error: "PROTECTIVE_HOLD_MANUAL_COMMAND_IN_FLIGHT", commandId: "cmd-9" };
    };
    const result = await run();
    assert.equal(dispatches.length, 1);
    assert.equal(result.protective.acted, 0);
    assert.deepEqual(result.protective.held, { PROTECTIVE_HOLD_MANUAL_COMMAND_IN_FLIGHT: 1 });
    const held = auditRows.find((r) => r.eventType === "PROTECTIVE_ACTION_HELD")!;
    assert.match(held.reason!, /manual-late/);
    assert.match(held.reason!, /in flight/);
    assert.match(held.reason!, /cmd-9/, "the refused agent command is still named for reconciliation");
    assert.equal((held.afterState!.detail as Record<string, unknown>).stage, "final-claim");
    // The existing command link is kept, as for any refusal after the row exists.
    assert.equal((execution.managementState as { pendingManagement: { commandId: string } }).pendingManagement.commandId, "cmd-9");
  });
  it("25b. a final-claim refusal for a command after the evidence, before any command row, is held under that reason", async () => {
    onSleep = (poll) => {
      if (poll === 3) sweepLands();
    };
    submit = async () => {
      ticketCommands = [
        { commandId: "manual-after", status: "LIVE_FILLED", sentToMt5At: new Date(clock + 1), filledAt: new Date(clock + 2), rejectedAt: null },
      ];
      return { ok: false, error: "PROTECTIVE_TICKET_COMMAND_AFTER_EVIDENCE" };
    };
    const result = await run();
    assert.deepEqual(result.protective.held, { PROTECTIVE_TICKET_COMMAND_AFTER_EVIDENCE: 1 });
    const held = auditRows.find((r) => r.eventType === "PROTECTIVE_ACTION_HELD")!;
    assert.match(held.reason!, /manual-after/);
    assert.deepEqual(execution.managementState, {});
  });
  it("25c. a non-protective pipeline refusal keeps the generic refusal reason", async () => {
    onSleep = (poll) => {
      if (poll === 3) sweepLands();
    };
    submit = async () => ({ ok: false, error: "MANAGEMENT_TARGET_CHANGED", commandId: "cmd-9" });
    const result = await run();
    assert.deepEqual(result.protective.held, { PROTECTIVE_HOLD_REFUSED_WITH_COMMAND: 1 });
  });
  it("26. a same-numbered ticket's command in flight on another bridge never holds this position", async () => {
    ticketCommands = [
      { commandId: "b-close", status: "SENT_TO_MT5_LIVE", sentToMt5At: new Date(clock - 95_000), filledAt: null, rejectedAt: null, bridgeConnectionId: 13, accountLogin: "acct-13" },
    ];
    onSleep = (poll) => {
      if (poll === 3) sweepLands();
    };
    const result = await run();
    assert.equal(result.protective.acted, 1);
    assert.equal(dispatches.length, 1);
  });
  it("26b. a command in flight with no recorded bridge still holds (attribution unknown, fail closed)", async () => {
    ticketCommands = [
      { commandId: "unplaced-close", status: "SENT_TO_MT5_LIVE", sentToMt5At: new Date(clock - 95_000), filledAt: null, rejectedAt: null, bridgeConnectionId: null, accountLogin: null },
    ];
    await heldProtective("PROTECTIVE_HOLD_MANUAL_COMMAND_IN_FLIGHT");
    assert.equal(sleeps.length, 0);
  });
  it("27. a token revoked during the wait holds as revoked at once, not as no fresh sweep", async () => {
    onSleep = (poll) => {
      if (poll === 2) Object.assign(connectionRow!, { tokenRevokedAt: new Date(clock), status: "revoked" });
    };
    await heldProtective("PROTECTIVE_BRIDGE_REVOKED");
    assert.equal(sleeps.length, 2);
    const held = auditRows.find((r) => r.eventType === "PROTECTIVE_ACTION_HELD")!;
    assert.equal((held.afterState!.detail as Record<string, unknown>).stage, "wait");
  });
  it("the user kill switch and disarmed state hold before any wait", async () => {
    arming = { isArmed: true, killSwitchEngaged: true };
    await heldProtective("PROTECTIVE_HOLD_USER_KILL_SWITCH");
    assert.equal(sleeps.length, 0);
  });
});
