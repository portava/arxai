// Child process for cycleCoordination.postgres.test.ts: one API process that
// serves POST /self-trade-ai/run-autonomous-cycle through the real router, the
// real cycle coordinator and the real runAutonomousCycle, against the
// disposable cluster the runner created. Started with child_process.fork; the
// parent drives it over IPC.
//
// Real: route, single flight, cross-process lock, bounded DB waits, the cycle
// orchestration, the agent executor and entry reservation, entry authority
// (draft, confirm and final dispatch claims), master exposure reservation,
// reconciliation, the live position manager, Position Guardian and
// executeInstant for management, createLiveOpsDraft, audits.
// Stand-ins: decision generation (returns a seeded cycle), risk/anomaly/AACI
// advisories (permit), arming and access gates (allowed), and the last hop of
// dispatch, which runs the production claim helpers in the production order
// (reserve exposure, final claim, mailbox mirror) with pause points between
// them. No broker, terminal, bridge or network endpoint exists here.
//
// IPC: the child sends {type:"ready", port}, {type:"point", name} at every
// pause point and {type:"paused", name} when it stops at one listed in
// ARX_QA_PAUSE_AT; the parent answers {type:"resume", name} or kills it.
import { mock } from "node:test";
import { eq } from "drizzle-orm";
import type { AddressInfo } from "node:net";

const destination = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
if (process.env.ARX_CYCLE_COORDINATION_PG !== "1" || destination.pathname !== "/arx_cycle_coordination_test")
  throw new Error("cycle coordination child runs only against the disposable runner database");

const database = await import("@workspace/db");
const {
  db,
  arxLiveCommandsTable: commands,
  mt5CommandsTable: mailbox,
  selfTradeAgentExecutionsTable: executions,
} = database;
process.env.SESSION_SECRET = "synthetic-offline-cycle-coordination-material";

mock.method(globalThis, "fetch", async () => {
  throw new Error("Unexpected external request");
});

const pauseAt = new Set((process.env.ARX_QA_PAUSE_AT ?? "").split(",").filter(Boolean));
async function pausePoint(name: string): Promise<void> {
  process.send?.({ type: "point", name });
  if (!pauseAt.has(name)) return;
  pauseAt.delete(name); // once per process
  await new Promise<void>((resolve) => {
    const onMessage = (m: { type?: string; name?: string }) => {
      if (m?.type === "resume" && m.name === name) {
        process.off("message", onMessage);
        resolve();
      }
    };
    process.on("message", onMessage);
    process.send?.({ type: "paused", name });
  });
}

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
mock.module("../../missionExitManager.js", {
  namedExports: { recordMissionTradeCloseByBrokerTicket: async () => undefined },
});
const realArming = await import("../../live/liveArming.js");
mock.module("../../live/liveArming.js", {
  namedExports: {
    ...realArming,
    getMyArming: async () => ({ isArmed: true, killSwitchEngaged: false, accountNumberConfirmed: "A" }),
  },
});
const realAccess = await import("../../mt5/userMasterLiveAccessGate.js");
mock.module("../../mt5/userMasterLiveAccessGate.js", {
  namedExports: {
    ...realAccess,
    loadAndEvaluateUserMasterLiveAccessGate: async () => ({ decision: "ALLOWED" }),
  },
});
mock.module("../../concurrency/rateLimit.js", {
  namedExports: { tryConsumeToken: () => true, checkSymbolCooldown: () => true },
});
mock.module("../executionGate.js", {
  namedExports: {
    evaluateAgentExecution: async (request: { decision: { thesis: unknown } }) => ({
      verdict: { permitted: true, action: "EXECUTE" },
      thesis: request.decision.thesis,
      executingUserId: 9,
      sizeMultiplier: 1,
    }),
  },
});
mock.module("../killSwitchGate.js", {
  namedExports: { assertAgentNotKilled: async () => ({ killed: false }) },
});
const realRouter = await import("../../data/marketDataRouter.js");
mock.module("../../data/marketDataRouter.js", {
  namedExports: {
    ...realRouter,
    classifySymbol: () => "FOREX",
    routeCandlesForDecision: async () => {
      throw new Error("No decision feed in test");
    },
    routeCandles: async () => {
      throw new Error("No candle access in test");
    },
    routeQuote: async () => {
      throw new Error("No market-data access in test");
    },
  },
});
const realContract = await import("../../mt5/contractSize.js");
mock.module("../../mt5/contractSize.js", {
  namedExports: {
    ...realContract,
    resolveContractSize: async () => ({ contractSize: 100000, profitCurrency: "USD" }),
    resolveQuoteToAccountFx: () => ({ factor: 1 }),
  },
});
mock.module("../../live/accountCurrency.js", {
  namedExports: { getAccountCurrency: async () => "USD" },
});
mock.module("../../aaci/executionAdvisory.js", {
  namedExports: {
    evaluateAaciExecutionAdvisory: async () => ({
      advisory: { proceed: true, downgradeToPrepareOnly: false, sizeMultiplier: 1 },
    }),
  },
});
mock.module("../decisionEngine.js", {
  namedExports: {
    runDecisionCycle: async () => {
      await pausePoint("cycle:decisions");
      return { cycleId: process.env.ARX_QA_CYCLE_ID ?? "qa-cycle" };
    },
    buildFleetSafetyContext: async () => ({
      governor: { status: "ALLOW", hardBlocks: [] },
      handshake: { ready: true, degraded: [], blocked: [] },
    }),
  },
});
// Pool exhaustion seam: inside the cycle's DB scope, take N connections and
// hand them back only after the configured delay, so the next real query in
// the cycle has to wait for a connection.
let heldOnce = false;
mock.module("../../aaci/reconciliationAudit.js", {
  namedExports: {
    reconcileAaciChain: async () => {
      const hold = Number(process.env.ARX_QA_HOLD_CONNECTIONS ?? 0);
      if (hold > 0 && !heldOnce) {
        heldOnce = true;
        const clients = await Promise.all(Array.from({ length: hold }, () => database.pool.connect()));
        process.send?.({ type: "point", name: "aaci:connections-held" });
        setTimeout(() => {
          for (const c of clients) c.release();
          process.send?.({ type: "point", name: "aaci:connections-released" });
        }, Number(process.env.ARX_QA_HOLD_MS ?? 1500));
      }
      return { shouldPauseManagement: false };
    },
  },
});
mock.module("../../aaci/learning/outcomeIngestion.js", {
  namedExports: { ingestAgentOutcomes: async () => ({ touchedEntities: [] }) },
});
mock.module("../../aaci/learning/driftService.js", {
  namedExports: { evaluateEntityDrift: async () => undefined },
});
mock.module("../../security/operationalMode.js", {
  namedExports: {
    getOperationalMode: async () => ({ mode: "NORMAL", posture: { pauseAutonomousEntries: false, reason: null } }),
  },
});
mock.module("../../security/anomalyService.js", {
  namedExports: {
    evaluateTradeAnomalyForUser: async () => ({
      verdict: { recommendedAction: "ALLOW", reasonCode: "OK", anomalies: [], adminMessage: "" },
    }),
  },
});


/** Production order of the last dispatch hop, with a pause point between each step. */
async function handOff(commandId: string, kind: "entry" | "manage"): Promise<boolean> {
  const [row] = await db.select().from(commands).where(eq(commands.commandId, commandId));
  if (kind === "entry") {
    const reserved = await reserveExposureAtomic({
      sharedMasterAccountId: 1,
      addingLot: row!.requestedVolume,
      userId: row!.userId,
      commandId,
      symbol: row!.symbol,
    });
    if (!reserved.ok) return false;
  }
  await pausePoint(`${kind}:before-claim`);
  const claimed = await claimLiveCommandForDispatch(
    commandId,
    {
      status: "SENT_TO_MT5_LIVE",
      sentToMt5At: new Date(),
      expiresAt: new Date(Date.now() + 120_000),
      ...(kind === "manage"
        ? { bridgeConnectionId: row!.bridgeConnectionId, accountLogin: row!.accountLogin, brokerServer: row!.brokerServer }
        : {}),
    },
    row,
  );
  if (!claimed) return false;
  await pausePoint(`${kind}:after-claim`);
  await db.insert(mailbox).values({
    userId: row!.userId,
    mt5ConnectionId: 1,
    requestedByUserId: row!.userId,
    action: kind === "entry" ? "OPEN_MARKET" : "MODIFY_SLTP",
    symbol: row!.symbol,
    side: row!.side,
    lot: row!.requestedVolume,
    status: "PENDING",
    payload: {
      bridged: "LIVE_PHASE_B",
      liveCommandId: commandId,
      liveCommandOwnerUserId: row!.userId,
      liveCommandType: row!.commandType,
      confirmedByUser: true,
    },
  });
  await pausePoint(`${kind}:after-mirror`);
  return true;
}

/** Entry leg of submitInstantTrade: real authority draft + confirm, then handOff. */
async function submitEntry(args: { userId: number; intent: Record<string, any> }) {
  const [execution] = await db
    .select()
    .from(executions)
    .where(eq(executions.id, args.intent.selfTradeExecutionId));
  const request = {
    userId: args.userId,
    agentId: args.intent.selfTradeAgentId,
    decisionId: args.intent.selfTradeDecisionId,
    executionId: execution!.id,
    symbol: "EURUSD",
    side: args.intent.action,
    volume: args.intent.volume,
    stopLoss: args.intent.stopLoss,
    takeProfit: args.intent.takeProfit,
    symbolBinding: { requestedSymbol: "EURUSD", brokerSymbol: "EURUSD" },
  };
  const row = await createAgentEntryDraft(request, async (tx, envelope) =>
    (
      await tx
        .insert(commands)
        .values({
          commandId: `qa-entry-${crypto.randomUUID()}`,
          userId: args.userId,
          commandType: "PLACE_LIVE_MARKET_ORDER",
          status: "LIVE_CONFIRMATION_REQUIRED",
          symbol: request.symbol,
          side: request.side,
          orderType: request.side === "SELL" ? "MARKET_SELL" : "MARKET_BUY",
          requestedVolume: request.volume,
          stopLoss: request.stopLoss,
          takeProfit: request.takeProfit,
          sourcePage: "INSTANT_SELF_TRADE",
          actorId: args.userId,
          actorType: "SELF_TRADE_AGENT",
          selfTradeAgentId: request.agentId,
          selfTradeDecisionId: request.decisionId,
          payload: {
            agentAdmissionV1: envelope,
            selfTradeSymbolBinding: request.symbolBinding,
            agentOwnership: {
              selfTradeAgentId: request.agentId,
              selfTradeDecisionId: request.decisionId,
              selfTradeAgentKey: args.intent.selfTradeAgentKey,
            },
          },
        })
        .returning()
    )[0]!,
  );
  // A refusal after the draft exists returns its command id, as the pipeline does.
  try {
    const approved = await claimLiveCommandForConfirm(row.commandId, { status: "LIVE_APPROVED", confirmedAt: new Date() }, row);
    if (!approved) return { ok: false, error: "CONFIRM_REFUSED", commandId: row.commandId };
    const sent = await handOff(row.commandId, "entry");
    return sent ? { ok: true, commandId: row.commandId } : { ok: false, error: "DISPATCH_REFUSED", commandId: row.commandId };
  } catch (err) {
    let code: unknown;
    for (let e: any = err; e && code == null; e = e.cause) code = e.code;
    process.send?.({ type: "point", name: `entry:error:${String(code ?? "none")}` });
    return { ok: false, error: "DISPATCH_FAILED", commandId: row.commandId };
  }
}

// Mocked before anything that imports the pipeline is loaded; the helpers it
// calls are bound below.
let executeInstant: (typeof import("../../live/instantTrade.js"))["executeInstant"];
mock.module("../../tradeEngine/pipeline.js", {
  namedExports: {
    submitInstantTrade: async (args: { userId: number; intent: Record<string, any> }) =>
      args.intent.selfTradeExecutionId != null
        ? submitEntry(args)
        : executeInstant(args as Parameters<typeof executeInstant>[0]),
    draftTrade: async (_mode: unknown, input: Parameters<typeof createLiveOpsDraft>[0]) => createLiveOpsDraft(input),
    confirmTrade: async (_mode: unknown, input: { commandId: string }) => ({
      ok: !!(await claimLiveCommandForConfirm(input.commandId, { status: "LIVE_APPROVED" })),
    }),
    dispatchTrade: async (_mode: unknown, input: { commandId: string }) => ({
      ok: await handOff(input.commandId, "manage"),
    }),
  },
});
const { createAgentEntryDraft } = await import("../entryAuthority.js");
const { claimLiveCommandForConfirm, claimLiveCommandForDispatch } = await import("../../live/liveCommandCas.js");
const { reserveExposureAtomic } = await import("../../concurrency/exposureReservation.js");
const { createLiveOpsDraft } = await import("../../live/liveCommandPipeline.js");
({ executeInstant } = await import("../../live/instantTrade.js"));

const express = (await import("express")).default;
const router = (await import("../../../routes/selfTradeAi.js")).default;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { authUser: unknown }).authUser = { id: 7, role: "ADMIN" };
  const at = (level: string) => (fields: unknown, msg: string) =>
    process.send?.({ type: "log", level, msg, fields: JSON.parse(JSON.stringify(fields ?? {}, (_k, v) => (v instanceof Error ? v.message : v))) });
  (req as unknown as { log: unknown }).log = { warn: at("warn"), error: at("error"), info: at("info") };
  next();
});
app.use(router);
app.use((e: unknown, _req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, _next: unknown) => {
  process.send?.({ type: "log", level: "error", msg: "unhandled route error", fields: { error: String(e) } });
  res.status(500).json({ ok: false, error: "INTERNAL" });
});
const server = app.listen(0, "127.0.0.1", () => {
  process.send?.({ type: "ready", port: (server.address() as AddressInfo).port });
});
process.on("message", (m: { type?: string }) => {
  if (m?.type === "exit") server.close(() => process.exit(0));
});
process.on("disconnect", () => process.exit(0));
