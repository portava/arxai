// Capability #27 — execution-policy promotion gate, server seam.
//
// Reads the shadow chooser's OWN journal (EXECUTION_POLICY_SHADOW_RECOMMENDATION
// audit events), evaluates the pure promotion-evidence thresholds, and keeps
// the promotion state row current. The state machine is the pure domain
// engine (executionPolicyPromotion.engine.ts); this file is IO only.
//
// SAFETY (inviolable):
//   - AUTOMATIC refresh can only record SHADOW / PRESS_UNLOCKED (the domain
//     decision type forbids ENABLED). PRESS_UNLOCKED grants NOTHING — the
//     chooser stays advisory; it only lets the owner-press seam accept a
//     press.
//   - ENABLED is written ONLY by pressEnableExecutionPolicy, whose only
//     caller is the typed-confirmation admin route, with the evidence
//     re-collected and re-verified AT PRESS TIME.
//   - NOTHING in any dispatch path consumes ENABLED yet. Wiring a consumer
//     is a separate, reviewed change; resolveExecutionPolicyMode is the one
//     sanctioned read seam and fails SAFE to SHADOW on every error.
//   - A missing table (docs/migrations-pending/build-resilience.sql not
//     applied) is a typed not-deployed state, never a fabricated status.

import { and, desc, eq } from "drizzle-orm";
import {
  db,
  auditEventsTable,
  executionPolicyPromotionsTable,
  type ExecutionPolicyPromotionRow,
} from "@workspace/db";
import {
  decideAutomaticTransition,
  decideOwnerPress,
  decideRevertPress,
  evaluatePromotionEvidence,
  isPromotionStatus,
  summarizeJournaledRecommendation,
  type PromotionEvidence,
  type PromotionStatus,
} from "@workspace/domain/execution-policy";
import { logger } from "../logger.js";

export const PROMOTION_SCOPE_PLATFORM = "platform";

/** Newest journaled recommendations examined per evidence collection. */
export const PROMOTION_EVIDENCE_WINDOW = 2000;

const SHADOW_RECOMMENDATION_EVENT_TYPE = "EXECUTION_POLICY_SHADOW_RECOMMENDATION";

function pgCode(err: unknown): string | null {
  const probe = (o: unknown): string | null =>
    o && typeof o === "object" && "code" in o && typeof (o as { code: unknown }).code === "string"
      ? (o as { code: string }).code
      : null;
  return probe(err) ?? probe((err as { cause?: unknown } | null)?.cause);
}

// ── Evidence collection ─────────────────────────────────────────────────────

export type EvidenceCollection =
  | { ok: true; evidence: PromotionEvidence; journalRowsSeen: number; unreadableRows: number }
  | { ok: false; reason: string };

/** Collect + evaluate promotion evidence from the shadow journal. Unreadable
 *  payloads are excluded and counted — never guessed at. */
export async function collectPromotionEvidence(): Promise<EvidenceCollection> {
  try {
    const rows = await db
      .select({ payload: auditEventsTable.payload })
      .from(auditEventsTable)
      .where(eq(auditEventsTable.eventType, SHADOW_RECOMMENDATION_EVENT_TYPE))
      .orderBy(desc(auditEventsTable.id))
      .limit(PROMOTION_EVIDENCE_WINDOW);
    const summaries = [];
    let unreadable = 0;
    for (const row of rows) {
      const s = summarizeJournaledRecommendation(row.payload);
      if (s) summaries.push(s);
      else unreadable += 1;
    }
    return {
      ok: true,
      evidence: evaluatePromotionEvidence(summaries),
      journalRowsSeen: rows.length,
      unreadableRows: unreadable,
    };
  } catch (err) {
    return { ok: false, reason: `promotion evidence collection failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── State row read/write ────────────────────────────────────────────────────

export type PromotionRead =
  | { ok: true; row: ExecutionPolicyPromotionRow | null }
  | { ok: false; missingTable: boolean; reason: string };

export async function readPromotionState(scope = PROMOTION_SCOPE_PLATFORM): Promise<PromotionRead> {
  try {
    const rows = await db
      .select()
      .from(executionPolicyPromotionsTable)
      .where(eq(executionPolicyPromotionsTable.scope, scope))
      .orderBy(desc(executionPolicyPromotionsTable.id))
      .limit(1);
    return { ok: true, row: rows[0] ?? null };
  } catch (err) {
    const missingTable = pgCode(err) === "42P01";
    return {
      ok: false,
      missingTable,
      reason: missingTable
        ? "execution_policy_promotions table does not exist — apply docs/migrations-pending/build-resilience.sql"
        : `promotion state read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

type HistoryEntry = {
  at: string;
  fromStatus: PromotionStatus | null;
  toStatus: PromotionStatus;
  kind: "auto" | "owner_press" | "revert_press";
  actor: string;
  reasons: string[];
};

function appendHistory(row: ExecutionPolicyPromotionRow | null, entry: HistoryEntry): HistoryEntry[] {
  const prior = Array.isArray(row?.historyJson) ? (row!.historyJson as HistoryEntry[]) : [];
  return [...prior, entry];
}

function rowStatus(row: ExecutionPolicyPromotionRow | null): PromotionStatus {
  // Unreadable/absent status is SHADOW — the least-authority reading.
  return row && isPromotionStatus(row.status) ? row.status : "SHADOW";
}

async function writeStatus(args: {
  row: ExecutionPolicyPromotionRow | null;
  toStatus: PromotionStatus;
  kind: HistoryEntry["kind"];
  actor: string;
  reasons: string[];
  evidence: PromotionEvidence | null;
  nowMs: number;
}): Promise<void> {
  const now = new Date(args.nowMs);
  const entry: HistoryEntry = {
    at: now.toISOString(),
    fromStatus: args.row ? rowStatus(args.row) : null,
    toStatus: args.toStatus,
    kind: args.kind,
    actor: args.actor,
    reasons: args.reasons,
  };
  if (args.row) {
    await db
      .update(executionPolicyPromotionsTable)
      .set({
        status: args.toStatus,
        statusEnteredAt: now,
        evidenceJson: args.evidence ?? args.row.evidenceJson,
        historyJson: appendHistory(args.row, entry),
        updatedAt: now,
      })
      .where(eq(executionPolicyPromotionsTable.id, args.row.id));
  } else {
    await db.insert(executionPolicyPromotionsTable).values({
      scope: PROMOTION_SCOPE_PLATFORM,
      status: args.toStatus,
      statusEnteredAt: now,
      evidenceJson: args.evidence,
      historyJson: [entry],
      createdAt: now,
      updatedAt: now,
    });
  }
}

// ── Automatic evidence refresh (SHADOW ↔ PRESS_UNLOCKED only) ───────────────

export type RefreshResult =
  | { ok: true; status: PromotionStatus; changed: boolean; evidence: PromotionEvidence }
  | { ok: false; reason: string };

/**
 * Refresh the promotion state from current evidence. The domain decision type
 * makes ENABLED unreachable from here; an ENABLED row is never modified by
 * this function (evidence decay is recorded in evidenceJson for the owner's
 * revert decision, status untouched).
 */
export async function refreshPromotionEvidence(nowMs = Date.now()): Promise<RefreshResult> {
  const collected = await collectPromotionEvidence();
  if (!collected.ok) return { ok: false, reason: collected.reason };
  const read = await readPromotionState();
  if (!read.ok) return { ok: false, reason: read.reason };
  const current = rowStatus(read.row);
  const decision = decideAutomaticTransition(current, collected.evidence);

  if (current === "ENABLED") {
    // Record the fresh evidence only; status is owner property.
    if (read.row) {
      await db
        .update(executionPolicyPromotionsTable)
        .set({ evidenceJson: collected.evidence, updatedAt: new Date(nowMs) })
        .where(eq(executionPolicyPromotionsTable.id, read.row.id));
    }
    return { ok: true, status: "ENABLED", changed: false, evidence: collected.evidence };
  }

  if (!decision.changed && read.row) {
    // Change-only on status; still keep the evidence snapshot current.
    await db
      .update(executionPolicyPromotionsTable)
      .set({ evidenceJson: collected.evidence, updatedAt: new Date(nowMs) })
      .where(eq(executionPolicyPromotionsTable.id, read.row.id));
    return { ok: true, status: current, changed: false, evidence: collected.evidence };
  }

  await writeStatus({
    row: read.row,
    toStatus: decision.nextStatus,
    kind: "auto",
    actor: "system:promotion-evidence-refresh",
    reasons: decision.reasons,
    evidence: collected.evidence,
    nowMs,
  });
  if (decision.changed) {
    logger.info({ from: current, to: decision.nextStatus }, "execution_policy_promotion_auto_transition (shadow-mode either way; nothing auto-enables)");
  }
  return { ok: true, status: decision.nextStatus, changed: decision.changed, evidence: collected.evidence };
}

// ── Owner presses ───────────────────────────────────────────────────────────

export type PressResult =
  | { ok: true; fromStatus: PromotionStatus; toStatus: PromotionStatus; reasons: string[] }
  | { ok: false; reason: string; evidenceReasons?: string[] };

/**
 * OWNER-PRESS enable — the ONLY pathway to ENABLED. Evidence is re-collected
 * and re-verified at press time; any failure refuses (fail closed).
 * Sole caller: the typed-confirmation admin route.
 */
export async function pressEnableExecutionPolicy(args: {
  actor: string;
  reason: string;
  confirm: boolean;
  nowMs?: number;
}): Promise<PressResult> {
  const nowMs = args.nowMs ?? Date.now();
  // Re-verify evidence AT PRESS TIME — a stale unlock must not enable.
  const collected = await collectPromotionEvidence();
  if (!collected.ok) return { ok: false, reason: `press refused (fail closed): ${collected.reason}` };
  const read = await readPromotionState();
  if (!read.ok) return { ok: false, reason: `press refused (fail closed): ${read.reason}` };
  const current = rowStatus(read.row);
  const decision = decideOwnerPress({
    currentStatus: current,
    pressTimeEvidence: collected.evidence,
    confirm: args.confirm,
  });
  if (!decision.ok) {
    return { ok: false, reason: decision.reasons[0] ?? "press refused", evidenceReasons: collected.evidence.reasons };
  }
  await writeStatus({
    row: read.row,
    toStatus: "ENABLED",
    kind: "owner_press",
    actor: args.actor,
    reasons: [args.reason, ...decision.reasons],
    evidence: collected.evidence,
    nowMs,
  });
  logger.info({ actor: args.actor, from: current }, "execution_policy_ENABLED_by_owner_press");
  return { ok: true, fromStatus: current, toStatus: "ENABLED", reasons: decision.reasons };
}

/** Revert press — always allowed (authority only shrinks). */
export async function pressRevertExecutionPolicyToShadow(args: {
  actor: string;
  reason: string;
  nowMs?: number;
}): Promise<PressResult> {
  const nowMs = args.nowMs ?? Date.now();
  const read = await readPromotionState();
  if (!read.ok) return { ok: false, reason: read.reason };
  const current = rowStatus(read.row);
  const decision = decideRevertPress(current);
  if (!decision.changed) {
    return { ok: true, fromStatus: current, toStatus: "SHADOW", reasons: decision.reasons };
  }
  await writeStatus({
    row: read.row,
    toStatus: "SHADOW",
    kind: "revert_press",
    actor: args.actor,
    reasons: [args.reason, ...decision.reasons],
    evidence: null,
    nowMs,
  });
  logger.info({ actor: args.actor, from: current }, "execution_policy_reverted_to_shadow");
  return { ok: true, fromStatus: current, toStatus: "SHADOW", reasons: decision.reasons };
}

// ── The one sanctioned mode read (fails SAFE to SHADOW) ─────────────────────

export type EffectiveExecutionPolicyMode =
  | { mode: "SHADOW"; reason: string }
  | { mode: "ENABLED"; sinceIso: string };

/**
 * Resolve the effective execution-policy mode. EVERY failure — missing
 * table, read error, unreadable status — resolves to SHADOW with the reason
 * (less authority is the safe direction here). NOTE: no dispatch path
 * consumes this yet; the first consumer must be its own reviewed change.
 */
export async function resolveExecutionPolicyMode(): Promise<EffectiveExecutionPolicyMode> {
  const read = await readPromotionState();
  if (!read.ok) {
    if (!read.missingTable) logger.warn({ reason: read.reason }, "execution_policy_mode_read_failed — resolving SHADOW (fail safe)");
    return { mode: "SHADOW", reason: read.reason };
  }
  if (read.row && rowStatus(read.row) === "ENABLED") {
    return { mode: "ENABLED", sinceIso: read.row.statusEnteredAt.toISOString() };
  }
  return { mode: "SHADOW", reason: read.row ? `status ${rowStatus(read.row)} is shadow-mode` : "no promotion row — default shadow" };
}
