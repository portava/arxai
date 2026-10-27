// Verify the actual instant-management router preserves command identity at
// each failure boundary. Its venue functions are fixtures, never broker calls.
import { beforeEach, it, mock } from "node:test";
import assert from "node:assert/strict";
import { getTableColumns } from "drizzle-orm";
process.env.DATABASE_URL =
  "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");
mock.method(database.pool, "query", () => {
  throw new Error("Unexpected database access");
});
mock.method(database.pool, "connect", () => {
  throw new Error("Unexpected database access");
});
let phase: "draft" | "confirm" | "dispatch" | "accepted";
let dispatchCalls: number;
let draftedInput: Record<string, unknown> | undefined;
const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => [
          { perUserSubmitsPerMinute: 30, liveOneClickEnabled: true },
        ],
      }),
    }),
  }),
  insert: () => ({ values: async () => undefined }),
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });
mock.module("../../positions/ledger.js", {
  namedExports: {
    livePositionColumns: getTableColumns(database.arxLivePositionsTable),
    livePositionLedger: {
      read: async () => [
        {
          userId: 9,
          brokerTicket: "123",
          symbol: "EURUSD",
          side: "BUY",
          volume: 0.1,
          stopLoss: 1.09,
        },
      ],
    },
  },
});
mock.module("../../positions/openPositions.js", {
  namedExports: { selectLiveOpenPositions: async () => [] },
});
mock.module("../../mt5/userMasterLiveAccessGate.js", {
  namedExports: {
    loadAndEvaluateUserMasterLiveAccessGate: async () => ({
      decision: "ALLOWED",
    }),
  },
});
mock.module("../../concurrency/advisoryLock.js", {
  namedExports: {
    ARX_LOCK_NS: {},
    withTxAdvisoryLock: async (
      _ns: number,
      _key: number,
      fn: () => Promise<unknown>,
    ) => ({ acquired: true, value: await fn() }),
  },
});
mock.module("../../concurrency/rateLimit.js", {
  namedExports: {
    tryConsumeToken: () => true,
    checkSymbolCooldown: () => true,
  },
});
mock.module("../../aaci/manualAdvisory.js", {
  namedExports: {
    recordManualAaciAdvisory: () => {
      throw new Error("Unexpected entry path");
    },
  },
});
mock.module("../../security/handshake.js", {
  namedExports: { enforceSensitiveAction: async () => ({ ok: true }) },
});
mock.module("../../mt5/symbolDirectory.js", {
  namedExports: {
    resolveBrokerSymbol: async () => ({ ok: true, brokerSymbol: "EURUSD.a" }),
  },
});
mock.module("../../tradeEngine/pipeline.js", {
  namedExports: {
    draftTrade: async (_ctx: unknown, input: Record<string, unknown>) => {
      draftedInput = input;
      return phase === "draft"
        ? { ok: false, reason: "DRAFT_BLOCKED" }
        : { ok: true, command: { commandId: "ops-1" } };
    },
    confirmTrade: async () =>
      phase === "confirm"
        ? { ok: false, reason: "CONFIRM_BLOCKED" }
        : { ok: true },
    dispatchTrade: async () => {
      dispatchCalls++;
      return phase === "dispatch"
        ? { ok: false, reason: "OUTCOME_UNKNOWN" }
        : { ok: true };
    },
  },
});
// This router-boundary fixture supplies an already verified target. The real
// database reconstruction, ownership and race cases run in the PostgreSQL lane.
const realTarget = await import("../managementTarget.js");
let managedAction: "EXIT" | "TIGHTEN_SL" = "EXIT";
mock.module("../managementTarget.js", { namedExports: { ...realTarget,
  resolveManagementTarget: async () => ({
    position: { userId: 9, brokerTicket: "123", symbol: "EURUSD", side: "BUY", volume: 0.1, stopLoss: 1.09 },
    target: { version: 1, userId: 9, agentId: 4, decisionId: 7, brokerTicket: "123", action: managedAction,
      nextStopLoss: managedAction === "EXIT" ? null : 1.1, currentTakeProfit: null },
  }),
} });
const { executeInstant } = await import("../../live/instantTrade.js");
beforeEach(() => {
  phase = "accepted";
  dispatchCalls = 0;
  draftedInput = undefined;
});

for (const action of ["MODIFY_SL_TP", "CLOSE"] as const) {
  const request = {
    userId: 9,
    intent: {
      source: "self_trade" as const,
      accountMode: "live" as const,
      action,
      positionId: "123",
      selfTradeAgentId: 4, selfTradeDecisionId: 7,
      selfTradeManagement: { executionId: 1, positionRowId: 1, claimId: "fixture" },
      newStopLoss: 1.1,
    },
  };
  it(`${action}: pre-draft refusal has no command; confirm refusal keeps its command`, async () => {
    managedAction = action === "CLOSE" ? "EXIT" : "TIGHTEN_SL";
    phase = "draft";
    const draft = await executeInstant(request);
    assert.equal(draft.ok, false);
    assert.equal(draft.commandId, undefined);
    phase = "confirm";
    const confirm = await executeInstant(request);
    assert.equal(confirm.ok, false);
    assert.equal(confirm.commandId, "ops-1");
    assert.equal(dispatchCalls, 0);
  });
  it(`${action}: ambiguous dispatch retains evidence rather than inviting blind retry`, async () => {
    managedAction = action === "CLOSE" ? "EXIT" : "TIGHTEN_SL";
    phase = "dispatch";
    const result = await executeInstant(request);
    assert.equal(result.ok, false);
    assert.equal(result.commandId, "ops-1");
    assert.equal(dispatchCalls, 1);
  });
  it(`${action}: accepted request keeps the same command identity`, async () => {
    managedAction = action === "CLOSE" ? "EXIT" : "TIGHTEN_SL";
    const result = await executeInstant(request);
    assert.equal(result.ok, true);
    assert.equal(result.commandId, "ops-1");
    assert.equal(dispatchCalls, 1);
  });
}

it("self-trade entry persists exact canonical/broker mapping before preparation", async () => {
  const result = await executeInstant({
    userId: 9,
    intent: {
      source: "self_trade",
      accountMode: "live",
      action: "BUY",
      symbol: "EURUSD",
      volume: 0.1,
      stopLoss: 1.09,
      prepareOnly: true,
      selfTradeAgentId: 5,
      selfTradeDecisionId: 7,
    },
  });
  assert.equal(result.ok, true);
  assert.equal(draftedInput?.symbol, "EURUSD.a");
  assert.equal(draftedInput?.requestedVolume, 0.1);
  assert.deepEqual(draftedInput?.payload, {
    selfTradeSymbolBinding: {
      requestedSymbol: "EURUSD",
      brokerSymbol: "EURUSD.a",
    },
  });
  assert.equal(dispatchCalls, 0);
});

it("entry confirmation/dispatch refusal retains its persisted command identity", async () => {
  for (const boundary of ["confirm", "dispatch"] as const) {
    phase = boundary;
    const result = await executeInstant({
      userId: 9,
      intent: {
        source: "self_trade",
        accountMode: "live",
        action: "BUY",
        symbol: "EURUSD",
        volume: 0.1,
        stopLoss: 1.09,
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.commandId, "ops-1");
  }
});
