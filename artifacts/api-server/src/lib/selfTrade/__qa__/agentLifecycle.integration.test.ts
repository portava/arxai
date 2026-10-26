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
} = database;
const dialect = new PgDialect();
const stamp = new Date("2026-10-25T23:59:58Z");
let execution: SelfTradeAgentExecution;
let commandRows: ArxLiveCommand[];
let entryCommand: ArxLiveCommand;
let position: Record<string, unknown>;
let competingPosition: Record<string, unknown> | undefined;
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
    then(
      resolve: (rows: unknown[]) => unknown,
      reject: (err: unknown) => unknown,
    ) {
      try {
        const params = dialect.sqlToQuery(predicate).params;
        let rows: unknown[] = [];
        if (table === executions) {
          rows =
            execution.agentId === params[0] && params.includes(execution.status)
              ? [structuredClone(execution)]
              : [];
        } else if (table === decisions)
          rows = [
            {
              id: 7,
              thesis: { stopLoss: 1.09, takeProfits: [], invalidation: null },
            },
          ];
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
            if (execution.id !== params[0] || execution.status !== params[1])
              return [];
            if (sql.includes("management_state")) {
              assert.match(sql, /"management_state" = \$3::jsonb/);
              if (JSON.stringify(execution.managementState) !== params[2])
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
            Object.assign(execution, structuredClone(patch));
            return [{ id: execution.id }];
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
        return [competingPosition, position]
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
    writeSelfTradeAudit: async () => {
      if (auditFails) throw new Error("audit unavailable");
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
const { manageAgentPositions } = await import("../livePositionManager.js");
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
  commandRows = [];
  entryCommand = fullEntry();
  competingPosition = undefined;
  position = {
    userId: 9,
    brokerTicket: "123",
    symbol: "EURUSD",
    bridgeConnectionId: 12,
    accountLogin: "synthetic-demo",
    brokerServer: "synthetic-server",
    entryPrice: 1.1,
    currentPrice: 1.112,
    stopLoss: 1.09,
    closedAt: null,
  };
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
  it("settled close uses broker time and books the outcome only once", async () => {
    execution.managementState = { closeCommandId: "close-1" };
    commandRows = [
      {
        ...settledModify(),
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
    assert.ok(Math.abs((execution.realizedPnl ?? 0) - 100) < 1e-8);
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
