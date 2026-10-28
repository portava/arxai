// One autonomous cycle, orchestration accounting only: every step the cycle
// sequences is a module mock, so no database, broker, bridge or clock is used.
// Pins (1) that a protective dispatch ("acted": handed to the EA through the
// gated pipeline) is never counted as a modified or closed position, and
// (2) the response shape the admin surface reads (holds with plain-English
// text, protective tallies and the wait budget). A network/database call is a
// test failure.
import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");
mock.method(database.pool, "query", () => {
  throw new Error("Unexpected database access");
});
mock.method(database.pool, "connect", () => {
  throw new Error("Unexpected database access");
});

type Rows = Record<string, unknown>[];
const tableRows = new Map<unknown, Rows>();
let activeAgentIds: number[] = [];
const query = (table: unknown) => ({
  where: async () => tableRows.get(table) ?? [],
});
const fakeDb = {
  select: () => ({ from: query }),
  selectDistinct: () => ({
    from: () => ({ where: async () => activeAgentIds.map((agentId) => ({ agentId })) }),
  }),
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });

let managed: { modified: number; closed: number; heldReasons: Record<string, number> };
let reconciled: { filled: number; rejected: number; closed: number; expired: number };
let drained: {
  considered: number;
  acted: number;
  waitedMs: number;
  held: Record<string, number>;
  bridges: number;
  elapsedMs: number;
};
let pauseManagement = false;
let drainThrows = false;
let executeImpl: () => Promise<unknown> = async () => {
  throw new Error("no decision is executed in this suite");
};
let reconcileImpl: () => Promise<unknown> = async () => reconciled;
let manageCalls = 0;
const audits: string[] = [];
const drainQueueSizes: number[] = [];

mock.module("../decisionEngine.js", {
  namedExports: {
    runDecisionCycle: async () => ({ cycleId: "cycle-qa-1" }),
    buildFleetSafetyContext: async () => ({}),
  },
});
mock.module("../agentExecutor.js", {
  namedExports: {
    executeAgentDecision: () => executeImpl(),
    reconcileAgentExecutions: () => reconcileImpl(),
  },
});
mock.module("../livePositionManager.js", {
  namedExports: {
    manageAgentPositions: async (
      _agent: unknown,
      _actor: unknown,
      _role: unknown,
      options: { protectiveCycle?: { candidates: unknown[] } },
    ) => {
      // The manager only queues; the cycle drains once (step 5).
      manageCalls++;
      options.protectiveCycle?.candidates.push({ queued: true });
      return { ...managed, evaluated: 0, alerted: 0, held: 1, protective: { queued: 1, considered: 0, waitedMs: 0, acted: 0, held: {} } };
    },
  },
});
mock.module("../protectiveActionPath.js", {
  namedExports: {
    PROTECTIVE_EVIDENCE_WAIT_MS: 20_000,
    createProtectiveCycle: () => ({ candidates: [] }),
    drainProtectiveCycle: async (cycle: { candidates: unknown[] }) => {
      drainQueueSizes.push(cycle.candidates.length);
      if (drainThrows) {
        cycle.candidates.splice(0);
        throw new Error("drain setup failed");
      }
      return drained;
    },
  },
});
mock.module("../agentLedger.js", { namedExports: { applyRealizedFromFills: async () => ({ posted: 0 }) } });
mock.module("../agentQuotaEngine.js", { namedExports: { countAgentFilledTradesToday: async () => 0 } });
mock.module("../audit.js", {
  namedExports: {
    writeSelfTradeAudit: async (_db: unknown, row: { eventType: string }) => {
      audits.push(row.eventType);
    },
  },
});
mock.module("../service.js", { namedExports: { listAgents: async () => [] } });
mock.module("../../aaci/reconciliationAudit.js", {
  namedExports: { reconcileAaciChain: async () => ({ shouldPauseManagement: pauseManagement }) },
});
mock.module("../../aaci/learning/outcomeIngestion.js", {
  namedExports: { ingestAgentOutcomes: async () => ({ touchedEntities: [] }) },
});
mock.module("../../aaci/learning/driftService.js", { namedExports: { evaluateEntityDrift: async () => undefined } });
mock.module("../../security/operationalMode.js", {
  namedExports: { getOperationalMode: async () => ({ mode: "NORMAL", posture: { pauseAutonomousEntries: false, reason: null } }) },
});
mock.module("../../security/anomalyService.js", { namedExports: { evaluateTradeAnomalyForUser: async () => ({}) } });

const { runAutonomousCycle } = await import("../autonomousCycle.js");
const { buildRunCycleResponse, createCycleSingleFlight } = await import("../cycleReport.js");

const run = (guard?: Parameters<typeof runAutonomousCycle>[0]["guard"]) =>
  runAutonomousCycle({ actorUserId: 1, actorRole: "admin", reason: "qa protective accounting", guard });
const COMPLETED = {
  status: "COMPLETED" as const,
  stopReason: null,
  decisionsFailed: 0,
  decisionsNotStarted: 0,
  agentsFailed: 0,
  agentsNotStarted: 0,
  managementStepFailed: false,
  protectiveNotRun: 0,
  dbWaitTimeouts: 0,
};

beforeEach(() => {
  audits.length = 0;
  drainQueueSizes.length = 0;
  pauseManagement = false;
  drainThrows = false;
  manageCalls = 0;
  executeImpl = async () => {
    throw new Error("no decision is executed in this suite");
  };
  reconcileImpl = async () => reconciled;
  activeAgentIds = [5];
  tableRows.clear();
  tableRows.set(database.selfTradeAgentsTable, [{ id: 5, agentKey: "alpha", ownerType: "OPERATOR_FLEET", ownerId: null }]);
  managed = { modified: 0, closed: 0, heldReasons: { MANAGEMENT_OBSERVATION_STALE: 3 } };
  reconciled = { filled: 0, rejected: 0, closed: 0, expired: 0 };
  drained = {
    considered: 3,
    acted: 2,
    waitedMs: 26_000,
    held: { PROTECTIVE_HOLD_NO_FRESH_SWEEP: 1 },
    bridges: 1,
    elapsedMs: 20_000,
  };
});

describe("autonomous cycle: protective dispatch accounting", () => {
  it("a protective dispatch is never counted as a modified or closed position", async () => {
    const result = await run();
    assert.equal(result.protective.acted, 2);
    assert.equal(result.protective.considered, 3);
    assert.equal(result.positionsClosed, 0, "sent to the EA is not closed at the broker");
    assert.equal(result.positionsModified, 0, "sent to the EA is not a confirmed stop move");
    assert.equal(result.reconciled.closed, 0);
    assert.deepEqual(result.managementHeld, { MANAGEMENT_OBSERVATION_STALE: 3, PROTECTIVE_HOLD_NO_FRESH_SWEEP: 1 });
    assert.deepEqual(drainQueueSizes, [1], "one drain, of the cycle the manager queued into");
    assert.equal(audits[0], "AUTONOMOUS_CYCLE_RUN", "invocation audited first");
  });

  it("only reconciled broker closes (and confirmed manager outcomes) count as closed/modified", async () => {
    reconciled = { filled: 0, rejected: 0, closed: 1, expired: 0 };
    managed = { modified: 1, closed: 0, heldReasons: {} };
    const result = await run();
    assert.equal(result.positionsClosed, 1);
    assert.equal(result.positionsModified, 1);
    assert.equal(result.protective.acted, 2, "independent of the protective tally");
  });

  it("an AACI pause skips the manager and queues nothing for the drain", async () => {
    pauseManagement = true;
    drained = { considered: 0, acted: 0, waitedMs: 0, held: {}, bridges: 0, elapsedMs: 0 };
    const result = await run();
    assert.deepEqual(drainQueueSizes, [0]);
    assert.deepEqual(result.managementHeld, { MANAGEMENT_PAUSED_AACI_REVIEW: 1 });
    assert.equal(result.protective.acted, 0);
  });
});

describe("autonomous cycle: protective drain failure is reported, not silent", () => {
  it("a drain that throws records PROTECTIVE_DRAIN_FAILED per queued candidate and claims no dispatch", async () => {
    drainThrows = true;
    const result = await run();
    assert.deepEqual(drainQueueSizes, [1]);
    assert.equal(result.protective.considered, 1, "the queued candidate is accounted for");
    assert.equal(result.protective.acted, 0);
    assert.equal(result.managementHeld.PROTECTIVE_DRAIN_FAILED, 1);
    assert.equal(result.completion.status, "INCOMPLETE", "a failed drain is not a completed cycle");
    assert.equal(result.positionsClosed, 0);
    assert.equal(result.positionsModified, 0);
    const body = buildRunCycleResponse(result);
    assert.equal(body.protective.held, 0, "an unknown outcome is not a hold");
    assert.equal(body.protective.commandRecordedOrUnknown, 1);
    const d = body.managementHeldDetails.find((x) => x.reason === "PROTECTIVE_DRAIN_FAILED");
    assert.ok(d, "the failure is listed with its text");
    assert.equal(d.kind, "PROTECTIVE");
    assert.doesNotMatch(d.text, /nothing was sent/i);
    assert.match(d.text, /execution feed/i);
  });
});

describe("run-autonomous-cycle response shape", () => {
  it("keeps every existing field and adds holds with text, protective tallies and the wait budget", async () => {
    const body = buildRunCycleResponse(await run());
    for (const k of [
      "ok", "cycleId", "decisionsConsidered", "executed", "agentsManaged",
      "positionsModified", "positionsClosed", "reconciled", "realizedPosted",
    ])
      assert.ok(k in body, `existing field ${k} kept`);
    assert.equal(body.ok, true);
    assert.equal(body.cycleId, "cycle-qa-1");
    assert.deepEqual(body.protective, {
      considered: 3,
      acted: 2,
      held: 1,
      commandRecordedOrUnknown: 0,
      bridges: 1,
      elapsedMs: 20_000,
      waitBudgetMs: 20_000,
    });
    assert.deepEqual(body.managementHeld, { MANAGEMENT_OBSERVATION_STALE: 3, PROTECTIVE_HOLD_NO_FRESH_SWEEP: 1 });
    assert.deepEqual(
      body.managementHeldDetails.map((d) => [d.reason, d.count, d.kind]),
      [
        ["PROTECTIVE_HOLD_NO_FRESH_SWEEP", 1, "PROTECTIVE"],
        ["MANAGEMENT_OBSERVATION_STALE", 3, "OBSERVATION"],
      ],
      "protective holds first, then by count",
    );
    const timeout = body.managementHeldDetails[0]!.text;
    assert.match(timeout, /timed out/i);
    assert.match(timeout, /20 s/);
    for (const d of body.managementHeldDetails) {
      assert.doesNotMatch(d.text, /\{[a-zA-Z]+\}|unknown/);
      assert.doesNotMatch(d.text, /\bcompleted\b/i);
    }
  });

  it("classifies the AACI pause and unknown reasons and never leaks detail", () => {
    const body = buildRunCycleResponse({
      cycleId: "c",
      decisionsConsidered: 0,
      executed: { DISPATCHED: 0, PREPARED: 0, BLOCKED: 0, LOG_ONLY: 0, SKIPPED_DUPLICATE: 0, AACI_DEFERRED: 0 },
      agentsManaged: 1,
      positionsModified: 0,
      positionsClosed: 0,
      reconciled: { filled: 0, rejected: 0, closed: 0, expired: 0 },
      realizedPosted: 0,
      managementHeld: { MANAGEMENT_PAUSED_AACI_REVIEW: 1, SOMETHING_NEW: 2 },
      protective: { considered: 0, acted: 0, bridges: 0, elapsedMs: 0 },
      completion: COMPLETED,
    });
    assert.deepEqual(
      body.managementHeldDetails.map((d) => [d.reason, d.kind]),
      [["MANAGEMENT_PAUSED_AACI_REVIEW", "PAUSE"], ["SOMETHING_NEW", "OTHER"]],
    );
    assert.equal(body.protective.held, 0);
    assert.match(body.managementHeldDetails[1]!.text, /SOMETHING_NEW/);
    assert.ok(Object.keys(body.managementHeldDetails[0]!).sort().join() === "count,kind,reason,text");
  });
});

describe("run-autonomous-cycle: outcome-unknown holds are split from plain holds", () => {
  it("OUTCOME_UNCERTAIN and REFUSED_WITH_COMMAND count as command recorded / outcome unknown, not held", () => {
    const body = buildRunCycleResponse({
      cycleId: "c",
      decisionsConsidered: 0,
      executed: { DISPATCHED: 0, PREPARED: 0, BLOCKED: 0, LOG_ONLY: 0, SKIPPED_DUPLICATE: 0, AACI_DEFERRED: 0 },
      agentsManaged: 1,
      positionsModified: 0,
      positionsClosed: 0,
      reconciled: { filled: 0, rejected: 0, closed: 0, expired: 0 },
      realizedPosted: 0,
      managementHeld: {
        PROTECTIVE_HOLD_OUTCOME_UNCERTAIN: 1,
        PROTECTIVE_HOLD_REFUSED_WITH_COMMAND: 1,
        PROTECTIVE_HOLD_NO_FRESH_SWEEP: 2,
        MANAGEMENT_OBSERVATION_STALE: 5,
      },
      protective: { considered: 5, acted: 1, bridges: 1, elapsedMs: 20_400 },
      completion: COMPLETED,
    });
    assert.equal(body.protective.commandRecordedOrUnknown, 2);
    assert.equal(body.protective.held, 2, "considered 5 = sent 1 + recorded/unknown 2 + held 2");
  });
});

describe("run-autonomous-cycle: single flight per process", () => {
  it("refuses a second cycle while one is running, and frees the slot when it settles or throws", async () => {
    let t = 1_000;
    const flight = createCycleSingleFlight(() => t);
    let release!: () => void;
    const first = flight.run(() => new Promise<string>((r) => { release = () => r("first"); }));
    t = 6_000;
    const second = await flight.run(async () => "second");
    assert.deepEqual(second, { ran: false, startedAt: 1_000 });
    assert.equal(flight.inFlightSince(), 1_000);
    release();
    assert.deepEqual(await first, { ran: true, value: "first" });
    assert.equal(flight.inFlightSince(), null);
    await assert.rejects(flight.run(async () => { throw new Error("boom"); }), /boom/);
    assert.equal(flight.inFlightSince(), null, "a throw frees the slot");
    assert.deepEqual(await flight.run(async () => 3), { ran: true, value: 3 });
  });
});

describe("autonomous cycle: completion is never claimed after a failure, a bounded wait or a lost lock", () => {
  const decisionRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: 100 + i, agentId: 5, symbol: "EURUSD", cycleId: "cycle-qa-1" }));
  const withDecisions = (n: number) => {
    tableRows.set(database.selfTradeDecisionsTable, decisionRows(n));
    tableRows.set(database.selfTradeAgentSettingsTable, [{ agentId: 5, maxLotPerTrade: 1, dailyMinTrades: 0 }]);
  };
  const timeoutError = () => Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
  const guardFrom = (answers: boolean[], dbWaitTimeouts = 0) => {
    let calls = 0;
    return {
      calls: () => calls,
      stillHeld: async () => answers[Math.min(calls++, answers.length - 1)]!,
      stats: () => ({ dbWaitTimeouts, leaseLost: null }),
    };
  };

  it("an ordinary cycle reports COMPLETED", async () => {
    const result = await run();
    assert.deepEqual(result.completion, COMPLETED);
    assert.equal(buildRunCycleResponse(result).completion.status, "COMPLETED");
  });

  it("an executor that throws (outcome not proven) makes the cycle INCOMPLETE; a lock timeout is counted", async () => {
    withDecisions(2);
    let n = 0;
    executeImpl = async () => {
      n++;
      if (n === 1) throw timeoutError();
      return { status: "DISPATCHED", action: "BUY" };
    };
    const result = await run();
    assert.equal(result.executed.DISPATCHED, 1, "the other decision still ran");
    assert.equal(result.completion.decisionsFailed, 1);
    assert.equal(result.completion.dbWaitTimeouts, 1);
    assert.equal(result.completion.status, "INCOMPLETE");
  });

  it("a manage/reconcile step that throws is counted per agent", async () => {
    reconcileImpl = async () => {
      throw new Error("timeout exceeded when trying to connect");
    };
    const result = await run();
    assert.equal(result.completion.agentsFailed, 1);
    assert.equal(result.completion.dbWaitTimeouts, 1, "connection-acquisition timeout counted");
    assert.equal(result.completion.status, "INCOMPLETE");
  });

  it("a timeout absorbed below the cycle (counted by the guard) still makes it INCOMPLETE", async () => {
    const result = await run(guardFrom([true], 2));
    assert.equal(result.completion.dbWaitTimeouts, 2);
    assert.equal(result.completion.status, "INCOMPLETE");
  });

  it("a lock lost before the first decision stops everything after it: nothing executed, managed or drained", async () => {
    withDecisions(3);
    let executed = 0;
    executeImpl = async () => {
      executed++;
      return { status: "DISPATCHED", action: "BUY" };
    };
    const guard = guardFrom([false]);
    const result = await run(guard);
    assert.equal(executed, 0);
    assert.equal(manageCalls, 0);
    assert.deepEqual(drainQueueSizes, [], "no drain");
    assert.equal(result.agentsManaged, 0);
    assert.equal(result.completion.status, "STOPPED");
    assert.equal(result.completion.stopReason, "LEASE_LOST");
    assert.equal(result.completion.decisionsNotStarted, 3);
    assert.equal(guard.calls(), 1, "no further checks once stopped");
  });

  it("a lock lost between decisions stops at the next one and skips management and the drain", async () => {
    withDecisions(3);
    let executed = 0;
    executeImpl = async () => {
      executed++;
      return { status: "DISPATCHED", action: "BUY" };
    };
    const result = await run(guardFrom([true, false]));
    assert.equal(executed, 1);
    assert.equal(result.completion.decisionsNotStarted, 2);
    assert.equal(manageCalls, 0);
    assert.deepEqual(drainQueueSizes, []);
    assert.equal(result.completion.status, "STOPPED");
  });

  it("a lock lost after management leaves queued protective candidates undrained (nothing claimed)", async () => {
    // Checks: agent 5 (held), then the drain (lost).
    const result = await run(guardFrom([true, false]));
    assert.equal(manageCalls, 1);
    assert.deepEqual(drainQueueSizes, [], "drain not run");
    assert.equal(result.completion.protectiveNotRun, 1);
    assert.equal(result.protective.acted, 0);
    assert.equal(result.completion.status, "STOPPED");
  });
});
