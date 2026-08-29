// ── #15 Champion-Challenger — production caller for the shadow-lab engines ───
//
// WHY THIS EXISTS: the shadow-lab pairing engines (classifyPair /
// classifyOutcome / summarize) were pure domain code with no production
// caller feeding the live champion's actual decision stream. This worker is
// the missing loop: per tick it pairs CLOSED executed mission trade drafts
// (the champion's journaled decisions with realised R) against RESOLVED
// persisted shadow predictions (challenger strategies judged on the same
// symbol in the same time window), runs the EXISTING pure engines, and
// persists the paired outcomes.
//
// SAFETY / HONESTY (inviolable):
//   * EVIDENCE ONLY — NO EXECUTION. This file never imports or touches
//     executeInstant, the live command pipeline, dispatch, or any adapter
//     (pinned by the qa source test). A pair row can never place, modify, or
//     promote anything; promotion stays behind the owner-gated machinery.
//   * Only RESOLVED evidence is judged: an unresolved shadow prediction is
//     skipped (not guessed), and a draft without a realised R is skipped.
//   * Change-only: the unique (draftId, challengerShadowId) index +
//     conflict-do-nothing makes every pair insert idempotent — re-scanning
//     the same window writes nothing new.
//   * FAIL SAFE: each champion draft is paired inside its own try/catch; a
//     failure skips that draft and the next tick retries from persisted state.
import { and, eq, gte, isNotNull, lte } from "drizzle-orm";
import {
  db,
  missionTradeDraftsTable,
  shadowPredictionsTable,
  championChallengerPairsTable,
} from "@workspace/db";
import {
  classifyPair,
  classifyOutcome,
  type ShadowDecision,
  type ShadowDecisionPair,
  type OutcomeComparison,
} from "@workspace/domain/shadow-lab";
import { logger } from "./logger.js";

export const CHAMPION_CHALLENGER_INTERVAL_MS = 5 * 60 * 1000;
/** Closed champion decisions this far back are (re-)examined each pass; the
 *  unique pair index makes re-examination free. */
export const CHAMPION_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** A challenger's decision must fall within this window of the champion's
 *  decision to count as "the same setup moment". */
export const PAIRING_WINDOW_MS = 2 * 60 * 60 * 1000;
const MAX_CHAMPIONS_PER_PASS = 50;
const MAX_CHALLENGERS_PER_CHAMPION = 20;

const DISABLE_VALUES = new Set(["0", "false", "off", "no"]);

/** PURE — is the champion-challenger worker enabled? Absent env = ENABLED. */
export function championChallengerEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  return !DISABLE_VALUES.has(raw.trim().toLowerCase());
}

// ── Pure pairing (DB-free, unit-tested) ─────────────────────────────────────

export interface ChampionDraftObservation {
  draftId: string;
  agentKey: string;
  symbol: string;
  direction: string;            // BUY | SELL
  rMultiple: number;            // realised outcome in R
  edgeScore: number | null;
  createdAtMs: number;
}

export interface ChallengerShadowObservation {
  shadowId: string;
  strategy: string;
  symbol: string;
  action: string;               // BUY | SELL | WAIT
  status: string;               // SHADOW_* vocabulary
  pnlR: number | null;
  predictedAtMs: number;
}

export interface ChampionChallengerPairing {
  pairId: string;
  draftId: string;
  challengerShadowId: string;
  challengerStrategy: string;
  symbol: string;
  champion: ShadowDecision;
  challenger: ShadowDecision;
  outcome: OutcomeComparison;
}

/** PURE — was this shadow prediction actually resolved (judgeable)? A
 *  rejected/wait decision is resolved by definition (it never ran); a traded
 *  one needs a realised pnlR. */
export function challengerResolved(c: ChallengerShadowObservation): boolean {
  if (c.action === "WAIT" || c.status === "SHADOW_REJECTED") return true;
  return (
    c.pnlR !== null &&
    (c.status === "SHADOW_WIN" || c.status === "SHADOW_LOSS" || c.status === "SHADOW_BREAKEVEN" || c.status === "SHADOW_EXPIRED")
  );
}

function toChallengerDecision(c: ChallengerShadowObservation): ShadowDecision {
  const traded = c.action === "BUY" || c.action === "SELL";
  const rejected = !traded || c.status === "SHADOW_REJECTED";
  return {
    variantId: "V2",
    action: rejected ? "REJECT" : "APPROVE",
    direction: traded ? (c.action as "BUY" | "SELL") : null,
    sizeMultiplier: rejected ? 0 : 1,
    confidence: 0,
  };
}

/**
 * PURE — pair one champion decision against the challengers that saw the same
 * symbol inside the pairing window, judging each with the EXISTING shadow-lab
 * engines. Unresolved or out-of-window challengers are skipped honestly.
 */
export function pairChampionWithChallengers(
  champion: ChampionDraftObservation,
  challengers: ReadonlyArray<ChallengerShadowObservation>,
  opts: { windowMs?: number; maxPairs?: number } = {},
): ChampionChallengerPairing[] {
  const windowMs = opts.windowMs ?? PAIRING_WINDOW_MS;
  const maxPairs = opts.maxPairs ?? MAX_CHALLENGERS_PER_CHAMPION;
  if (champion.direction !== "BUY" && champion.direction !== "SELL") return [];

  const baseline: ShadowDecision = {
    variantId: "V1",
    action: "APPROVE",
    direction: champion.direction,
    sizeMultiplier: 1,
    confidence: champion.edgeScore ?? 0,
  };

  const out: ChampionChallengerPairing[] = [];
  for (const c of challengers) {
    if (out.length >= maxPairs) break;
    if (c.symbol !== champion.symbol) continue;
    if (c.strategy.trim().length === 0) continue;
    if (Math.abs(c.predictedAtMs - champion.createdAtMs) > windowMs) continue;
    if (!challengerResolved(c)) continue;

    const candidate = toChallengerDecision(c);
    const pair: ShadowDecisionPair = {
      pairId: `cc:${champion.draftId}:${c.shadowId}`,
      setupId: champion.draftId,
      symbol: champion.symbol,
      recordedAt: new Date(champion.createdAtMs).toISOString(),
      baseline,
      candidate,
    };
    const classification = classifyPair(pair);
    const outcome = classifyOutcome(classification, {
      pairId: pair.pairId,
      baselinePnlR: champion.rMultiple,
      candidatePnlR: candidate.action === "REJECT" ? 0 : (c.pnlR ?? 0),
      baselineExecuted: true,
      candidateExecuted: candidate.action !== "REJECT",
    });
    out.push({
      pairId: pair.pairId,
      draftId: champion.draftId,
      challengerShadowId: c.shadowId,
      challengerStrategy: c.strategy,
      symbol: champion.symbol,
      champion: baseline,
      challenger: candidate,
      outcome,
    });
  }
  return out;
}

// ── Pass ────────────────────────────────────────────────────────────────────

export interface ChampionChallengerPassResult {
  championsExamined: number;
  pairsPersisted: number;
  errors: number;
}

export async function runChampionChallengerPass(
  opts: { nowMs?: number } = {},
): Promise<ChampionChallengerPassResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const since = new Date(nowMs - CHAMPION_LOOKBACK_MS);

  const champions = await db
    .select({
      draftId: missionTradeDraftsTable.draftId,
      agentKey: missionTradeDraftsTable.agentKey,
      symbol: missionTradeDraftsTable.symbol,
      direction: missionTradeDraftsTable.direction,
      rMultiple: missionTradeDraftsTable.rMultiple,
      edgeScore: missionTradeDraftsTable.edgeScore,
      createdAt: missionTradeDraftsTable.createdAt,
    })
    .from(missionTradeDraftsTable)
    .where(
      and(
        eq(missionTradeDraftsTable.status, "executed"),
        isNotNull(missionTradeDraftsTable.closedAt),
        isNotNull(missionTradeDraftsTable.rMultiple),
        gte(missionTradeDraftsTable.closedAt, since),
      ),
    )
    .limit(MAX_CHAMPIONS_PER_PASS);

  let pairsPersisted = 0;
  let errors = 0;

  for (const row of champions) {
    try {
      if (row.rMultiple === null) continue; // typed honesty; filtered above
      const champion: ChampionDraftObservation = {
        draftId: row.draftId,
        agentKey: row.agentKey,
        symbol: row.symbol,
        direction: row.direction,
        rMultiple: row.rMultiple,
        edgeScore: row.edgeScore,
        createdAtMs: row.createdAt.getTime(),
      };
      const windowStart = new Date(champion.createdAtMs - PAIRING_WINDOW_MS);
      const windowEnd = new Date(champion.createdAtMs + PAIRING_WINDOW_MS);
      const shadowRows = await db
        .select({
          shadowId: shadowPredictionsTable.shadowId,
          strategy: shadowPredictionsTable.strategy,
          symbol: shadowPredictionsTable.symbol,
          action: shadowPredictionsTable.action,
          status: shadowPredictionsTable.status,
          pnlR: shadowPredictionsTable.pnlR,
          predictedAt: shadowPredictionsTable.predictedAt,
        })
        .from(shadowPredictionsTable)
        .where(
          and(
            eq(shadowPredictionsTable.symbol, champion.symbol),
            gte(shadowPredictionsTable.predictedAt, windowStart),
            lte(shadowPredictionsTable.predictedAt, windowEnd),
          ),
        )
        .limit(200);

      const pairings = pairChampionWithChallengers(
        champion,
        shadowRows.map((s) => ({
          shadowId: s.shadowId,
          strategy: s.strategy,
          symbol: s.symbol,
          action: s.action,
          status: s.status,
          pnlR: s.pnlR,
          predictedAtMs: s.predictedAt.getTime(),
        })),
      );

      for (const p of pairings) {
        const inserted = await db
          .insert(championChallengerPairsTable)
          .values({
            pairId: p.pairId,
            draftId: p.draftId,
            challengerShadowId: p.challengerShadowId,
            challengerStrategy: p.challengerStrategy,
            symbol: p.symbol,
            championJson: p.champion,
            challengerJson: p.challenger,
            comparisonClass: p.outcome.comparisonClass,
            judgment: p.outcome.judgment,
            championPnlR: p.outcome.baselinePnlR,
            challengerPnlR: p.outcome.candidatePnlR,
            challengerEdgeR: p.outcome.candidateEdgeR,
            reasonsJson: p.outcome.reasons,
            pairedAt: new Date(nowMs),
          })
          .onConflictDoNothing({
            target: [championChallengerPairsTable.draftId, championChallengerPairsTable.challengerShadowId],
          })
          .returning({ id: championChallengerPairsTable.id });
        if (inserted[0]) pairsPersisted += 1;
      }
    } catch (err) {
      errors += 1;
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), draftId: row.draftId },
        "champion_challenger pairing failed for one champion (skipped, fail-safe)",
      );
    }
  }

  return { championsExamined: champions.length, pairsPersisted, errors };
}

// ── Worker (missionDriver idiom) ────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startChampionChallengerWorker(): void {
  if (timer) return;
  if (!championChallengerEnabled(process.env["ARX_CHAMPION_CHALLENGER_ENABLED"])) {
    logger.warn(
      { flag: "ARX_CHAMPION_CHALLENGER_ENABLED" },
      "champion_challenger_DISABLED_by_env — the live champion's decisions will NOT be paired against challenger strategies",
    );
    return;
  }
  timer = setInterval(() => {
    if (running) return;
    running = true;
    runChampionChallengerPass()
      .then((r) => {
        if (r.pairsPersisted > 0 || r.errors > 0) {
          logger.info({ ...r }, "champion_challenger_pass");
        }
      })
      .catch((err) =>
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "champion_challenger_pass_failed (fail-safe; next tick retries — apply docs/migrations-pending/build-engine-drivers.sql if tables are missing)",
        ),
      )
      .finally(() => { running = false; });
  }, CHAMPION_CHALLENGER_INTERVAL_MS).unref();
  logger.info({ intervalMs: CHAMPION_CHALLENGER_INTERVAL_MS }, "champion_challenger_worker_started");
}

export function stopChampionChallengerWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
