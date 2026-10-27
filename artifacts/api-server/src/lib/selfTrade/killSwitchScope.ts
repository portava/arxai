// Self-Trade AI — kill-switch scope matching (one source of truth).
//
// The pure matcher `evaluateKillSwitchRows` decides whether any ENGAGED row in
// self_trade_kill_switches covers one agent entry. `readKillSwitchVerdict`
// reads the engaged rows through a caller-supplied handle (the pool, or the
// locked entry-authority transaction) and applies the matcher.
//
// SAFETY (inviolable) — the matcher can only ever ADD a refusal:
// - `engaged` is the ONLY truth. engagedAt / releasedAt / updatedAt are audit
//   metadata and never release a switch (the table has no expiry column, so a
//   "future-dated" or "stale" engaged row still blocks).
// - scopeRef values are compared after trimming and upper-casing BOTH sides,
//   so a switch engaged as " eurusd " covers EURUSD. Widening a match can only
//   refuse more, never less.
// - An engaged row the matcher cannot interpret (unknown scope, or an AGENT /
//   STRATEGY / SYMBOL scope with an empty scopeRef) FAILS CLOSED: it blocks
//   every agent entry as KILL_SWITCH_MALFORMED rather than silently matching
//   nothing.
// - A read failure is never swallowed here: the caller's error path must treat
//   it as a refusal (see agentExecutor TOCTOU and the entry-authority claim).
//
// Scope precedence is GLOBAL > NEWS > MALFORMED > AGENT > STRATEGY > SYMBOL.

import { eq, sql } from "drizzle-orm";
import { db, selfTradeKillSwitchesTable } from "@workspace/db";

export interface KillSwitchCheckInput {
  agentKey: string;
  /** Every symbol spelling the entry may trade under (canonical, broker-native). */
  symbol?: string | null;
  symbols?: ReadonlyArray<string | null | undefined>;
  strategy?: string | null;
}

export interface KillSwitchVerdict {
  killed: boolean;
  scope: string | null;
  scopeRef: string | null;
  reason: string | null;
}

export interface KillSwitchRow {
  scope: string | null;
  scopeRef: string | null;
  engaged: boolean | null;
  reason?: string | null;
}

/** Literal block reason for an engaged row the matcher cannot interpret. */
export const KILL_SWITCH_MALFORMED = "KILL_SWITCH_MALFORMED" as const;

/**
 * Advisory-lock key that serializes kill-switch WRITES (exclusive) against the
 * agent-entry final authority claim (shared). An engage that commits first is
 * seen by the claim; a claim that commits first is a completed hand-off.
 * Arbitrary constant; must stay unique among pg_advisory_xact_lock users.
 */
export const KILL_SWITCH_ADVISORY_LOCK_KEY = 213_000_213;

const PRECEDENCE = ["GLOBAL", "NEWS", "MALFORMED", "AGENT", "STRATEGY", "SYMBOL"] as const;

export const NOT_KILLED: KillSwitchVerdict = Object.freeze({
  killed: false,
  scope: null,
  scopeRef: null,
  reason: null,
}) as KillSwitchVerdict;

/** Trim + upper-case; anything that is not a non-empty string → null. */
export function normalizeKillRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toUpperCase();
  return v.length > 0 ? v : null;
}

function rank(scope: string): number {
  const i = PRECEDENCE.indexOf(scope as (typeof PRECEDENCE)[number]);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

/** Pure: the highest-precedence engaged row covering this entry, or NOT_KILLED. */
export function evaluateKillSwitchRows(
  rows: ReadonlyArray<KillSwitchRow>,
  input: KillSwitchCheckInput,
): KillSwitchVerdict {
  const agent = normalizeKillRef(input.agentKey);
  const strategy = normalizeKillRef(input.strategy);
  const symbols = new Set(
    [input.symbol, ...(input.symbols ?? [])]
      .map(normalizeKillRef)
      .filter((s): s is string => s != null),
  );

  let best: { rank: number; verdict: KillSwitchVerdict } | null = null;
  for (const r of rows) {
    if (r.engaged !== true) continue;
    const scope = normalizeKillRef(r.scope);
    const ref = normalizeKillRef(r.scopeRef);
    let effective: string | null = null;
    switch (scope) {
      case "GLOBAL":
      case "NEWS":
        effective = scope; // scopeRef is ignored — these always cover.
        break;
      case "AGENT":
        effective = ref == null ? "MALFORMED" : agent != null && ref === agent ? scope : null;
        break;
      case "STRATEGY":
        effective = ref == null ? "MALFORMED" : strategy != null && ref === strategy ? scope : null;
        break;
      case "SYMBOL":
        effective = ref == null ? "MALFORMED" : symbols.has(ref) ? scope : null;
        break;
      default:
        effective = "MALFORMED"; // unknown / null scope on an ENGAGED row.
    }
    if (effective == null) continue;
    const verdict: KillSwitchVerdict =
      effective === "MALFORMED"
        ? {
            killed: true,
            scope: KILL_SWITCH_MALFORMED,
            scopeRef: r.scopeRef ?? null,
            reason: `${KILL_SWITCH_MALFORMED}: engaged row scope=${JSON.stringify(r.scope)} scopeRef=${JSON.stringify(r.scopeRef)} cannot be interpreted; refusing (fail closed)`,
          }
        : {
            killed: true,
            scope: effective,
            scopeRef: r.scopeRef ?? null,
            reason: r.reason ?? `${effective} kill switch engaged`,
          };
    const k = rank(effective);
    if (best === null || k < best.rank) best = { rank: k, verdict };
  }
  return best?.verdict ?? NOT_KILLED;
}

type KillReader = Pick<typeof db, "select">;

/** Read engaged rows through `database` (pool or transaction) and match them. */
export async function readKillSwitchVerdict(
  input: KillSwitchCheckInput,
  database: KillReader = db,
): Promise<KillSwitchVerdict> {
  const rows = await database
    .select({
      scope: selfTradeKillSwitchesTable.scope,
      scopeRef: selfTradeKillSwitchesTable.scopeRef,
      engaged: selfTradeKillSwitchesTable.engaged,
      reason: selfTradeKillSwitchesTable.reason,
    })
    .from(selfTradeKillSwitchesTable)
    .where(eq(selfTradeKillSwitchesTable.engaged, true));
  return evaluateKillSwitchRows(rows, input);
}

type LockingTx = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

/** Shared side: taken by the final agent-entry claim before it reads switches. */
export async function lockKillSwitchesShared(tx: LockingTx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(${KILL_SWITCH_ADVISORY_LOCK_KEY})`);
}

/** Exclusive side: taken by every kill-switch write (engage or release). */
export async function lockKillSwitchesExclusive(tx: LockingTx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${KILL_SWITCH_ADVISORY_LOCK_KEY})`);
}
