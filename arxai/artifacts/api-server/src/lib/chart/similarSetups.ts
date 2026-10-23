// Chart Brain v2 — Task 5: similar-setup lookup foundation (SLOW BRAIN).
//
// findSimilarSetups searches a user's OWN past decision receipts for setups that
// structurally resemble a query fingerprint, scores them by deterministic
// field-by-field similarity, and returns the closest matches together with how
// they resolved (their appended outcomes). It is honest by construction: when
// there is not enough comparable history it says so rather than inventing a
// pattern.
//
// This is decision support only and runs on-demand / in the background — it is
// NEVER on the live execution path and NEVER blocks candle render or dispatch.
// Strictly per-user: only the calling user's receipts are ever considered.

import {
  db,
  chartDecisionReceiptsTable,
  chartDecisionOutcomesTable,
} from "@workspace/db";
import { and, desc, eq, ne } from "drizzle-orm";
import { logger } from "../logger.js";
import {
  scoreFingerprintSimilarity,
  type ChartSetupFingerprint,
} from "./setupFingerprint.js";

// Below this many comparable receipts we refuse to imply a pattern.
const MIN_HISTORY_FOR_REFERENCE = 3;
// Below this similarity a candidate is not "similar" enough to surface.
const MIN_SIMILARITY = 0.55;
// How many recent receipts to scan as candidates.
const CANDIDATE_SCAN_LIMIT = 300;

export interface SimilarSetupMatch {
  receiptId: string;
  symbol: string;
  timeframe: string;
  direction: string | null;
  similarity: number; // 0-1
  createdAt: string;
  qualityLabel: string | null;
  readinessScore: number | null;
  /** The most recent objective OUTCOME verdict for this receipt, if any. */
  outcome: string | null;
  plQuality: string | null;
}

export interface SimilarSetupsResult {
  /** True when enough comparable history exists to reference past setups. */
  enoughHistory: boolean;
  comparableCount: number;
  matches: SimilarSetupMatch[];
  /** Honest plain-English summary suitable for Ruby to restate. */
  summary: string;
  /** Aggregate of how matched setups resolved (only when enoughHistory). */
  resolved: {
    wins: number;
    losses: number;
    breakeven: number;
    noTradeCorrect: number;
    other: number;
  } | null;
}

function honest(comparableCount: number): SimilarSetupsResult {
  return {
    enoughHistory: false,
    comparableCount,
    matches: [],
    summary:
      comparableCount === 0
        ? "There isn't any comparable history for this kind of setup yet — I won't pretend a pattern exists."
        : `Only ${comparableCount} loosely-comparable setup(s) on record — not enough history to draw a reliable comparison yet.`,
    resolved: null,
  };
}

/**
 * Find a user's structurally-similar past setups. Always scoped to userId.
 * Degrades to an honest "not enough history" result on sparse data or any error.
 */
export async function findSimilarSetups(
  userId: number,
  query: ChartSetupFingerprint,
  limit = 5,
  opts?: { excludeReceiptId?: string },
): Promise<SimilarSetupsResult> {
  const take = Math.min(Math.max(limit, 1), 20);
  try {
    const filters = [eq(chartDecisionReceiptsTable.userId, userId)];
    if (opts?.excludeReceiptId) {
      filters.push(ne(chartDecisionReceiptsTable.receiptId, opts.excludeReceiptId));
    }
    const candidates = await db
      .select()
      .from(chartDecisionReceiptsTable)
      .where(and(...filters))
      .orderBy(desc(chartDecisionReceiptsTable.createdAt))
      .limit(CANDIDATE_SCAN_LIMIT);

    if (candidates.length === 0) return honest(0);

    const scored = candidates
      .map((c) => {
        const fp = c.fingerprint as unknown as ChartSetupFingerprint;
        let similarity = 0;
        try {
          similarity = scoreFingerprintSimilarity(query, fp);
        } catch {
          similarity = 0;
        }
        return { receipt: c, similarity };
      })
      .filter((s) => s.similarity >= MIN_SIMILARITY)
      .sort((a, b) => b.similarity - a.similarity);

    const comparableCount = scored.length;
    if (comparableCount < MIN_HISTORY_FOR_REFERENCE) {
      return honest(comparableCount);
    }

    const top = scored.slice(0, take);

    // Pull the latest objective OUTCOME for each matched receipt (per-user).
    const matches: SimilarSetupMatch[] = [];
    const resolved = {
      wins: 0,
      losses: 0,
      breakeven: 0,
      noTradeCorrect: 0,
      other: 0,
    };
    for (const s of top) {
      const r = s.receipt;
      const [o] = await db
        .select()
        .from(chartDecisionOutcomesTable)
        .where(
          and(
            eq(chartDecisionOutcomesTable.userId, userId),
            eq(chartDecisionOutcomesTable.receiptRef, r.receiptId),
            eq(chartDecisionOutcomesTable.kind, "OUTCOME"),
          ),
        )
        .orderBy(desc(chartDecisionOutcomesTable.createdAt))
        .limit(1);
      const verdict = o?.outcome ?? null;
      switch (verdict) {
        case "WIN":
          resolved.wins += 1;
          break;
        case "LOSS":
          resolved.losses += 1;
          break;
        case "BREAKEVEN":
          resolved.breakeven += 1;
          break;
        case "NO_TRADE_CORRECT":
          resolved.noTradeCorrect += 1;
          break;
        default:
          if (verdict) resolved.other += 1;
          break;
      }
      matches.push({
        receiptId: r.receiptId,
        symbol: r.symbol,
        timeframe: r.timeframe,
        direction: r.direction,
        similarity: Math.round(s.similarity * 100) / 100,
        createdAt: r.createdAt.toISOString(),
        qualityLabel: r.qualityLabel,
        readinessScore: r.readinessScore,
        outcome: verdict,
        plQuality: o?.plQuality ?? null,
      });
    }

    const decided = resolved.wins + resolved.losses + resolved.breakeven;
    const summary =
      decided === 0
        ? `Found ${comparableCount} structurally similar setup(s), but none have a recorded outcome yet — treat as context, not a track record.`
        : `Found ${comparableCount} similar setup(s); of those with a known result, ${resolved.wins} worked, ${resolved.losses} failed, ${resolved.breakeven} broke even.`;

    return { enoughHistory: true, comparableCount, matches, summary, resolved };
  } catch (err) {
    logger.warn({ err, userId }, "similarSetups: lookup failed (degrading to honest empty)");
    return honest(0);
  }
}
