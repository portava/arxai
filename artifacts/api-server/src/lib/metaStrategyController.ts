// ── #16 Meta-Strategy Controller — continuous strategy eligibility service ───
//
// WHY THIS EXISTS: the strategy-lifecycle FSM, promotion/demotion engines and
// the shadow-mode tournament all existed as request-driven pure pieces — no
// single service continuously flipped certified strategies between
// enable / reduce / prepare / shadow / disable from live evidence. This worker
// is that controller: per tick it derives per-strategy evidence from the
// PERSISTED shadow record, decides a target posture, and applies it.
//
// AUTHORITY DIRECTION (inviolable):
//   * AUTO ONLY EVER REDUCES. The controller may automatically move a
//     strategy toward LESS authority (enable → reduce → prepare → shadow →
//     disable). A target with MORE authority than the current posture is
//     RECORDED as a recommendation and REFUSED — enabling/promoting stays
//     behind the existing owner-gated promotion machinery (shadowMode.promote
//     and the mission promotion service). This file never calls promote()
//     (pinned by the qa source test).
//   * Reductions are mirrored into the existing shadow-mode registry via its
//     own demote() seam — no parallel enforcement path is invented; nothing
//     here touches execution (shadow decisions are observations by
//     construction, and live strategy selection consults its own gates).
//   * State persistence is change-only with journaled reasons: an unchanged
//     posture writes nothing.
//   * FAIL SAFE: each strategy is evaluated in its own try/catch; an error
//     skips that strategy (posture untouched) and the next tick retries.
import { and, eq, gte, isNotNull } from "drizzle-orm";
import {
  db,
  shadowPredictionsTable,
  metaStrategyStatesTable,
  type MetaStrategyStateRow,
} from "@workspace/db";
import { demote, type DemotionLevel } from "./shadowMode.js";
import { logger } from "./logger.js";

export const META_STRATEGY_INTERVAL_MS = 5 * 60 * 1000;
export const META_STRATEGY_EVIDENCE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
/** Evidence older than this cannot justify authority — the strategy falls
 *  back to shadow until fresh evidence exists. */
export const META_STRATEGY_EVIDENCE_STALE_MS = 48 * 60 * 60 * 1000;
export const META_STRATEGY_MIN_SAMPLE = 20;

const DISABLE_VALUES = new Set(["0", "false", "off", "no"]);

/** PURE — is the meta-strategy controller enabled? Absent env = ENABLED. */
export function metaStrategyEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  return !DISABLE_VALUES.has(raw.trim().toLowerCase());
}

// ── Pure decision core (DB-free, unit + property tested) ────────────────────

export type MetaStrategyState = "disable" | "shadow" | "prepare" | "reduce" | "enable";

const STATE_AUTHORITY_RANK: Record<MetaStrategyState, number> = {
  disable: 0,
  shadow: 1,
  prepare: 2,
  reduce: 3,
  enable: 4,
};

export function metaStateAuthorityRank(s: MetaStrategyState): number {
  return STATE_AUTHORITY_RANK[s];
}

export function isMetaStrategyState(s: string): s is MetaStrategyState {
  return s === "disable" || s === "shadow" || s === "prepare" || s === "reduce" || s === "enable";
}

export interface StrategyEvidence {
  strategy: string;
  sample: number;          // resolved shadow decisions in the lookback
  winRate01: number;       // wins / (wins + losses); 0 when no tracked outcomes
  netEdgeR: number;        // sum of pnlR over resolved decisions
  evidenceAgeMs: number;   // now − newest resolved decision (Infinity when none)
  rgViolations: number;    // decisions the risk governor refused
}

export interface MetaStrategyDecision {
  target: MetaStrategyState;
  reasons: string[];
}

/**
 * PURE — decide the evidence-justified posture. Conservative by construction:
 * insufficient or stale evidence never yields authority; the enable verdict
 * is only ever a RECOMMENDATION (the transition function refuses to apply it
 * automatically).
 */
export function decideMetaStrategyState(e: StrategyEvidence): MetaStrategyDecision {
  const reasons: string[] = [];
  if (e.sample < META_STRATEGY_MIN_SAMPLE) {
    reasons.push(`sample ${e.sample} < ${META_STRATEGY_MIN_SAMPLE} — insufficient evidence keeps the strategy in shadow`);
    return { target: "shadow", reasons };
  }
  if (e.evidenceAgeMs > META_STRATEGY_EVIDENCE_STALE_MS) {
    reasons.push(`evidence is ${Math.round(e.evidenceAgeMs / 3_600_000)}h old (> ${META_STRATEGY_EVIDENCE_STALE_MS / 3_600_000}h) — stale evidence cannot justify authority`);
    return { target: "shadow", reasons };
  }
  if (e.winRate01 < 0.35 || e.netEdgeR <= -5) {
    reasons.push(`hard underperformance (winRate ${(e.winRate01 * 100).toFixed(0)}%, net ${e.netEdgeR.toFixed(2)}R) — disable`);
    return { target: "disable", reasons };
  }
  if (e.netEdgeR < 0) {
    reasons.push(`negative net edge ${e.netEdgeR.toFixed(2)}R — reduce`);
    return { target: "reduce", reasons };
  }
  if (e.rgViolations >= 5) {
    reasons.push(`${e.rgViolations} risk-governor refusals in window — reduce`);
    return { target: "reduce", reasons };
  }
  if (e.winRate01 >= 0.5 && e.netEdgeR > 0) {
    reasons.push(`positive evidence (winRate ${(e.winRate01 * 100).toFixed(0)}%, net +${e.netEdgeR.toFixed(2)}R) — enable is JUSTIFIED but only ever applied via the owner-gated promotion machinery`);
    return { target: "enable", reasons };
  }
  reasons.push(`mixed evidence (winRate ${(e.winRate01 * 100).toFixed(0)}%, net ${e.netEdgeR.toFixed(2)}R) — prepare (watch, no added authority)`);
  return { target: "prepare", reasons };
}

export interface MetaTransition {
  appliedState: MetaStrategyState;
  recommendedState: MetaStrategyState | null;
  changed: boolean;
  refusedPromotion: boolean;
  reasons: string[];
}

/**
 * PURE — the tighten-only transition function. target with LESS authority is
 * applied; MORE authority is refused and recorded as a recommendation. This
 * is the property the authority-direction tests pin: for every (current,
 * target), rank(applied) ≤ rank(current).
 */
export function applyAutoTransition(
  current: MetaStrategyState,
  decision: MetaStrategyDecision,
): MetaTransition {
  const target = decision.target;
  if (metaStateAuthorityRank(target) < metaStateAuthorityRank(current)) {
    return {
      appliedState: target,
      recommendedState: null,
      changed: true,
      refusedPromotion: false,
      reasons: [...decision.reasons, `auto-applied reduction ${current} → ${target}`],
    };
  }
  if (metaStateAuthorityRank(target) > metaStateAuthorityRank(current)) {
    return {
      appliedState: current,
      recommendedState: target,
      changed: false,
      refusedPromotion: true,
      reasons: [
        ...decision.reasons,
        `auto-promotion ${current} → ${target} REFUSED — more authority requires the existing owner-gated promotion machinery (owner press)`,
      ],
    };
  }
  return {
    appliedState: current,
    recommendedState: null,
    changed: false,
    refusedPromotion: false,
    reasons: decision.reasons,
  };
}

/** Reductions are mirrored into the existing shadow-mode registry via its own
 *  demote() seam (auto-demotion is the allowed direction). */
export function demotionLevelFor(state: MetaStrategyState): DemotionLevel | null {
  switch (state) {
    case "disable": return "PAUSED";
    case "shadow":  return "WATCHLIST";
    case "reduce":  return "NEEDS_REVIEW";
    case "prepare":
    case "enable":  return null;
  }
}

// ── Pass ────────────────────────────────────────────────────────────────────

export interface MetaStrategyPassResult {
  strategiesEvaluated: number;
  reduced: number;
  promotionsRefused: number;
  errors: number;
}

export async function runMetaStrategyPass(
  opts: { nowMs?: number } = {},
): Promise<MetaStrategyPassResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const since = new Date(nowMs - META_STRATEGY_EVIDENCE_LOOKBACK_MS);

  // Evidence source: PERSISTED resolved shadow decisions (never the in-memory
  // map — a restart must not erase the controller's evidence base).
  const rows = await db
    .select({
      strategy: shadowPredictionsTable.strategy,
      status: shadowPredictionsTable.status,
      pnlR: shadowPredictionsTable.pnlR,
      rgApproved: shadowPredictionsTable.rgApproved,
      resolvedAt: shadowPredictionsTable.resolvedAt,
    })
    .from(shadowPredictionsTable)
    .where(and(isNotNull(shadowPredictionsTable.resolvedAt), gte(shadowPredictionsTable.resolvedAt, since)))
    .limit(10_000);

  const byStrategy = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.strategy.trim();
    if (key.length === 0) continue;
    const arr = byStrategy.get(key) ?? [];
    arr.push(r);
    byStrategy.set(key, arr);
  }

  // Also re-evaluate strategies with a persisted posture but no fresh rows
  // (their evidence has gone stale — that is itself a reduction signal).
  const knownRows = await db.select().from(metaStrategyStatesTable).limit(500);
  for (const k of knownRows) {
    if (!byStrategy.has(k.strategy)) byStrategy.set(k.strategy, []);
  }
  const knownByStrategy = new Map<string, MetaStrategyStateRow>(knownRows.map((k) => [k.strategy, k]));

  let reduced = 0;
  let promotionsRefused = 0;
  let errors = 0;

  for (const [strategy, decisions] of byStrategy) {
    try {
      const tracked = decisions.filter((d) => d.status === "SHADOW_WIN" || d.status === "SHADOW_LOSS");
      const wins = tracked.filter((d) => d.status === "SHADOW_WIN").length;
      const newestResolvedMs = decisions.reduce(
        (max, d) => Math.max(max, d.resolvedAt ? d.resolvedAt.getTime() : 0),
        0,
      );
      const evidence: StrategyEvidence = {
        strategy,
        sample: decisions.length,
        winRate01: tracked.length > 0 ? wins / tracked.length : 0,
        netEdgeR: decisions.reduce((s, d) => s + (d.pnlR ?? 0), 0),
        evidenceAgeMs: newestResolvedMs > 0 ? nowMs - newestResolvedMs : Number.POSITIVE_INFINITY,
        rgViolations: decisions.filter((d) => d.rgApproved === false).length,
      };

      const existing = knownByStrategy.get(strategy) ?? null;
      const current: MetaStrategyState =
        existing && isMetaStrategyState(existing.appliedState) ? existing.appliedState : "shadow";
      const decision = decideMetaStrategyState(evidence);
      const transition = applyAutoTransition(current, decision);
      if (transition.refusedPromotion) promotionsRefused += 1;

      // Change-only persistence: write only when posture or recommendation moved.
      const recommendationChanged =
        (existing?.recommendedState ?? null) !== transition.recommendedState;
      if (transition.changed || recommendationChanged || !existing) {
        const now = new Date(nowMs);
        const historyEntry = {
          at: now.toISOString(),
          fromState: current,
          toState: transition.appliedState,
          recommendedState: transition.recommendedState,
          reasons: transition.reasons,
          actor: "meta_strategy_controller(auto, tighten-only)",
        };
        if (existing) {
          const priorHistory = Array.isArray(existing.historyJson) ? (existing.historyJson as unknown[]) : [];
          await db
            .update(metaStrategyStatesTable)
            .set({
              appliedState: transition.appliedState,
              recommendedState: transition.recommendedState,
              reasonsJson: transition.reasons,
              evidenceJson: evidence,
              historyJson: [...priorHistory, historyEntry],
              lastEvaluatedAt: now,
              updatedAt: now,
            })
            .where(eq(metaStrategyStatesTable.id, existing.id));
        } else {
          await db
            .insert(metaStrategyStatesTable)
            .values({
              strategy,
              appliedState: transition.appliedState,
              recommendedState: transition.recommendedState,
              reasonsJson: transition.reasons,
              evidenceJson: evidence,
              historyJson: [historyEntry],
              lastEvaluatedAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing({ target: metaStrategyStatesTable.strategy });
        }
        if (transition.changed) {
          reduced += 1;
          // Mirror the reduction into the existing registry seam (auto-demote
          // is the allowed direction; promote is NEVER called from here).
          const level = demotionLevelFor(transition.appliedState);
          if (level) {
            demote(strategy, level, transition.reasons[0] ?? "meta-strategy reduction", "meta_strategy_controller");
          }
          logger.info(
            { strategy, from: current, to: transition.appliedState, reasons: transition.reasons },
            "meta_strategy_reduced",
          );
        } else if (transition.refusedPromotion) {
          logger.info(
            { strategy, current, recommended: transition.recommendedState },
            "meta_strategy_promotion_refused — owner press required via existing promotion machinery",
          );
        }
      }
    } catch (err) {
      errors += 1;
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), strategy },
        "meta_strategy evaluation failed for one strategy (skipped, fail-safe)",
      );
    }
  }

  return { strategiesEvaluated: byStrategy.size, reduced, promotionsRefused, errors };
}

// ── Worker (missionDriver idiom) ────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startMetaStrategyControllerWorker(): void {
  if (timer) return;
  if (!metaStrategyEnabled(process.env["ARX_META_STRATEGY_ENABLED"])) {
    logger.warn(
      { flag: "ARX_META_STRATEGY_ENABLED" },
      "meta_strategy_controller_DISABLED_by_env — strategy postures will NOT be continuously re-evaluated (no automatic reductions)",
    );
    return;
  }
  timer = setInterval(() => {
    if (running) return;
    running = true;
    runMetaStrategyPass()
      .then((r) => {
        if (r.reduced > 0 || r.promotionsRefused > 0 || r.errors > 0) {
          logger.info({ ...r }, "meta_strategy_pass");
        }
      })
      .catch((err) =>
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "meta_strategy_pass_failed (fail-safe; next tick retries — apply docs/migrations-pending/build-engine-drivers.sql if tables are missing)",
        ),
      )
      .finally(() => { running = false; });
  }, META_STRATEGY_INTERVAL_MS).unref();
  logger.info({ intervalMs: META_STRATEGY_INTERVAL_MS }, "meta_strategy_controller_started");
}

export function stopMetaStrategyControllerWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
