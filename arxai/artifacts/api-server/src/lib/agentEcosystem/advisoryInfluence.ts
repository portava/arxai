// Agent Ecosystem — Phase 0 advisory influence service (wiring).
//
// Bridges the GLOBAL agent registry (trust + lifecycle + authority) into the
// real read-side surfaces (Scanner ranking, Risk grading, Scalp scoring, Ruby
// wording) via the PURE `computeAgentAdvisory` engine.
//
// SAFETY / SCOPE (inviolable):
//   - ADVISORY ONLY. Adjusts ranking / wording / caution surfaces. NEVER calls
//     placeLiveOrderGuarded, the 16-gate live pipeline, kill switch, allocation
//     or dispatch. It cannot place, modify, or block a trade.
//   - FAIL-OPEN: if the registry can't be read, surfaces return unchanged. The
//     advisory layer must never break or slow scanning / risk / scalp.
//   - PERFORMANT: the registry snapshot is cached (short TTL) so per-symbol
//     scoring is pure math on the hot path — no per-row DB read.
//   - The agent registry is GLOBAL system/governance state, not per-user
//     trading data, so applying it to any user's ranking leaks nothing.

import { db, agentsTable } from "@workspace/db";
import { isNull } from "drizzle-orm";
import {
  computeAgentAdvisory,
  type AdvisoryAgentSnapshot,
  type AdvisoryDirection,
  type AdvisoryResult,
  type AgentAlignment,
  type AgentStance,
} from "@workspace/domain/agent-system";

// ── Registry snapshot cache ────────────────────────────────────────────────

const SNAPSHOT_TTL_MS = 10_000;
let snapshotCache: { at: number; snap: AdvisoryAgentSnapshot[] } | null = null;

export async function getAgentRegistrySnapshot(): Promise<AdvisoryAgentSnapshot[]> {
  const now = Date.now();
  if (snapshotCache && now - snapshotCache.at < SNAPSHOT_TTL_MS) return snapshotCache.snap;
  try {
    const rows = await db
      .select({
        agentKey: agentsTable.agentKey,
        name: agentsTable.name,
        department: agentsTable.department,
        trustScore: agentsTable.trustScore,
        authorityWeight: agentsTable.authorityWeight,
        currentStatus: agentsTable.currentStatus,
      })
      .from(agentsTable)
      .where(isNull(agentsTable.archivedAt));
    const snap: AdvisoryAgentSnapshot[] = rows.map((r) => ({
      agentKey: r.agentKey,
      name: r.name,
      department: r.department,
      trustScore: r.trustScore ?? 50,
      authorityWeight: r.authorityWeight ?? 0,
      currentStatus: r.currentStatus ?? "SHADOW",
    }));
    snapshotCache = { at: now, snap };
    return snap;
  } catch {
    // Fail-open: never break a surface because the registry is unavailable.
    return snapshotCache?.snap ?? [];
  }
}

export function invalidateAgentRegistrySnapshot(): void {
  snapshotCache = null;
}

// ── Generic surface advisory ───────────────────────────────────────────────

export interface SurfaceAdvisoryInput {
  baseScore: number;
  direction: AdvisoryDirection;
  /** Pick relevant agents + how their domain reads this signal. null = exclude. */
  align: (snap: AdvisoryAgentSnapshot) => AgentAlignment | null;
  maxTotalAdjustment?: number;
}

export async function computeSurfaceAdvisory(
  inp: SurfaceAdvisoryInput,
): Promise<AdvisoryResult | null> {
  const all = await getAgentRegistrySnapshot();
  if (all.length === 0) return null;
  const agents: AdvisoryAgentSnapshot[] = [];
  for (const a of all) {
    const alignment = inp.align(a);
    if (alignment === null) continue;
    agents.push({ ...a, alignment });
  }
  if (agents.length === 0) return null;
  return computeAgentAdvisory({
    baseScore: inp.baseScore,
    direction: inp.direction,
    agents,
    maxTotalAdjustment: inp.maxTotalAdjustment,
  });
}

// ── Scanner mapping (department → existing 8-factor scoring) ────────────────

export interface ScannerAdvisoryContext {
  baseScore: number;
  direction: AdvisoryDirection;
  factors: {
    trendAlignment: number; // /15
    supportResistanceQuality: number; // /15
    entryTiming: number; // /15
    riskRewardQuality: number; // /15
    volatilityCondition: number; // /8
    spreadCondition: number; // /10
    strategyMatch: number; // /10
    aiConfidenceCalibration: number; // /10
  };
  riskScore: number; // 0-100 (higher = riskier)
}

/** SUPPORT when the factor is strong, OPPOSE when weak, NEUTRAL in between. */
function alignFromStrength(strength01: number): AgentAlignment {
  if (strength01 >= 0.6) return "SUPPORT";
  if (strength01 <= 0.34) return "OPPOSE";
  return "NEUTRAL";
}

export function scannerAlignment(
  snap: AdvisoryAgentSnapshot,
  ctx: ScannerAdvisoryContext,
): AgentAlignment | null {
  const f = ctx.factors;
  switch (snap.department) {
    case "MARKET_STRUCTURE":
      return alignFromStrength((f.trendAlignment / 15 + f.supportResistanceQuality / 15) / 2);
    case "ENTRY":
      return alignFromStrength(f.entryTiming / 15);
    case "EXECUTION":
      return alignFromStrength(f.spreadCondition / 10);
    case "RISK":
      // Risk reads safety (low risk = support, high risk = push back).
      return alignFromStrength(1 - ctx.riskScore / 100);
    case "SCANNER":
      // Overall opportunity-quality read (shadow until promoted → 0 influence).
      return alignFromStrength(ctx.baseScore / 100);
    default:
      return null; // operations / scalp / exit / review agents don't rank the scanner
  }
}

export async function computeScannerAdvisory(
  ctx: ScannerAdvisoryContext,
): Promise<AdvisoryResult | null> {
  return computeSurfaceAdvisory({
    baseScore: ctx.baseScore,
    direction: ctx.direction,
    align: (snap) => scannerAlignment(snap, ctx),
  });
}

// ── Ruby signal mapping (overall confidence + risk, no per-factor detail) ───

export interface RubySignalContext {
  baseScore: number; // overall confidence 0-100
  direction: AdvisoryDirection;
  confidenceScore: number; // 0-100
  riskScore: number; // 0-100 (higher = riskier)
}

/**
 * Ruby's explain-signal only knows overall confidence + risk (no 8-factor
 * breakdown). Structure / entry / execution / scanner agents read the overall
 * confidence; the Risk agent reads safety (1 - risk). This lets a trusted Risk
 * agent CAUTION/CHALLENGE a confident-looking setup (P0-E), and trusted
 * structure/entry agents reinforce a clean one.
 */
export function rubySignalAlignment(
  snap: AdvisoryAgentSnapshot,
  ctx: RubySignalContext,
): AgentAlignment | null {
  switch (snap.department) {
    case "MARKET_STRUCTURE":
    case "ENTRY":
    case "EXECUTION":
    case "SCANNER":
      return alignFromStrength(ctx.confidenceScore / 100);
    case "RISK":
      return alignFromStrength(1 - ctx.riskScore / 100);
    default:
      return null;
  }
}

export async function computeRubySignalAdvisory(
  ctx: RubySignalContext,
): Promise<AdvisoryResult | null> {
  return computeSurfaceAdvisory({
    baseScore: ctx.baseScore,
    direction: ctx.direction,
    align: (snap) => rubySignalAlignment(snap, ctx),
  });
}

// ── Scalp mapping (SCALP specialist department) ─────────────────────────────

export interface ScalpAdvisoryContext {
  baseScore: number; // flame/scalp quality 0-100
  direction: AdvisoryDirection;
}

/** Only the SCALP specialist re-weights scalp reads. Shadow until promoted. */
export function scalpAlignment(
  snap: AdvisoryAgentSnapshot,
  ctx: ScalpAdvisoryContext,
): AgentAlignment | null {
  if (snap.department !== "SCALP") return null;
  return alignFromStrength(ctx.baseScore / 100);
}

export async function computeScalpAdvisory(
  ctx: ScalpAdvisoryContext,
): Promise<AdvisoryResult | null> {
  return computeSurfaceAdvisory({
    baseScore: ctx.baseScore,
    direction: ctx.direction,
    align: (snap) => scalpAlignment(snap, ctx),
  });
}

// ── User-safe projection (NO internal keys / departments / raw deltas) ──────

export interface UserAgentAdvisory {
  baseScore: number;
  adjustedScore: number;
  netDelta: number;
  influencingAgentCount: number;
  summary: string;
  cautions: string[];
  /** Plain agent name + stance only — never internal keys or raw numbers. */
  agents: { name: string; stance: AgentStance }[];
}

export function toUserAdvisory(result: AdvisoryResult): UserAgentAdvisory {
  return {
    baseScore: result.baseScore,
    adjustedScore: result.adjustedScore,
    netDelta: result.netDelta,
    influencingAgentCount: result.influencingAgentCount,
    summary: result.summary,
    cautions: result.cautions,
    agents: result.contributions
      .filter((c) => Math.abs(c.delta) > 0.5)
      .map((c) => ({ name: c.name, stance: c.stance })),
  };
}

// ── Admin-only influence trace (full breakdown incl. internal keys) ─────────

export interface AdvisoryTraceEntry {
  surface: "SCANNER" | "RISK" | "SCALP";
  symbol: string;
  timeframe: string | null;
  direction: AdvisoryDirection;
  at: string;
  result: AdvisoryResult;
}

const TRACE_CAP = 500;
const traceStore = new Map<string, AdvisoryTraceEntry>();

export function recordAdvisoryTrace(e: AdvisoryTraceEntry): void {
  const key = `${e.surface}:${e.symbol}:${e.timeframe ?? "-"}`;
  traceStore.set(key, e);
  if (traceStore.size > TRACE_CAP) {
    const oldestKey = traceStore.keys().next().value;
    if (oldestKey !== undefined) traceStore.delete(oldestKey);
  }
}

export function getAdvisoryTraces(opts: { surface?: AdvisoryTraceEntry["surface"]; limit?: number } = {}): AdvisoryTraceEntry[] {
  const limit = opts.limit ?? 200;
  let all = [...traceStore.values()];
  if (opts.surface) all = all.filter((e) => e.surface === opts.surface);
  return all.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
