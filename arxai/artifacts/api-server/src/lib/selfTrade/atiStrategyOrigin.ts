import { createHash } from "node:crypto";
import { z } from "zod/v4";
import type { DecisionCandidateInput } from "@workspace/domain/self-trade";
import { getBuildIdentity } from "../startup/buildIdentity.js";
import { entrySymbolMatches, entrySnapshotHash } from "./entryAuthority.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function atiDecisionSettingsHash(input: DecisionCandidateInput) {
  return input.quota ? hash([input.agentKey, input.agentRankWeight, input.maxSpreadPoints,
    input.quota.dailyMinTrades, input.quota.effectiveMaxTrades]) : null;
}

const fleetEngine = "SELF_TRADE_FLEET_DECISION" as const;
export function atiFleetDecisionVersion(input: DecisionCandidateInput) {
  return { engine: fleetEngine, build: getBuildIdentity(), decisionSettingsHash: atiDecisionSettingsHash(input) };
}

const id = z.number().int().positive();
const admission = z.object({ version: z.literal(1), executionId: id, snapshotHash: z.hash("sha256") });
const payload = z.object({ agentAdmissionV1: admission,
  agentOwnership: z.object({ selfTradeAgentId: id, selfTradeDecisionId: id }), selfTradeSymbolBinding: z.unknown().optional() });
const cleanFleetVersion = z.object({
  engine: z.literal(fleetEngine),
  build: z.object({ revision: z.string().regex(/^[0-9a-f]{40}$/), sourceState: z.literal("clean") }),
  decisionSettingsHash: z.hash("sha256"),
});
const snapshot = z.object({
  version: z.literal(1),
  agent: z.object({ id, agentKey: z.string().min(1), ownerType: z.literal("USER"), ownerId: id }),
  settings: z.object({ agentId: id }), ledger: z.object({ agentId: id }),
  decision: z.object({ id, agentId: id, agentKey: z.string().min(1), symbol: z.string().min(1), timeframe: z.literal("M5"),
    side: z.enum(["BUY","SELL"]), outcome: z.enum(["APPROVED","APPROVED_REDUCED"]),
    setupType: z.enum(["TREND_CONTINUATION","BREAKOUT_RETEST","REVERSAL","LIQUIDITY_SWEEP","RANGE_FADE"]),
    evaluatedAt: z.iso.datetime(), scoreBreakdown: z.object({
      atiDecisionQuoteV1: z.unknown().optional(), atiFleetDecisionV1: z.unknown().optional(),
    }),
  }),
  order: z.object({ symbol: z.string(), side: z.enum(["BUY","SELL"]), volume: z.number().positive() }),
});
export function atiDispatchAdmission(raw: unknown) {
  const parsed = payload.safeParse(raw);
  return parsed.success ? parsed.data.agentAdmissionV1 : null;
}

type Command = { commandId: string; agentId: number | null; decisionId: number | null; side: string | null;
  symbol: string; requestedVolume: number | null; payload: unknown; sentAt: Date | null };
export type AtiAdmittedExecution = { id: number; agentId: number; decisionId: number | null;
  executingUserId: number | null; commandId: string | null; mode: string; admissionSnapshot: unknown };

export function atiVerifiedAdmission(ownerId: number, row: Command, stamped: unknown, execution?: AtiAdmittedExecution) {
  const signed = payload.safeParse(row.payload), sent = admission.safeParse(stamped);
  if (!signed.success || !sent.success || !execution || !row.sentAt || execution.commandId !== row.commandId ||
      execution.executingUserId !== ownerId || execution.mode !== "LIVE" || execution.agentId !== row.agentId ||
      execution.decisionId !== row.decisionId) return null;
  const envelope = signed.data.agentAdmissionV1, tag = signed.data.agentOwnership;
  if (tag.selfTradeAgentId !== row.agentId || tag.selfTradeDecisionId !== row.decisionId ||
      execution.id !== envelope.executionId || sent.data.executionId !== execution.id ||
      sent.data.snapshotHash !== envelope.snapshotHash) return null;
  const parsed = snapshot.safeParse(execution.admissionSnapshot);
  if (!parsed.success || entrySnapshotHash(execution.admissionSnapshot) !== envelope.snapshotHash) return null;
  const { agent, decision, settings, ledger, order } = parsed.data;
  if (agent.ownerId !== ownerId || agent.id !== row.agentId || settings.agentId !== agent.id || ledger.agentId !== agent.id ||
      decision.id !== row.decisionId || decision.agentId !== agent.id || agent.agentKey !== decision.agentKey ||
      decision.side !== row.side || order.symbol !== decision.symbol || order.side !== row.side || order.volume !== row.requestedVolume ||
      !entrySymbolMatches(decision.symbol, row.symbol, signed.data.selfTradeSymbolBinding) || Date.parse(decision.evaluatedAt) > +row.sentAt) return null;
  return { ownerId, brokerSymbol: row.symbol, agent, decision, executionId: execution.id, admissionHash: envelope.snapshotHash };
}

export function atiEntryStrategy(verified: ReturnType<typeof atiVerifiedAdmission>, accountBinding: string) {
  if (!verified) return null;
  const { ownerId, brokerSymbol, agent, decision, executionId, admissionHash } = verified;
  const parsed = cleanFleetVersion.safeParse(decision.scoreBreakdown.atiFleetDecisionV1);
  if (!parsed.success) return null;
  const version = parsed.data;
  const strategy = { engine: fleetEngine, revision: version.build.revision, agentId: agent.id, agentKey: agent.agentKey,
    symbol: decision.symbol, timeframe: decision.timeframe, setup: decision.setupType, decisionSettingsHash: version.decisionSettingsHash };
  return { strategy, cohortKey: hash(["ATI_REALIZED_ENTRY", ownerId, "LIVE", accountBinding, brokerSymbol, strategy]),
    decisionId: decision.id, executionId, admissionHash };
}
export type AtiEntryStrategy = NonNullable<ReturnType<typeof atiEntryStrategy>>;
