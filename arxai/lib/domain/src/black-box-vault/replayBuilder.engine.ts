import type { MarketTruthStorePort }    from "./marketTruth.store";
import type { DecisionTruthStorePort }  from "./decisionTruth.store";
import type { ExecutionTruthStorePort } from "./executionTruth.store";
import type { BehaviorTruthStorePort }  from "./behaviorTruth.store";
import type { OutcomeTruthStorePort }   from "./outcomeTruth.store";
import {
  type ReplayPacket, type RecordEnvelope,
  type DecisionTruthRecord, type MarketTruthRecord,
} from "./blackBox.types";

// ═══════════════════════════════════════════════════════════════════════════
// Replay Builder — assembles a complete ReplayPacket for either:
//   • an executed trade  → buildTradeReplay(tradeId)
//   • a blocked setup    → buildBlockedReplay(signalId)
//
// Pure orchestrator over the 5 truth stores. Returns reasons[] describing
// what was assembled and blockers[] describing missing pieces.
//
// Project rules:
//   • every trade must be replayable          → buildTradeReplay
//   • every blocked setup must be reviewable  → buildBlockedReplay
//   • every decision traceable                → all decisions included
// ═══════════════════════════════════════════════════════════════════════════

export interface ReplayBuilderPorts {
  market:    MarketTruthStorePort;
  decision:  DecisionTruthStorePort;
  execution: ExecutionTruthStorePort;
  behavior:  BehaviorTruthStorePort;
  outcome:   OutcomeTruthStorePort;
}

export interface BuildOptions {
  packetId: string;
  recordedAtIso: string;
}

export async function buildTradeReplay(
  tradeId: string,
  ports: ReplayBuilderPorts,
  opts: BuildOptions,
): Promise<ReplayPacket> {
  const reasons: string[] = [];
  const blockers: string[] = [];

  const decisions   = await ports.decision.byTrade(tradeId);
  const executions  = await ports.execution.byTrade(tradeId);
  const tradeBehaviors    = await ports.behavior.byTrade(tradeId);
  const outcome     = await ports.outcome.byTrade(tradeId);

  // Also gather behaviours keyed to any decision in this trade (e.g. an
  // override on a risk-decision that didn't carry the tradeId directly).
  const decisionBehaviors: typeof tradeBehaviors = [];
  for (const d of decisions) {
    const list = await ports.behavior.byDecision(d.decisionId);
    decisionBehaviors.push(...list);
  }
  const behaviors = dedupeById([...tradeBehaviors, ...decisionBehaviors], (b) => b.behaviorId);

  // Pull market truths referenced by the decisions.
  const marketIds = unique(decisions.map((d) => d.marketTruthId).filter(isString));
  const marketTruths = await collectMarketTruths(marketIds, ports.market, blockers);

  // ── Cross-link integrity ────────────────────────────────────────────────
  const decisionIdSet = new Set(decisions.map((d) => d.decisionId));
  for (const e of executions) {
    if (!decisionIdSet.has(e.decisionId)) {
      blockers.push(`execution ${e.executionId} references unknown decisionId ${e.decisionId} for trade ${tradeId}`);
    }
  }
  if (outcome && outcome.decisionId && !decisionIdSet.has(outcome.decisionId)) {
    blockers.push(`outcome ${outcome.outcomeId} references unknown decisionId ${outcome.decisionId} for trade ${tradeId}`);
  }

  if (decisions.length === 0)   blockers.push(`no decision truth records for tradeId ${tradeId}`);
  if (executions.length === 0)  blockers.push(`no execution truth records for tradeId ${tradeId} (was the trade actually executed?)`);
  if (!outcome)                 reasons.push(`no outcome yet — trade ${tradeId} may still be open`);

  const envelope = chooseEnvelope(decisions, executions, opts.recordedAtIso);
  reasons.push(`assembled trade replay for ${tradeId}: ` +
               `${decisions.length} decisions, ${executions.length} executions, ` +
               `${behaviors.length} behaviours, ${marketTruths.length} market truths` +
               `${outcome ? ", outcome present" : ""}`);

  return {
    packetId: opts.packetId,
    tradeId,
    signalId: pickSignalId(decisions),
    envelope,
    decisions:    sortByIsoThenId(decisions,    (d) => d.decisionId),
    marketTruths: sortByIsoThenId(marketTruths, (m) => m.marketTruthId),
    executions:   sortByIsoThenId(executions,   (e) => e.executionId),
    behaviors:    sortByIsoThenId(behaviors,    (b) => b.behaviorId),
    outcome: outcome ?? undefined,
    isBlocked: false,
    reasons,
    blockers,
  };
}

export async function buildBlockedReplay(
  signalId: string,
  ports: ReplayBuilderPorts,
  opts: BuildOptions,
): Promise<ReplayPacket> {
  const reasons: string[] = [];
  const blockers: string[] = [];

  const decisions = await ports.decision.bySignal(signalId);
  if (decisions.length === 0) {
    blockers.push(`no decision truth records for signalId ${signalId} — cannot replay blocked setup`);
  }
  // A blocked replay should contain at least one DENIED verdict to make sense.
  const hasDenied = decisions.some((d) => d.verdict === "DENIED");
  if (!hasDenied) {
    blockers.push(`no DENIED decision found for signalId ${signalId} — block-replay invariant violated`);
  }

  const marketIds = unique(decisions.map((d) => d.marketTruthId).filter(isString));
  const marketTruths = await collectMarketTruths(marketIds, ports.market, blockers);

  // Behaviours linked to those decisions (e.g. an override on a block).
  const rawBehaviors: Awaited<ReturnType<BehaviorTruthStorePort["byDecision"]>> = [];
  for (const d of decisions) {
    const list = await ports.behavior.byDecision(d.decisionId);
    rawBehaviors.push(...list);
  }
  const behaviors = dedupeById(rawBehaviors, (b) => b.behaviorId);

  const envelope = chooseEnvelope(decisions, [], opts.recordedAtIso);

  reasons.push(`assembled blocked-setup replay for signal ${signalId}: ` +
               `${decisions.length} decisions, ${marketTruths.length} market truths, ` +
               `${behaviors.length} behaviours`);

  return {
    packetId: opts.packetId,
    tradeId: undefined,
    signalId,
    envelope,
    decisions:    sortByIsoThenId(decisions,    (d) => d.decisionId),
    marketTruths: sortByIsoThenId(marketTruths, (m) => m.marketTruthId),
    executions: [],
    behaviors:    sortByIsoThenId(behaviors,    (b) => b.behaviorId),
    outcome: undefined,
    isBlocked: true,
    reasons,
    blockers,
  };
}

// ── helpers ────────────────────────────────────────────────────────────────
function isString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function dedupeById<T>(xs: T[], idOf: (x: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of xs) {
    const id = idOf(x);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(x);
  }
  return out;
}

// Canonical ordering: chronological by recordedAtIso, tiebreak by id.
function sortByIsoThenId<T extends { recordedAtIso: string }>(
  xs: T[],
  idOf: (x: T) => string,
): T[] {
  return [...xs].sort((a, b) => {
    if (a.recordedAtIso !== b.recordedAtIso) return a.recordedAtIso < b.recordedAtIso ? -1 : 1;
    const ai = idOf(a); const bi = idOf(b);
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
}

async function collectMarketTruths(
  ids: string[],
  market: MarketTruthStorePort,
  blockers: string[],
): Promise<MarketTruthRecord[]> {
  const out: MarketTruthRecord[] = [];
  for (const id of ids) {
    const r = await market.byId(id);
    if (r) out.push(r);
    else blockers.push(`marketTruthId ${id} referenced but missing`);
  }
  return out;
}

function pickSignalId(decisions: readonly DecisionTruthRecord[]): string | undefined {
  for (const d of decisions) if (d.signalId) return d.signalId;
  return undefined;
}

// Choose a canonical envelope for the packet so it can be filtered like
// every other vault record. Prefer the EARLIEST decision's envelope.
function chooseEnvelope(
  decisions: readonly DecisionTruthRecord[],
  executions: readonly { recordedAtIso: string; envelope?: RecordEnvelope }[],
  fallbackIso: string,
): RecordEnvelope {
  if (decisions.length === 0) {
    return { recordedAtIso: fallbackIso };
  }
  const earliest = decisions.reduce((a, b) =>
    b.recordedAtIso < a.recordedAtIso ? b : a);
  // Strip discriminator-only fields; envelope is just the index dimensions.
  const { recordedAtIso, symbol, session, strategyId, regimeId, agentId, versionId, shadow } = earliest;
  return { recordedAtIso, symbol, session, strategyId, regimeId, agentId, versionId, shadow };
}
