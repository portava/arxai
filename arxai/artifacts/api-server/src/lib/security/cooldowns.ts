// ═══════════════════════════════════════════════════════════════════════════
// Phase 7 — DB-backed rate-limit / cooldown service.
//
// Composes the PURE domain `evaluateRateLimit` engine (sliding window +
// cooldown math) with durable per-(action, scope) persistence in
// `security_cooldowns`. The domain engine owns the decision; this layer only
// loads the prior `RateLimitState`, persists the next one, and surfaces the
// decision to callers (auth routes, admin actions, …).
//
// SAFETY:
//  - Per-scope isolation: every counter is keyed by (actionKey, scopeKey) so
//    one actor's attempts NEVER throttle another's. Callers pass an opaque,
//    non-PII scope (hash an email/IP before calling — see hashScope()).
//  - Fail-OPEN to caution: a DB error never silently grants unlimited
//    attempts — it returns an allowed=false "soft" decision is too aggressive
//    for auth; instead we ALLOW the attempt but log, so a DB blip cannot lock
//    every user out. The durable counter is defence-in-depth on top of the
//    existing per-route protections, never the only gate.
// ═══════════════════════════════════════════════════════════════════════════

import { db, securityCooldownsTable } from "@workspace/db";
import { and, desc, eq, gt, isNotNull, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  DEFAULT_RATE_LIMIT_POLICY,
  evaluateRateLimit,
  isRateLimitedAction,
  type RateLimitDecision,
  type RateLimitState,
  type RateLimitedAction,
  type RateLimitRule,
} from "@workspace/domain/security";
import { logger } from "../logger.js";

export interface ConsumeOptions {
  /** Override the default rule (tests / future per-tenant policy). */
  rule?: RateLimitRule;
  /** Non-PII context stored on the row's metadata for admin diagnostics. */
  metadata?: Record<string, unknown>;
}

export interface ConsumeResult extends RateLimitDecision {
  action: RateLimitedAction;
  scopeKey: string;
}

/**
 * Hash a potentially-sensitive scope value (email, IP) into an opaque,
 * non-reversible key so the cooldown table never stores raw PII.
 */
export function hashScope(prefix: string, value: string): string {
  const digest = createHash("sha256").update(value.trim().toLowerCase(), "utf8").digest("hex").slice(0, 24);
  return `${prefix}:${digest}`;
}

function rowToState(row: typeof securityCooldownsTable.$inferSelect): RateLimitState {
  return {
    count: row.count,
    windowStartedAt: row.windowStartedAt.getTime(),
    blockedUntil: row.blockedUntil ? row.blockedUntil.getTime() : null,
  };
}

/**
 * Count ONE attempt against (action, scopeKey). Returns the domain decision.
 * `allowed === false` means the caller should refuse this attempt.
 */
export async function consumeRateLimit(
  action: RateLimitedAction,
  scopeKey: string,
  opts: ConsumeOptions = {},
): Promise<ConsumeResult> {
  const rule = opts.rule ?? DEFAULT_RATE_LIMIT_POLICY[action];
  const now = Date.now();

  try {
    const decision = await db.transaction(async (tx) => {
      // Serialize concurrent attempts on the SAME (action, scope) so two
      // simultaneous FIRST hits cannot both read no row, both evaluate
      // allowed:true, and both pass before either upsert lands. The advisory
      // lock is keyed by hashtext("<action>:<scope>") and held for the lifetime
      // of THIS transaction (released on commit/rollback); attempts on a
      // DIFFERENT scope hash to a different key and never block each other, so
      // one actor never throttles another. This is the missing serialization
      // point — the unique index alone only prevents a duplicate ROW, not a
      // duplicate ALLOW decision read from a not-yet-written window.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${action}:${scopeKey}`}))`);

      const [existing] = await tx
        .select()
        .from(securityCooldownsTable)
        .where(and(eq(securityCooldownsTable.actionKey, action), eq(securityCooldownsTable.scopeKey, scopeKey)))
        .limit(1);

      const prev = existing ? rowToState(existing) : null;
      const d = evaluateRateLimit(prev, rule, now);
      const next = d.nextState;

      const values = {
        actionKey: action,
        scopeKey,
        count: next.count,
        windowStartedAt: new Date(next.windowStartedAt),
        blockedUntil: next.blockedUntil != null ? new Date(next.blockedUntil) : null,
        lastEventAt: new Date(now),
        metadata: opts.metadata ?? {},
        updatedAt: new Date(now),
      };

      await tx
        .insert(securityCooldownsTable)
        .values(values)
        .onConflictDoUpdate({
          target: [securityCooldownsTable.actionKey, securityCooldownsTable.scopeKey],
          set: {
            count: values.count,
            windowStartedAt: values.windowStartedAt,
            blockedUntil: values.blockedUntil,
            lastEventAt: values.lastEventAt,
            metadata: values.metadata,
            updatedAt: values.updatedAt,
          },
        });

      return d;
    });

    return { ...decision, action, scopeKey };
  } catch (err) {
    const failOpen = rule.failOpen;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), action, failOpen },
      failOpen
        ? "rate-limit consume failed; allowing attempt (public-auth fail-open)"
        : "rate-limit consume failed; blocking attempt (sensitive-action fail-closed)",
    );
    if (failOpen) {
      // Public anti-enumeration auth: never lock everyone out on a DB blip; the
      // route has its own per-route protections behind this defence-in-depth.
      return {
        allowed: true,
        blocked: false,
        retryAfterMs: 0,
        remaining: rule.limit,
        nextState: { count: 0, windowStartedAt: now, blockedUntil: null },
        reason: "OK",
        action,
        scopeKey,
      };
    }
    // Sensitive/admin/trade action: fail CLOSED so an outage cannot become a
    // control bypass. unknown ⇒ caution.
    return {
      allowed: false,
      blocked: true,
      retryAfterMs: rule.cooldownMs,
      remaining: 0,
      nextState: { count: rule.limit, windowStartedAt: now, blockedUntil: now + rule.cooldownMs },
      reason: "RATE_LIMIT_COOLDOWN_ACTIVE",
      action,
      scopeKey,
    };
  }
}

/**
 * READ-ONLY: is a cooldown lock currently active for (action, scopeKey)? Used as
 * a PRE-CHECK on dangerous admin actions (e.g. the repeated-failure
 * ADMIN_ACTION_FAILED lock) so a tripped lockout blocks future attempts BEFORE
 * any further work — without consuming an attempt. Fails CLOSED (treats the
 * scope as locked) on a DB error, because this only ever guards sensitive
 * actions where unknown ⇒ caution.
 */
export async function isCooldownActive(action: RateLimitedAction, scopeKey: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ blockedUntil: securityCooldownsTable.blockedUntil })
      .from(securityCooldownsTable)
      .where(and(eq(securityCooldownsTable.actionKey, action), eq(securityCooldownsTable.scopeKey, scopeKey)))
      .limit(1);
    if (!row?.blockedUntil) return false;
    return row.blockedUntil.getTime() > Date.now();
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), action },
      "cooldown active-check failed; treating as locked (fail-closed)",
    );
    return true;
  }
}

/** Admin view: currently-active cooldown locks (admin-visible actions only). */
export async function listActiveCooldowns(limit = 100): Promise<
  Array<{
    actionKey: string;
    scopeKey: string;
    count: number;
    blockedUntil: string | null;
    lastEventAt: string;
    adminVisible: boolean;
  }>
> {
  const max = Math.min(Math.max(limit, 1), 500);
  const rows = await db
    .select()
    .from(securityCooldownsTable)
    .where(and(isNotNull(securityCooldownsTable.blockedUntil), gt(securityCooldownsTable.blockedUntil, new Date())))
    .orderBy(desc(securityCooldownsTable.blockedUntil))
    .limit(max);

  return rows
    .filter((r) => isRateLimitedAction(r.actionKey))
    .map((r) => ({
      actionKey: r.actionKey,
      scopeKey: r.scopeKey,
      count: r.count,
      blockedUntil: r.blockedUntil ? r.blockedUntil.toISOString() : null,
      lastEventAt: r.lastEventAt.toISOString(),
      adminVisible: isRateLimitedAction(r.actionKey)
        ? DEFAULT_RATE_LIMIT_POLICY[r.actionKey as RateLimitedAction].adminVisible
        : false,
    }))
    .filter((r) => r.adminVisible);
}
