// Learning memory with scopes — the one owner of strategy_edges and
// mistake_patterns (Tier 1 finalization, item 8).
//
// Every trade outcome teaches three kinds of memory, never one global pool:
//   user      — the trader's own edges and mistakes; only they read them;
//   scoped    — strategy / account / broker / instrument / portfolio memory
//               owned by the same trader, keyed by scope_key;
//   platform  — an anonymized aggregate across traders: no owner, no trade
//               id, and traders only read a cohort once at least
//               PLATFORM_MIN_CONTRIBUTORS distinct traders stand behind it.
// Legacy rows written before scopes existed have unknown contributors and
// stay visible to operators only.
//
// Learning informs scoring, never permission: nothing here can relax a Risk
// Governor rule (ci guard learning-memory-single-owner keeps every read and
// write in this file).

import { and, desc, eq, gte, inArray, isNotNull, ne, type SQL } from "drizzle-orm";
import { db, mistakePatternsTable, strategyEdgesTable, type MistakePattern, type StrategyEdge } from "@workspace/db";

export const OWNED_SCOPE_TYPES = ["strategy", "account", "broker", "instrument", "portfolio"] as const;
export type OwnedScopeType = (typeof OWNED_SCOPE_TYPES)[number];
export type LearningScopeType = "user" | OwnedScopeType | "platform";
export interface OwnedScope { type: OwnedScopeType; key: string }

/** Distinct traders a platform cohort needs before traders may read it. */
export const PLATFORM_MIN_CONTRIBUTORS = 3;

// Bounds (design contract of the learning engine).
export const EDGE_MIN = -100;
export const EDGE_MAX = 100;
export const CONF_ADJ_MIN = -15;
export const CONF_ADJ_MAX = 15;
export const RISK_ADJ_MIN = -15;
export const RISK_ADJ_MAX = 15;
export const SEVERITY_MAX = 100;
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface ScopeRef { scopeType: LearningScopeType; scopeOwner: number; scopeKey: string }
const USER = (owner: number): ScopeRef => ({ scopeType: "user", scopeOwner: owner, scopeKey: "" });
const PLATFORM: ScopeRef = { scopeType: "platform", scopeOwner: 0, scopeKey: "" };

function cleanScopes(scopes: OwnedScope[] | undefined, owner: number): ScopeRef[] {
  const seen = new Set<string>();
  const out: ScopeRef[] = [];
  for (const s of scopes ?? []) {
    const key = String(s.key ?? "").trim().slice(0, 120);
    if (!OWNED_SCOPE_TYPES.includes(s.type) || !key || seen.has(`${s.type}:${key}`)) continue;
    seen.add(`${s.type}:${key}`);
    out.push({ scopeType: s.type, scopeOwner: owner, scopeKey: key });
  }
  return out;
}

// ── Writes ────────────────────────────────────────────────────────────────

export interface EdgeOutcome {
  symbol: string; signalName: string; action: string; result: string; pnl: number; tradeId: number;
  deltaEdge: number; deltaConf: number; deltaRisk: number;
}

async function applyEdge(ref: ScopeRef, o: EdgeOutcome, contributorJoined: boolean): Promise<{ row: StrategyEdge; created: boolean }> {
  const where = and(
    eq(strategyEdgesTable.scopeType, ref.scopeType), eq(strategyEdgesTable.scopeOwner, ref.scopeOwner),
    eq(strategyEdgesTable.scopeKey, ref.scopeKey), eq(strategyEdgesTable.symbol, o.symbol),
    eq(strategyEdgesTable.signalName, o.signalName), eq(strategyEdgesTable.action, o.action),
  );
  const existing = (await db.select().from(strategyEdgesTable).where(where).limit(1))[0];
  const isWin = o.result === "WIN";
  const isLoss = o.result === "LOSS";
  const isBE = o.result === "BREAKEVEN" || o.result === "BREAK_EVEN";
  const platform = ref.scopeType === "platform";
  const tradeId = platform ? null : o.tradeId;

  if (!existing) {
    const [row] = await db.insert(strategyEdgesTable).values({
      ...ref,
      userId: platform ? null : ref.scopeOwner,
      contributors: platform ? 1 : null,
      symbol: o.symbol, strategyName: o.signalName, signalName: o.signalName, action: o.action,
      sampleCount: 1, winCount: isWin ? 1 : 0, lossCount: isLoss ? 1 : 0, breakEvenCount: isBE ? 1 : 0,
      netPnl: o.pnl, avgPnl: o.pnl,
      confidenceAdjustment: clamp(o.deltaConf, CONF_ADJ_MIN, CONF_ADJ_MAX),
      riskAdjustment: clamp(o.deltaRisk, RISK_ADJ_MIN, RISK_ADJ_MAX),
      edgeScore: clamp(o.deltaEdge, EDGE_MIN, EDGE_MAX),
      lastResult: o.result, lastTradeId: tradeId,
    }).returning();
    return { row: row!, created: true };
  }
  const sampleCount = existing.sampleCount + 1;
  const netPnl = existing.netPnl + o.pnl;
  const [row] = await db.update(strategyEdgesTable).set({
    sampleCount,
    winCount: existing.winCount + (isWin ? 1 : 0),
    lossCount: existing.lossCount + (isLoss ? 1 : 0),
    breakEvenCount: existing.breakEvenCount + (isBE ? 1 : 0),
    netPnl, avgPnl: netPnl / sampleCount,
    confidenceAdjustment: clamp(existing.confidenceAdjustment + o.deltaConf, CONF_ADJ_MIN, CONF_ADJ_MAX),
    riskAdjustment: clamp(existing.riskAdjustment + o.deltaRisk, RISK_ADJ_MIN, RISK_ADJ_MAX),
    edgeScore: clamp(existing.edgeScore + o.deltaEdge, EDGE_MIN, EDGE_MAX),
    lastResult: o.result, lastTradeId: tradeId,
    ...(platform && contributorJoined && existing.contributors != null ? { contributors: existing.contributors + 1 } : {}),
    updatedAt: new Date(),
  }).where(eq(strategyEdgesTable.id, existing.id)).returning();
  return { row: row!, created: false };
}

/**
 * Teach one signal's outcome to the trader's memory, their scoped memories
 * and the anonymized platform aggregate. Returns the trader's own row.
 * `share: false` (an outcome no real debrief backs) teaches the private
 * memory only, so nobody can feed other traders fabricated outcomes.
 */
export async function recordEdgeOutcome(ownerUserId: number, o: EdgeOutcome, scopes?: OwnedScope[], share = true): Promise<StrategyEdge> {
  const own = await applyEdge(USER(ownerUserId), o, false);
  if (!share) return own.row;
  for (const ref of cleanScopes(scopes, ownerUserId)) await applyEdge(ref, o, false);
  await applyEdge(PLATFORM, o, own.created);
  return own.row;
}

export interface MistakeOutcome { tag: string; symbol: string; action: string; isLoss: boolean; tradeId: number; guardrail: string }

async function applyMistake(ref: ScopeRef, o: MistakeOutcome, contributorJoined: boolean): Promise<{ row: MistakePattern; created: boolean }> {
  const where = and(
    eq(mistakePatternsTable.scopeType, ref.scopeType), eq(mistakePatternsTable.scopeOwner, ref.scopeOwner),
    eq(mistakePatternsTable.scopeKey, ref.scopeKey), eq(mistakePatternsTable.tag, o.tag),
    eq(mistakePatternsTable.symbol, o.symbol), eq(mistakePatternsTable.action, o.action),
  );
  const existing = (await db.select().from(mistakePatternsTable).where(where).limit(1))[0];
  const sevDelta = o.isLoss ? 8 : 2;
  const platform = ref.scopeType === "platform";
  const tradeId = platform ? null : o.tradeId;
  if (!existing) {
    const [row] = await db.insert(mistakePatternsTable).values({
      ...ref,
      userId: platform ? null : ref.scopeOwner,
      contributors: platform ? 1 : null,
      tag: o.tag, symbol: o.symbol, action: o.action, count: 1, lastTradeId: tradeId,
      severityScore: clamp(sevDelta, 0, SEVERITY_MAX), recommendedGuardrail: o.guardrail,
    }).returning();
    return { row: row!, created: true };
  }
  const [row] = await db.update(mistakePatternsTable).set({
    count: existing.count + 1,
    severityScore: clamp(existing.severityScore + sevDelta, 0, SEVERITY_MAX),
    lastTradeId: tradeId,
    recommendedGuardrail: o.guardrail || existing.recommendedGuardrail,
    ...(platform && contributorJoined && existing.contributors != null ? { contributors: existing.contributors + 1 } : {}),
    updatedAt: new Date(),
  }).where(eq(mistakePatternsTable.id, existing.id)).returning();
  return { row: row!, created: false };
}

/** Teach one mistake tag to the trader's memory, their scoped memories and the platform aggregate (see `share` above). */
export async function recordMistakeOutcome(ownerUserId: number, o: MistakeOutcome, scopes?: OwnedScope[], share = true): Promise<MistakePattern> {
  const own = await applyMistake(USER(ownerUserId), o, false);
  if (!share) return own.row;
  for (const ref of cleanScopes(scopes, ownerUserId)) await applyMistake(ref, o, false);
  await applyMistake(PLATFORM, o, own.created);
  return own.row;
}

// ── Reads ─────────────────────────────────────────────────────────────────

export interface MemoryFilter { symbol?: string; action?: string; limit?: number }

/** A platform row as traders see it: no owner, no trade id. */
export type AnonymizedEdge = Omit<StrategyEdge, "userId" | "lastTradeId" | "scopeOwner">;
export type AnonymizedMistake = Omit<MistakePattern, "userId" | "lastTradeId" | "scopeOwner">;

function anonymize<T extends { userId: number | null; lastTradeId: number | null; scopeOwner: number }>(r: T): Omit<T, "userId" | "lastTradeId" | "scopeOwner"> {
  const { userId: _u, lastTradeId: _t, scopeOwner: _o, ...rest } = r;
  return rest;
}

function edgeFilter(f: MemoryFilter): SQL[] {
  const c: SQL[] = [];
  if (f.symbol) c.push(eq(strategyEdgesTable.symbol, f.symbol));
  if (f.action) c.push(eq(strategyEdgesTable.action, f.action));
  return c;
}
function mistakeFilter(f: MemoryFilter): SQL[] {
  const c: SQL[] = [];
  if (f.symbol) c.push(eq(mistakePatternsTable.symbol, f.symbol));
  if (f.action) c.push(eq(mistakePatternsTable.action, f.action));
  return c;
}

/** The trader's own memory: user scope by default, or the scoped kinds named. */
export async function listOwnEdges(userId: number, f: MemoryFilter & { scopeTypes?: Array<"user" | OwnedScopeType> } = {}): Promise<StrategyEdge[]> {
  const q = db.select().from(strategyEdgesTable).where(and(
    eq(strategyEdgesTable.scopeOwner, userId), ne(strategyEdgesTable.scopeType, "platform"),
    inArray(strategyEdgesTable.scopeType, f.scopeTypes ?? ["user"]), ...edgeFilter(f),
  )).orderBy(desc(strategyEdgesTable.updatedAt));
  return f.limit != null ? q.limit(f.limit) : q;
}

export async function listOwnMistakes(userId: number, f: MemoryFilter & { scopeTypes?: Array<"user" | OwnedScopeType> } = {}): Promise<MistakePattern[]> {
  const q = db.select().from(mistakePatternsTable).where(and(
    eq(mistakePatternsTable.scopeOwner, userId), ne(mistakePatternsTable.scopeType, "platform"),
    inArray(mistakePatternsTable.scopeType, f.scopeTypes ?? ["user"]), ...mistakeFilter(f),
  )).orderBy(desc(mistakePatternsTable.severityScore));
  return f.limit != null ? q.limit(f.limit) : q;
}

/** Anonymized platform memory, only cohorts with enough distinct traders behind them. */
export async function listPlatformEdges(f: MemoryFilter = {}): Promise<AnonymizedEdge[]> {
  const q = db.select().from(strategyEdgesTable).where(and(
    eq(strategyEdgesTable.scopeType, "platform"), isNotNull(strategyEdgesTable.contributors),
    gte(strategyEdgesTable.contributors, PLATFORM_MIN_CONTRIBUTORS), ...edgeFilter(f),
  )).orderBy(desc(strategyEdgesTable.updatedAt));
  return (f.limit != null ? await q.limit(f.limit) : await q).map(anonymize);
}

export async function listPlatformMistakes(f: MemoryFilter = {}): Promise<AnonymizedMistake[]> {
  const q = db.select().from(mistakePatternsTable).where(and(
    eq(mistakePatternsTable.scopeType, "platform"), isNotNull(mistakePatternsTable.contributors),
    gte(mistakePatternsTable.contributors, PLATFORM_MIN_CONTRIBUTORS), ...mistakeFilter(f),
  )).orderBy(desc(mistakePatternsTable.severityScore));
  return (f.limit != null ? await q.limit(f.limit) : await q).map(anonymize);
}

/** Operator view across every scope, legacy rows included. */
export async function listEdgesForOperator(f: MemoryFilter & { scopeType?: LearningScopeType } = {}): Promise<StrategyEdge[]> {
  const c = edgeFilter(f);
  if (f.scopeType) c.push(eq(strategyEdgesTable.scopeType, f.scopeType));
  return db.select().from(strategyEdgesTable).where(c.length ? and(...c) : undefined)
    .orderBy(desc(strategyEdgesTable.updatedAt)).limit(f.limit ?? 100);
}

export async function listMistakesForOperator(f: MemoryFilter & { scopeType?: LearningScopeType } = {}): Promise<MistakePattern[]> {
  const c = mistakeFilter(f);
  if (f.scopeType) c.push(eq(mistakePatternsTable.scopeType, f.scopeType));
  return db.select().from(mistakePatternsTable).where(c.length ? and(...c) : undefined)
    .orderBy(desc(mistakePatternsTable.severityScore)).limit(f.limit ?? 100);
}
