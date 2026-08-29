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
  type SupervisorResult,
} from "@workspace/domain/self-trade";
import { ingestDecisionCycle } from "../opportunitySpine/opportunityLifecycleManager.js";
import type {
  NewsRiskLevel,
  RubyMarketEdgeSignal,
} from "@workspace/domain/signal-intelligence";
import { logger } from "../logger.js";
import { getCachedIntelligenceContext } from "../data/chart/chartIntelligence.js";
import { buildRubyMarketEdgeForUser } from "../signalIntelligence/signalIntelligenceService.js";
import { evaluateGovernor } from "../riskGovernor/governor.js";
import { runAllHandshakes } from "../handshake/coordinator.js";
import { routeQuote } from "../data/marketDataRouter.js";
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

function scopeKey(scope?: AgentScope): string {
  if (!scope) return "ALL";
  return `${scope.ownerType ?? "ANY"}:${scope.ownerId ?? "ANY"}`;
}

// Governor overall status → the coarse status the pure pipeline understands.
function mapGovernorStatus(overall: string): GovernorContext["status"] {
  switch (overall) {
    case "LOCKED": return "LOCKED";
    case "WATCH_ONLY": return "WATCH_ONLY";
    case "PAPER_PAUSED": return "PAPER_PAUSED";
    case "PAPER_CAUTION": return "PAPER_ALLOWED"; // caution is still tradeable
    case "PAPER_ALLOWED": return "PAPER_ALLOWED";
    default: return "UNKNOWN";
  }
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
): Promise<DecisionCandidate> {
  const [signal, htf, quote] = await Promise.all([
    buildRubyMarketEdgeForUser(effectiveUserId, { symbol, timeframe: PRIMARY_TF }),
    buildRubyMarketEdgeForUser(effectiveUserId, { symbol, timeframe: HTF }).catch(() => null),
    routeQuote(symbol).catch(() => null),
  ]);

  // Phase 4: Check whether the Phase 3 chart gate allows chart-based
  // confirmation for this symbol. If selfTradeChartAllowed is false, inject
  // CHART_TRUTH_BLOCKED into handshake.blocked so the pure decision pipeline
  // knows chart confirmation is unavailable (advisory downgrade, never a real
  // execution block — the 16-gate live pipeline is untouched).
  // Use only cached state (no provider re-probe) — fail-safe: absent cache →
  // chart confirmation blocked (conservative, never fabricate a pass).
  // Phase 4: Chart gate for self-trade chart-based confirmation.
  // Requires ALL of:
  //   - selfTradeChartAllowed (Chart Truth ≥ 75)
  //   - autonomousChartActionAllowed (feed not stale — no autonomous action on stale data)
  //   - tradeConfirmationAllowed (mirror synced — chart entry/stop references usable)
  //   - current candle is closed (no forming-candle confirmation)
  // Fail-safe: absent cache → chartGateAllowed = false (conservative, no fabrication).
  // Advisory only — never touches the 16-gate live dispatch pipeline.
  let chartGateAllowed = false;
  let chartGateNote: string | null = null;
  {
    const cached =
      getCachedIntelligenceContext(symbol, PRIMARY_TF, 300) ??
      getCachedIntelligenceContext(symbol, PRIMARY_TF, 200);
    if (cached) {
      const gate = cached.state.gateOutput;
      // Truth check (Chart Truth ≥ 75)
      if (!gate.selfTradeChartAllowed) {
        chartGateNote = gate.primaryBlockReason ??
          "Chart Truth below threshold — chart-based confirmation unavailable.";
      }
      // Freshness check (feed not stale)
      else if (!gate.autonomousChartActionAllowed) {
        chartGateNote = gate.primaryBlockReason ??
          "Chart feed is stale — autonomous chart-based confirmation withheld.";
      }
      // Mirror check (broker price alignment in tolerance)
      else if (!gate.tradeConfirmationAllowed) {
        chartGateNote = gate.primaryBlockReason ??
          "Broker price mirror is degraded — chart-based entry/stop confirmation unavailable.";
      }
      // Broker data availability: tradeConfirmationAllowed can be true even when
      // broker quote was never available (alignmentFailed is only set when
      // brokerDataAvailable=true AND tolerance="failed"). For autonomous self-trade
      // the broker-alignment check must be confirmed with real broker data present.
      else if (!cached.state.brokerAlignment.brokerDataAvailable) {
        chartGateNote = "Broker price data not available — self-trade chart confirmation requires live broker alignment evidence.";
      }
      // Closed-candle requirement: strategies must not confirm on a still-forming candle.
      else if (cached.state.currentCandle != null) {
        chartGateNote = "Current candle has not closed — chart-based confirmation withheld until the bar closes.";
      }
      else {
        chartGateAllowed = true;
      }
    } else {
      chartGateNote = "Chart intelligence not yet cached — chart-based confirmation unavailable.";
    }
  }

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

  const currentPrice =
    quote?.ok && quote.quote
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
    htfSignals: htf ? [htf] : [],
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

  const result = runDecisionPipeline(input);
  // Log chart gate note for admin diagnostics (DecisionCandidate has no notes field).
  if (chartGateNote) {
    logger.debug({ symbol, agentKey: agent.agentKey, chartGateNote }, "self-trade: chart gate advisory");
  }
  return result;
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

function candidateToRow(c: DecisionCandidate, cycleId: string, evaluatedAt: Date): NewSelfTradeDecision {
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
    scoreBreakdown: c.scoreBreakdown as unknown as Record<string, unknown>,
    thesis: (c.thesis ?? null) as unknown as Record<string, unknown> | null,
    ownerAgentKey: c.ownerAgentKey,
    conflictState: c.conflictState,
    setupExpiresAt: c.setupExpiresAt ? new Date(c.setupExpiresAt) : null,
    evaluatedAt,
  };
}

async function loadEvaluableAgents(scope?: AgentScope): Promise<
  { agent: SelfTradeAgent; settings: SelfTradeAgentSettings | null; ledger: SelfTradeAgentLedger | null }[]
> {
  // Scope mirrors the read route: USER scope sees only its own agents; admin
  // (no scope) sees the whole fleet.
  const where =
    scope?.ownerType === "USER" && scope.ownerId != null
      ? and(eq(selfTradeAgentsTable.ownerType, "USER"), eq(selfTradeAgentsTable.ownerId, scope.ownerId))
      : scope?.ownerType === "OPERATOR_FLEET"
        ? eq(selfTradeAgentsTable.ownerType, "OPERATOR_FLEET")
        : undefined;

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
    evaluateGovernor().catch((err) => {
      logger.warn({ err }, "self-trade: governor eval failed (degrading to UNKNOWN)");
      return null;
    }),
    runAllHandshakes().catch((err) => {
      logger.warn({ err }, "self-trade: handshake run failed (degrading to UNAVAILABLE)");
      return null;
    }),
  ]);
  const governor: GovernorContext = {
    status: governorEval ? mapGovernorStatus(governorEval.overallStatus) : "UNKNOWN",
    hardBlocks: governorEval ? governorEval.hardBlocks.map((b) => b.code) : [],
  };
  return { governor, handshake: mapHandshakes(handshakeResults) };
}

async function persistCycle(
  cycleId: string,
  supervised: SupervisorResult,
  evaluatedAt: Date,
): Promise<boolean> {
  const { candidates, contendedSymbols, dedupJournal, conflictJournal } = supervised;
  if (candidates.length === 0) return true;
  try {
    await db.transaction(async (tx) => {
      await tx.insert(selfTradeDecisionsTable).values(candidates.map((c) => candidateToRow(c, cycleId, evaluatedAt)));
      await writeSelfTradeAudit(tx, {
        eventType: "DECISION_CYCLE",
        scope: "FLEET",
        severity: contendedSymbols.length > 0 ? "WARNING" : "INFO",
        afterState: {
          cycleId,
          decisions: candidates.length,
          contendedSymbols,
          approved: candidates.filter((c) => c.outcome === "APPROVED" || c.outcome === "APPROVED_REDUCED").length,
          // #18/#19: dedup + opposite-conflict verdicts journaled with reasons
          // (bounded — the opportunity_events log carries the full trail).
          dedupJournal: dedupJournal.slice(0, 20),
          conflictJournal: conflictJournal.slice(0, 20),
        },
        reason: `Self-Trade decision cycle (shadow): ${candidates.length} decisions`,
      });
    });
    return true;
  } catch (err) {
    // Fail-open on persist: a logging failure must not block the decision read.
    logger.error({ err, cycleId }, "self-trade decision cycle persist failed (fail-open)");
    return false;
  }
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
    evaluateGovernor().catch((err) => {
      logger.warn({ err }, "self-trade: governor eval failed (degrading to UNKNOWN)");
      return null;
    }),
    runAllHandshakes().catch((err) => {
      logger.warn({ err }, "self-trade: handshake run failed (degrading to UNAVAILABLE)");
      return null;
    }),
    globalKillEngaged().catch(() => false),
  ]);

  const governor: GovernorContext = {
    status: governorEval ? mapGovernorStatus(governorEval.overallStatus) : "UNKNOWN",
    hardBlocks: governorEval ? governorEval.hardBlocks.map((b) => b.code) : [],
  };
  const handshake = mapHandshakes(handshakeResults);
  if (killEngaged) notes.push("Global Self-Trade kill switch engaged — all decisions blocked.");
  if (governor.status === "UNKNOWN") notes.push("Risk Governor state unavailable — decisions degraded.");
  if (handshakeResults === null) notes.push("Handshake network unavailable — readiness unknown, decisions degraded.");

  // Build candidates (per agent, symbols in parallel; agents sequential to be
  // gentle on upstream providers).
  const allCandidates: DecisionCandidate[] = [];
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
        buildCandidate(agent, settings, ledger, symbol, effectiveUserId, governor, handshake, killEngaged, now).catch(
          (err) => {
            logger.warn({ err, agentKey: agent.agentKey, symbol }, "self-trade: candidate build failed (skipped)");
            return null;
          },
        ),
      ),
    );
    for (const c of candidates) {
      if (c) {
        allCandidates.push(c);
        symbolsEvaluated += 1;
      }
    }
  }

  // nowMs powers the validated opposite-conflict rules (e.g. EXPIRED_OPPONENT).
  const supervised = resolveSupervisor(allCandidates, { nowMs: now });
  // Highest rank first so the feed reads as a priority list.
  supervised.candidates.sort((a, b) => b.rankScore - a.rankScore);

  const evaluatedAt = new Date(now);
  const persisted = await persistCycle(cycleId, supervised, evaluatedAt);

  // Opportunity Spine (#17): feed the owning lifecycle manager at this seam.
  // FAIL-OPEN — a spine failure must never break the decision read path.
  try {
    await ingestDecisionCycle({
      cycleId,
      candidates: supervised.candidates,
      dedupJournal: supervised.dedupJournal,
      conflictJournal: supervised.conflictJournal,
      nowMs: now,
    });
  } catch (err) {
    logger.warn({ err, cycleId }, "opportunity spine ingest failed (fail-open, read path unaffected)");
  }

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
