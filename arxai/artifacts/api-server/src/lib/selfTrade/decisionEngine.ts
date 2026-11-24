// Self-Trade AI — Decision Engine (Task #212, Decision Brain & Handshake Network).
//
// SAFETY / SCOPE:
//   - SHADOW / decision-only. This engine NEVER places, modifies, or closes a
//     real order, never touches the MT5 bridge, the 16-gate live pipeline, kill
//     switches, allocation, or the Risk Governor's execution path. It only READS
//     those surfaces to produce ranked, supervisor-approved trade DECISIONS with
//     a full thesis + ordered, auditable handshake checks. Live execution is a
//     later phase and still rides every existing gate.
//   - HONEST. Market reads are real candles via the existing signal-intelligence
//     service (which never fabricates) or an explicit blind read. Missing / stale
//     data collapses a decision to an honest WATCH / WAIT with the gap named.
//   - On-demand + persisted, polled: each cycle evaluates funded/active agents
//     against their allowed symbols, persists every decision + a fleet audit row
//     (fail-open on persist), and returns. There is NO always-on background
//     runner this phase. A short in-process cache makes polling "continuous
//     while watching" without re-evaluating on every request.

import { randomUUID } from "node:crypto";
import {
  db,
  selfTradeDecisionsTable,
  selfTradeAgentsTable,
  selfTradeAgentSettingsTable,
  selfTradeAgentLedgerTable,
  selfTradeKillSwitchesTable,
  type NewSelfTradeDecision,
  type SelfTradeAgent,
  type SelfTradeAgentSettings,
  type SelfTradeAgentLedger,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  runDecisionPipeline,
  resolveSupervisor,
  type DecisionCandidate,
  type DecisionCandidateInput,
  type GovernorContext,
  type HandshakeReadinessContext,
  type QuotaContext,
} from "@workspace/domain/self-trade";
import type {
  NewsRiskLevel,
  EleanorMarketEdgeSignal,
} from "@workspace/domain/signal-intelligence";
import { logger } from "../logger.js";
import { compareAtiDemoChart, type AtiDemoChartComparison } from "./atiDemoChartComparison.js";
import { selfTradeChartConfirmation } from "./selfTradeChartConfirmation.js";
import { getCachedIntelligenceContext } from "../data/chart/chartIntelligence.js";
import { buildEleanorMarketEdgeForUser } from "../signalIntelligence/signalIntelligenceService.js";
import { loadPlatformHalt, type TradingHalt } from "../safety/tradingHalt.js";
import { runAllHandshakes } from "../handshake/coordinator.js";
import { routeQuote } from "../data/marketDataRouter.js";
import { activeAtiFleetRuns, fleetPriceOrigin, type AtiFleetRead } from "./atiFleetShadow.js";
import { atiFleetDecisionVersion } from "./atiStrategyOrigin.js";
import { freezeAtiDecisionQuote, type AtiDecisionQuote } from "../mt5/atiCostEvidence.js";
import { captureAtiMarketContext, type AtiMarketContext } from "./atiTradingContext.js";
import type { AtiMt5QuoteOrigin } from "../data/atiMt5QuoteOrigin.js";
import { sameMarketReadSourceFamily } from "../truth/marketReadEvidence.js";
import { computeQuotaFromSettings } from "./agentQuotaEngine.js";
import { writeSelfTradeAudit } from "./audit.js";
import type { AgentScope } from "./service.js";

// Timeframes: a primary read + one higher timeframe for alignment. Agents have
// no per-agent timeframe column yet, so the brain uses sane fixed reads.
const PRIMARY_TF = "M5";
const HTF = "H1";

// Bound the work per cycle so a misconfigured allowlist can't fan out forever.
const MAX_SYMBOLS_PER_AGENT = 12;

// Statuses the brain evaluates: funded + (idle or active). UNFUNDED can't trade;
// PAUSED/STOPPED/ARCHIVED are intentionally excluded.
const EVALUABLE_STATUSES = new Set(["FUNDED_IDLE", "ACTIVE"]);

// Short read-cache so frontend polling is "continuous while watching" without
// re-running the full pipeline on every request.
const CACHE_TTL_MS = 8_000;

export interface DecisionCycleResult {
  cycleId: string;
  generatedAt: string;
  agentsEvaluated: number;
  symbolsEvaluated: number;
  decisions: DecisionCandidate[];
  contendedSymbols: string[];
  governorStatus: string;
  handshakeReady: boolean;
  /** Honest, human notes about why the feed may be empty/blind (never secret). */
  notes: string[];
  persisted: boolean;
}

const cache = new Map<string, { at: number; result: DecisionCycleResult }>();

export interface SelfTradeObservationInput {
  demoChartComparison?: AtiDemoChartComparison;
  input: DecisionCandidateInput;
  chartConfirmation: { allowed: boolean; reason: string | null };
  boundQuote: { bid: number; ask: number; observedAt: string } | null;
  mt5QuoteOrigin: AtiMt5QuoteOrigin | null;
  derivQuoteOrigin: AtiDerivQuoteOrigin | null;
}

function scopeKey(scope?: AgentScope): string {
  if (!scope) return "ALL";
  return `${scope.ownerType ?? "ANY"}:${scope.ownerId ?? "ANY"}`;
}

// Fleet-level governor context: the platform stop switches (the same ones the
// pre-trade Risk Governor honours). Per-order risk is decided by the Risk
// Governor inside executeInstant for each agent's own user, never here.
function governorFromHalt(halt: TradingHalt | null): GovernorContext {
  if (!halt) return { status: "UNKNOWN", hardBlocks: [] };
  return halt.engaged ? { status: "LOCKED", hardBlocks: [...halt.sources] } : { status: "PAPER_ALLOWED", hardBlocks: [] };
}

// Advisory handshake verdicts → readiness context. BLOCK → blocked, WARN/UNKNOWN
// → degraded. Never gates the real 16-gate pipeline; only downgrades a decision.
function mapHandshakes(
  results: { type: string; overallStatus: string }[] | null,
): HandshakeReadinessContext {
  // `null` means the handshake coordinator itself failed — that is an HONEST
  // "unavailable" state, NOT "all ready". Never report ready when we have no
  // evidence of readiness.
  if (results === null) {
    return { ready: false, degraded: ["HANDSHAKE_UNAVAILABLE"], blocked: [] };
  }
  const blocked: string[] = [];
  const degraded: string[] = [];
  for (const r of results) {
    if (r.overallStatus === "BLOCK") blocked.push(r.type);
    else if (r.overallStatus === "WARN" || r.overallStatus === "UNKNOWN") degraded.push(r.type);
  }
  return { ready: blocked.length === 0 && degraded.length === 0, degraded, blocked };
}

// Inverse of newsSafety (0–100) → coarse risk band. Mirrors the thesis derivation
// so the pipeline's news check and the thesis agree.
function deriveNewsRisk(newsSafety: number): NewsRiskLevel {
  if (newsSafety <= 10) return "critical";
  if (newsSafety <= 40) return "high";
  if (newsSafety <= 60) return "medium";
  if (newsSafety <= 85) return "low";
  return "none";
}

function allowedSymbolsOf(settings: SelfTradeAgentSettings | null): string[] {
  const raw = (settings?.allowedSymbols ?? []) as unknown;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const s of raw) {
    if (typeof s === "string" && s.trim()) out.push(s.trim());
    if (out.length >= MAX_SYMBOLS_PER_AGENT) break;
  }
  return out;
}

// Resolve which user's per-user execution context the signal builder reads. For
// USER agents this is the owner; for OPERATOR_FLEET agents it is the creating
// operator, falling back to the caller. (Used only for honest per-user reads;
// never crosses isolation — every read stays scoped to that userId.)
function effectiveUserIdFor(agent: SelfTradeAgent, callerUserId: number | null): number | null {
  return agent.ownerId ?? agent.createdByUserId ?? callerUserId ?? null;
}

async function buildCandidate(
  agent: SelfTradeAgent,
  settings: SelfTradeAgentSettings | null,
  ledger: SelfTradeAgentLedger | null,
  symbol: string,
  effectiveUserId: number,
  governor: GovernorContext,
  handshake: HandshakeReadinessContext,
  killEngaged: boolean,
  now: number,
  observe?: (observation: SelfTradeObservationInput) => void,
  captureFleet?: (read: AtiFleetRead) => void,
): Promise<{ candidate: DecisionCandidate; facts: StoredDecisionFacts }> {
  const evidence: Omit<SelfTradeObservationInput, "input" | "chartConfirmation"> = { boundQuote: null, mt5QuoteOrigin: null, derivQuoteOrigin: null };
  const [signal, htf, quote] = await Promise.all([
    buildEleanorMarketEdgeForUser(effectiveUserId, { symbol, timeframe: PRIMARY_TF }, (observe || captureFleet) && {
      skipPersist: !!observe,
      onBoundQuote: (quote, mt5Origin, derivOrigin) => Object.assign(evidence, {
        boundQuote: quote, mt5QuoteOrigin: mt5Origin, derivQuoteOrigin: derivOrigin,
      }),
    }),
    buildEleanorMarketEdgeForUser(effectiveUserId, { symbol, timeframe: HTF }, observe && { skipPersist: true }).catch(() => null),
    observe ? Promise.resolve(null) : routeQuote(symbol).catch(() => null),
  ]);

  const cached = getCachedIntelligenceContext(symbol, PRIMARY_TF, 300) ?? getCachedIntelligenceContext(symbol, PRIMARY_TF, 200);
  const chartConfirmation = selfTradeChartConfirmation(cached?.state ?? null);
  const { allowed: chartGateAllowed, reason: chartGateNote } = chartConfirmation;

  // When the chart gate blocks, inject CHART_TRUTH_BLOCKED into the advisory
  // handshake so the pure pipeline's handshake-readiness check can degrade the
  // decision (WATCH/WAIT rather than APPROVED). This is advisory; it never
  // touches the 16-gate live dispatch pipeline.
  const effectiveHandshake: HandshakeReadinessContext = chartGateAllowed
    ? handshake
    : {
        ready: false,
        degraded: handshake.degraded,
        blocked: [...handshake.blocked, "CHART_TRUTH_BLOCKED"],
      };

  const currentPrice = observe
    ? evidence.boundQuote && (evidence.boundQuote.bid + evidence.boundQuote.ask) / 2
    : quote?.ok && quote.quote
      ? quote.quote.last ??
        (quote.quote.bid != null && quote.quote.ask != null
          ? (quote.quote.bid + quote.quote.ask) / 2
          : null)
      : null;

  // tradesTakenToday is 0 in the shadow phase — no real trades are executed, so
  // the quota is shown as full headroom rather than counting shadow decisions.
  const quota: QuotaContext = settings
    ? toQuotaContext(computeQuotaFromSettings(settings, 0))
    : DEFAULT_QUOTA;

  const input: DecisionCandidateInput = {
    agentId: agent.id,
    agentKey: agent.agentKey,
    // Higher autonomy wins one-owner-per-trade contention (deterministic).
    agentRankWeight: agent.autonomyLevel,
    symbol,
    timeframe: PRIMARY_TF,
    symbolAllowed: true, // we only iterate this agent's own allowlist
    maxSpreadPoints: null,
    signal,
    htfSignals: htf && (!observe || sameMarketReadSourceFamily(signal.marketEvidence ?? null, htf.marketEvidence ?? null)) ? [htf] : [],
    currentPrice,
    newsRisk: deriveNewsRisk(signal.scores.newsSafety),
    // Decision-only: broker execution context is honestly unknown (we are not
    // executing). The spread/heartbeat checks degrade to SKIP, never fabricate.
    execution: { liveSpreadPoints: null, heartbeatAgeSeconds: null, bridgeConnected: null },
    quota,
    funding: {
      availableFunds: ledger?.availableFunds ?? 0,
      allocatedFunds: ledger?.allocatedFunds ?? 0,
    },
    governor,
    // Phase 4: use effectiveHandshake (CHART_TRUTH_BLOCKED injected when gate
    // blocks). Advisory downgrade only — 16-gate live pipeline is untouched.
    handshake: effectiveHandshake,
    killEngaged,
    now,
  };

  const decidedAt = Date.now();
  const costQuote = freezeAtiDecisionQuote(quote, effectiveUserId, decidedAt);
  const candidate = runDecisionPipeline(input);
  if (observe || captureFleet) {
    const observation: SelfTradeObservationInput = { input, ...evidence, chartConfirmation };
    if (observe && evidence.mt5QuoteOrigin?.mode === "DEMO") {
      observation.demoChartComparison = compareAtiDemoChart(input, candidate, handshake, cached, evidence.boundQuote,
        evidence.mt5QuoteOrigin, effectiveUserId, decidedAt);
    }
    observe?.(observation);
    captureFleet?.({ observation, priceOrigin: fleetPriceOrigin(quote) });
  }
  // Log chart gate note for admin diagnostics (DecisionCandidate has no notes field).
  if (chartGateNote) {
    logger.debug({ symbol, agentKey: agent.agentKey, chartGateNote }, "self-trade: chart gate advisory");
  }
  return { candidate, facts: { fleetVersion: observe ? null : atiFleetDecisionVersion(input), costQuote, marketContext: captureAtiMarketContext(signal, effectiveUserId, decidedAt) } };
}

function toQuotaContext(v: ReturnType<typeof computeQuotaFromSettings>): QuotaContext {
  return {
    dailyMinTrades: v.dailyMinTrades,
    effectiveMaxTrades: v.effectiveMaxTrades,
    tradesTakenToday: v.tradesTakenToday,
    remainingToMax: v.remainingToMax,
    belowDailyMinimum: v.belowDailyMinimum,
    baseReached: v.baseReached,
    hardCapReached: v.hardCapReached,
  };
}

const DEFAULT_QUOTA: QuotaContext = {
  dailyMinTrades: 0,
  effectiveMaxTrades: 0,
  tradesTakenToday: 0,
  remainingToMax: 0,
  belowDailyMinimum: false,
  baseReached: true,
  hardCapReached: true,
};

type StoredDecisionFacts = { fleetVersion: ReturnType<typeof atiFleetDecisionVersion> | null; costQuote: AtiDecisionQuote | null; marketContext: AtiMarketContext | null };

function candidateToRow(c: DecisionCandidate, cycleId: string, evaluatedAt: Date, facts?: StoredDecisionFacts): NewSelfTradeDecision {
  return {
    agentId: c.agentId,
    agentKey: c.agentKey,
    cycleId,
    symbol: c.symbol,
    timeframe: c.timeframe,
    side: c.side,
    outcome: c.outcome,
    setupType: c.setup === "NONE" ? null : c.setup,
    setupScore: c.setupScore,
    rankScore: c.rankScore,
    noTradeScore: c.noTradeScore,
    confidence: c.confidence,
    confidenceDecayed: c.confidenceDecayed,
    plannedAction: c.plannedAction,
    reason: c.reason,
    riskState: c.riskState,
    quotaProgress: c.quotaProgress as unknown as Record<string, unknown>,
    handshakes: c.checks as unknown as Record<string, unknown>[],
    scoreBreakdown: { ...c.scoreBreakdown, ...(facts?.fleetVersion ? { atiFleetDecisionV1: facts.fleetVersion } : {}), ...(facts?.costQuote ? { atiDecisionQuoteV1: facts.costQuote } : {}),
      ...(facts?.marketContext ? { atiMarketContextV1: facts.marketContext } : {}) },
    thesis: (c.thesis ?? null) as unknown as Record<string, unknown> | null,
    ownerAgentKey: c.ownerAgentKey,
    conflictState: c.conflictState,
    setupExpiresAt: c.setupExpiresAt ? new Date(c.setupExpiresAt) : null,
    evaluatedAt,
  };
}

async function loadEvaluableAgents(scope?: AgentScope, agentId?: number): Promise<
  { agent: SelfTradeAgent; settings: SelfTradeAgentSettings | null; ledger: SelfTradeAgentLedger | null }[]
> {
  // Scope mirrors the read route: USER scope sees only its own agents; admin
  // (no scope) sees the whole fleet.
  const owner =
    scope?.ownerType === "USER" && scope.ownerId != null
      ? and(eq(selfTradeAgentsTable.ownerType, "USER"), eq(selfTradeAgentsTable.ownerId, scope.ownerId))
      : scope?.ownerType === "OPERATOR_FLEET"
        ? eq(selfTradeAgentsTable.ownerType, "OPERATOR_FLEET")
        : undefined;

  const where = agentId == null ? owner : and(owner, eq(selfTradeAgentsTable.id, agentId));
  const rows = where
    ? await db.select().from(selfTradeAgentsTable).where(where)
    : await db.select().from(selfTradeAgentsTable);
  const agents = rows.filter((a) => EVALUABLE_STATUSES.has(a.status));
  if (agents.length === 0) return [];

  const ids = agents.map((a) => a.id);
  const [settingsRows, ledgerRows] = await Promise.all([
    db.select().from(selfTradeAgentSettingsTable).where(inArray(selfTradeAgentSettingsTable.agentId, ids)),
    db.select().from(selfTradeAgentLedgerTable).where(inArray(selfTradeAgentLedgerTable.agentId, ids)),
  ]);
  const settingsBy = new Map(settingsRows.map((s) => [s.agentId, s]));
  const ledgerBy = new Map(ledgerRows.map((l) => [l.agentId, l]));
  return agents.map((agent) => ({
    agent,
    settings: settingsBy.get(agent.id) ?? null,
    ledger: ledgerBy.get(agent.id) ?? null,
  }));
}

export async function canObserveSelfTradeAgent(ownerId: number, agentId: number, symbol: string) {
  const [bundle] = await loadEvaluableAgents({ ownerType: "USER", ownerId }, agentId);
  return !!bundle && allowedSymbolsOf(bundle.settings).includes(symbol);
}

/** Evaluate one owner-scoped agent with the normal decision brain before fleet
 * contention, using only source-bound market inputs. Research captures never
 * enter the Self-Trade decision queue. */
export async function observeSelfTradeCandidate(ownerId: number, agentId: number, symbol: string) {
  const [bundle] = await loadEvaluableAgents({ ownerType: "USER", ownerId }, agentId);
  if (!bundle || !allowedSymbolsOf(bundle.settings).includes(symbol)) return null;
  const [{ governor, handshake }, killEngaged] = await Promise.all([buildFleetSafetyContext(), globalKillEngaged()]);
  let observation: SelfTradeObservationInput | undefined;
  const { candidate } = await buildCandidate(bundle.agent, bundle.settings, bundle.ledger, symbol,
    ownerId, governor, handshake, killEngaged, Date.now(), (value) => { observation = value; });
  if (!observation) throw new Error("SELF_TRADE_OBSERVATION_UNAVAILABLE");
  return { candidate, observation, evaluatedAt: Date.now() };
}

async function globalKillEngaged(): Promise<boolean> {
  const rows = await db
    .select()
    .from(selfTradeKillSwitchesTable)
    .where(and(eq(selfTradeKillSwitchesTable.scope, "GLOBAL"), eq(selfTradeKillSwitchesTable.engaged, true)));
  return rows.length > 0;
}

/**
 * Build the fleet-wide safety context (risk governor + handshake readiness)
 * exactly the way the decision cycle does, so the autonomous executor and the
 * decision feed can NEVER drift on how governor/handshake state is mapped.
 * Degrades honestly: governor failure → UNKNOWN, handshake failure → unavailable
 * (never "ready"). This is advisory context fed into the pure permission
 * evaluator; it is NOT one of the 16 live gates.
 */
export async function buildFleetSafetyContext(): Promise<{
  governor: GovernorContext;
  handshake: HandshakeReadinessContext;
}> {
  const [governorEval, handshakeResults] = await Promise.all([
    loadPlatformHalt().catch((err) => {
      logger.warn({ err }, "self-trade: platform halt read failed (degrading to UNKNOWN)");
      return null;
    }),
    runAllHandshakes().catch((err) => {
      logger.warn({ err }, "self-trade: handshake run failed (degrading to UNAVAILABLE)");
      return null;
    }),
  ]);
  const governor = governorFromHalt(governorEval);
  return { governor, handshake: mapHandshakes(handshakeResults) };
}

async function persistCycle(
  cycleId: string,
  candidates: DecisionCandidate[],
  contendedSymbols: string[],
  evaluatedAt: Date,
  facts: ReadonlyMap<string, StoredDecisionFacts>,
  subscriptions: Awaited<ReturnType<typeof activeAtiFleetRuns>>,
  fleetReads: ReadonlyMap<number, AtiFleetRead>,
) {
  if (candidates.length === 0) return true;
  try {
    return await db.transaction(async (tx) => {
      const insert = tx.insert(selfTradeDecisionsTable).values(candidates.map(c =>
        candidateToRow(c, cycleId, evaluatedAt, facts.get(decisionKey(c)))));
      if (!subscriptions.length) {
        await insert;
      } else {
        const saved = await insert.returning({ id: selfTradeDecisionsTable.id, agentId: selfTradeDecisionsTable.agentId,
          symbol: selfTradeDecisionsTable.symbol });
        const { recordAtiFleetObservation } = await import("./atiShadow.js");
        for (const run of subscriptions) {
          const matching = saved.filter(d => d.agentId === run.agentId && d.symbol === run.symbol);
          const candidate = candidates.find(c => c.agentId === run.agentId && c.symbol === run.symbol);
          const captured = fleetReads.get(run.agentId);
          const version = candidate && facts.get(decisionKey(candidate))?.fleetVersion;
          if (matching.length !== 1 || !candidate || !captured || !version) continue;
          await recordAtiFleetObservation(run, candidate, captured, Date.now(), {
            cycleId, decisionId: matching[0]!.id, cycleStartedAt: +evaluatedAt, version,
          }, tx).catch(err => logger.warn({ err, runId: run.id }, "ATI fleet observation unavailable"));
        }
      }
      await writeSelfTradeAudit(tx, {
        eventType: "DECISION_CYCLE",
        scope: "FLEET",
        severity: contendedSymbols.length > 0 ? "WARNING" : "INFO",
        afterState: {
          cycleId,
          decisions: candidates.length,
          contendedSymbols,
          approved: candidates.filter((c) => c.outcome === "APPROVED" || c.outcome === "APPROVED_REDUCED").length,
        },
        reason: `Self-Trade decision cycle (shadow): ${candidates.length} decisions`,
      });
      return true;
    });
  } catch (err) {
    // Fail-open on persist: a logging failure must not block the decision read.
    logger.error({ err, cycleId }, "self-trade decision cycle persist failed (fail-open)");
    return false;
  }
}

function decisionKey(candidate: DecisionCandidate) {
  return JSON.stringify([candidate.agentId, candidate.symbol]);
}

/**
 * Run one decision-evaluation cycle for the funded/active agents in scope.
 * Short-cached so polling is continuous-while-watching. Persists every cycle
 * (fail-open) and returns the supervisor-resolved decisions.
 */
export async function runDecisionCycle(
  scope: AgentScope | undefined,
  callerUserId: number | null,
  opts: { force?: boolean } = {},
): Promise<DecisionCycleResult> {
  const key = scopeKey(scope);
  const now = Date.now();
  if (!opts.force) {
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.result;
  }

  const cycleId = `cycle_${now}_${randomUUID().slice(0, 8)}`;
  const generatedAt = new Date(now).toISOString();
  const notes: string[] = [];

  const loaded = await loadEvaluableAgents(scope);
  if (loaded.length === 0) {
    const empty: DecisionCycleResult = {
      cycleId,
      generatedAt,
      agentsEvaluated: 0,
      symbolsEvaluated: 0,
      decisions: [],
      contendedSymbols: [],
      governorStatus: "UNKNOWN",
      handshakeReady: false,
      notes: ["No funded/active agents to evaluate."],
      persisted: true,
    };
    cache.set(key, { at: now, result: empty });
    return empty;
  }

  // Cycle-global context (read once, shared across all candidates).
  const [governorEval, handshakeResults, killEngaged] = await Promise.all([
    loadPlatformHalt().catch((err) => {
      logger.warn({ err }, "self-trade: platform halt read failed (degrading to UNKNOWN)");
      return null;
    }),
    runAllHandshakes().catch((err) => {
      logger.warn({ err }, "self-trade: handshake run failed (degrading to UNAVAILABLE)");
      return null;
    }),
    globalKillEngaged().catch(() => false),
  ]);

  const governor = governorFromHalt(governorEval);
  const handshake = mapHandshakes(handshakeResults);
  if (killEngaged) notes.push("Global Self-Trade kill switch engaged — all decisions blocked.");
  if (governor.status === "UNKNOWN") notes.push("Risk Governor state unavailable — decisions degraded.");
  if (handshakeResults === null) notes.push("Handshake network unavailable — readiness unknown, decisions degraded.");

  // Build candidates (per agent, symbols in parallel; agents sequential to be
  // gentle on upstream providers).
  const owner = scope?.ownerType === "USER" ? scope.ownerId : null;
  const subscriptions = owner ? await activeAtiFleetRuns(owner, now)
    .catch(err => { logger.warn({ err }, "ATI fleet subscriptions unavailable"); return []; }) : [];
  const fleetReads = new Map<number, AtiFleetRead>();
  const allCandidates: DecisionCandidate[] = [];
  const facts = new Map<string, StoredDecisionFacts>();
  let symbolsEvaluated = 0;
  for (const { agent, settings, ledger } of loaded) {
    const symbols = allowedSymbolsOf(settings);
    if (symbols.length === 0) {
      notes.push(`${agent.agentKey}: no symbols configured.`);
      continue;
    }
    const effectiveUserId = effectiveUserIdFor(agent, callerUserId);
    if (effectiveUserId == null) {
      notes.push(`${agent.agentKey}: no user context for market read.`);
      continue;
    }
    const candidates = await Promise.all(
      symbols.map((symbol) =>
        buildCandidate(agent, settings, ledger, symbol, effectiveUserId, governor, handshake, killEngaged, now, undefined,
          subscriptions.some(run => run.agentId === agent.id && run.symbol === symbol)
            ? read => { fleetReads.set(agent.id, read); } : undefined).catch(
          (err) => {
            logger.warn({ err, agentKey: agent.agentKey, symbol }, "self-trade: candidate build failed (skipped)");
            return null;
          },
        ),
      ),
    );
    for (const result of candidates) {
      if (result) {
        allCandidates.push(result.candidate);
        facts.set(decisionKey(result.candidate), result.facts);
        symbolsEvaluated += 1;
      }
    }
  }

  const supervised = resolveSupervisor(allCandidates);
  // Highest rank first so the feed reads as a priority list.
  supervised.candidates.sort((a, b) => b.rankScore - a.rankScore);

  const evaluatedAt = new Date(now);
  const persisted = await persistCycle(cycleId, supervised.candidates, supervised.contendedSymbols, evaluatedAt, facts,
    subscriptions, fleetReads);

  const result: DecisionCycleResult = {
    cycleId,
    generatedAt,
    agentsEvaluated: loaded.length,
    symbolsEvaluated,
    decisions: supervised.candidates,
    contendedSymbols: supervised.contendedSymbols,
    governorStatus: governor.status,
    handshakeReady: handshake.ready,
    notes,
    persisted,
  };
  cache.set(key, { at: now, result });
  return result;
}
import type { AtiDerivQuoteOrigin } from "../data/atiDerivQuotes.js";
