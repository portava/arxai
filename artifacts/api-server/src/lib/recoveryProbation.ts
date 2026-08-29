// ── #34 Recovery Probation — graduated post-outage authority restoration ─────
//
// WHY THIS EXISTS: the graduated-probation engines (selectRecoveryMode /
// applyRecoveryMode in lib/domain/src/kill-switch) were pure domain code with
// no runtime consumer — the live path's kill switch was binary
// engaged/released, so a release restored FULL authority in one step. This
// service is the missing runtime: releasing the kill switch now opens the
// live path through probation stages (reduced size first) instead of full
// authority.
//
// AUTHORITY DIRECTION (inviolable):
//   * AUTOMATIC transitions only ever move toward LESS authority
//     (tightenRecoveryProbation refuses anything else — proven by the
//     authority-direction property tests).
//   * Advancement toward MORE authority happens ONLY through
//     advanceRecoveryProbationOneStage, whose only callers are the
//     owner-press admin seams (typed-confirmation admin routes), one stage
//     per press, with a minimum dwell per stage.
//   * This layer is ADDITIVE and stricter-only: it can refuse or shrink,
//     never grant. Every existing wall (kill switch, 18/23-gate dispatch,
//     per-user governor, mission gate, Phase 7) runs unchanged underneath.
//
// FAILURE POSTURE:
//   * Arming (at a kill-switch release doorway) runs inside the release
//     transaction — if the probation row cannot be written, the RELEASE
//     fails and the switch stays engaged (fail closed).
//   * Consumers reading probation state: a MISSING TABLE (schema not yet
//     applied via docs/migrations-pending/build-engine-drivers.sql) means the
//     layer is not deployed — consumers degrade to "no probation" with a
//     loud log (the pre-existing walls still stand). Any OTHER read error on
//     a deployed layer fails CLOSED (refuse) — an errored safety layer never
//     silently passes.
import { and, eq } from "drizzle-orm";
import { db, recoveryProbationsTable, type RecoveryProbationRow } from "@workspace/db";
import type { RecoveryMode } from "@workspace/domain/kill-switch";
import { logger } from "./logger.js";

export const PROBATION_SCOPE_PLATFORM = "platform";

/** Minimum time a stage must be held before an owner press may advance it. */
export const PROBATION_STAGE_MIN_DWELL_MS = 60 * 60 * 1000; // 1 hour

/** Sizing cap applied to mission draft creation while REDUCED_SIZE (mirrors
 *  KILL_SWITCH_DEFAULTS.reducedSizeMultiplierCap in the domain engine). */
export const PROBATION_REDUCED_SIZE_MULTIPLIER = 0.5;

const DISABLE_VALUES = new Set(["0", "false", "off", "no"]);

/** PURE — is the recovery-probation layer enabled? Absent env = ENABLED. */
export function recoveryProbationEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  return !DISABLE_VALUES.has(raw.trim().toLowerCase());
}

// ── Pure stage ladder ────────────────────────────────────────────────────────
// Authority rank: higher = more authority. NORMAL exists only on exited rows.
const STAGE_AUTHORITY_RANK: Record<RecoveryMode, number> = {
  BLOCK_ALL: 0,
  PAPER_ONLY: 1,
  A_PLUS_ONLY: 2,
  REDUCED_SIZE: 3,
  NORMAL: 4,
};

export function probationAuthorityRank(stage: RecoveryMode): number {
  return STAGE_AUTHORITY_RANK[stage];
}

/** PURE — true when moving from→to REDUCES (or keeps) authority. */
export function isTighteningTransition(from: RecoveryMode, to: RecoveryMode): boolean {
  return probationAuthorityRank(to) <= probationAuthorityRank(from);
}

/** PURE — the single next stage toward authority (owner-press ladder). */
export function nextStageTowardAuthority(stage: RecoveryMode): RecoveryMode {
  switch (stage) {
    case "BLOCK_ALL":    return "PAPER_ONLY";
    case "PAPER_ONLY":   return "A_PLUS_ONLY";
    case "A_PLUS_ONLY":  return "REDUCED_SIZE";
    case "REDUCED_SIZE": return "NORMAL"; // NORMAL = probation exit
    case "NORMAL":       return "NORMAL";
  }
}

/** PURE — dwell gate for an owner-press advance (fake-clock testable). */
export function advanceDwellSatisfied(stageEnteredAtMs: number, nowMs: number): boolean {
  return nowMs - stageEnteredAtMs >= PROBATION_STAGE_MIN_DWELL_MS;
}

/** PURE — initial stage per release doorway. A cold-platform release starts
 *  at PAPER_ONLY (nothing live is possible anyway — the probation ladder is
 *  what later meters the return); the hot activate-step ceremony starts at
 *  REDUCED_SIZE (live re-opens, but reduced size first, never full). */
export function initialStageForSource(
  source: "kill_switch_release" | "activate_step_release" | "emergency_pause_release",
): RecoveryMode {
  switch (source) {
    case "kill_switch_release":     return "PAPER_ONLY";
    case "activate_step_release":   return "REDUCED_SIZE";
    case "emergency_pause_release": return "PAPER_ONLY";
  }
}

export function isRecoveryMode(s: string): s is RecoveryMode {
  return s === "BLOCK_ALL" || s === "PAPER_ONLY" || s === "A_PLUS_ONLY"
    || s === "REDUCED_SIZE" || s === "NORMAL";
}

// ── Pure consumer verdicts ───────────────────────────────────────────────────

export interface ProbationDispatchVerdict {
  allowed: boolean;
  reasons: string[];
}

/** PURE — may a MISSION draft dispatch proceed under this probation stage?
 *  Stricter-only: can only refuse, never grant anything the gates would deny.
 *    BLOCK_ALL    → refuse every dispatch (paper included)
 *    PAPER_ONLY   → paper allowed; demo allowed (simulated recorder, no broker
 *                   contact); LIVE refused
 *    A_PLUS_ONLY  → live only with an A-tier edge; paper/demo unaffected
 *    REDUCED_SIZE → allowed (the reduction is applied at DRAFT CREATION, so
 *                   the human approves the reduced size, not a mutated one)
 *    NORMAL       → allowed (stage only appears on exited rows) */
export function probationDispatchVerdict(args: {
  stage: RecoveryMode;
  executionMode: string;             // paper | demo | live
  edgeTier: string | null;
}): ProbationDispatchVerdict {
  const { stage, executionMode, edgeTier } = args;
  switch (stage) {
    case "BLOCK_ALL":
      return { allowed: false, reasons: ["recovery probation stage BLOCK_ALL — no dispatch of any kind until an owner press advances the stage"] };
    case "PAPER_ONLY":
      if (executionMode === "live") {
        return { allowed: false, reasons: ["recovery probation stage PAPER_ONLY — live dispatch refused; paper/demo (simulated, no broker contact) remain available"] };
      }
      return { allowed: true, reasons: [] };
    case "A_PLUS_ONLY":
      if (executionMode === "live" && edgeTier !== "A") {
        return { allowed: false, reasons: [`recovery probation stage A_PLUS_ONLY — live dispatch requires an A-tier edge (draft tier: ${edgeTier ?? "none"})`] };
      }
      return { allowed: true, reasons: [] };
    case "REDUCED_SIZE":
    case "NORMAL":
      return { allowed: true, reasons: [] };
  }
}

/** PURE — sizing multiplier applied at mission DRAFT CREATION (≤ 1, never
 *  raises). REDUCED_SIZE halves; stricter stages also cap (they will refuse
 *  at dispatch anyway, but a draft created under them is born reduced). */
export function probationSizingMultiplier(stage: RecoveryMode | null): number {
  if (stage === null || stage === "NORMAL") return 1;
  return PROBATION_REDUCED_SIZE_MULTIPLIER;
}

/** PURE — may a GUIDED (proven-demo, Tier-0/1) dispatch proceed? Only
 *  BLOCK_ALL refuses: every other stage permits demo-money orders, which the
 *  guided path independently proves are demo before delivery. */
export function guidedProbationVerdict(stage: RecoveryMode): ProbationDispatchVerdict {
  if (stage === "BLOCK_ALL") {
    return { allowed: false, reasons: ["recovery probation stage BLOCK_ALL — guided dispatch refused until an owner press advances the stage"] };
  }
  return { allowed: true, reasons: [] };
}

// ── DB reads/writes ──────────────────────────────────────────────────────────

export type ProbationRead =
  | { ok: true; row: RecoveryProbationRow | null }
  | { ok: false; missingTable: boolean; reason: string };

function pgCode(err: unknown): string | null {
  const probe = (o: unknown): string | null => {
    if (o && typeof o === "object" && "code" in o && typeof (o as { code: unknown }).code === "string") {
      return (o as { code: string }).code;
    }
    return null;
  };
  return probe(err) ?? probe((err as { cause?: unknown } | null)?.cause);
}

/** Read the current ACTIVE probation row (latest wins). Honest typed result —
 *  a missing table is distinguished so consumers can treat the layer as
 *  not-deployed rather than errored. */
export async function readActiveProbation(scope = PROBATION_SCOPE_PLATFORM): Promise<ProbationRead> {
  try {
    const rows = await db
      .select()
      .from(recoveryProbationsTable)
      .where(and(eq(recoveryProbationsTable.scope, scope), eq(recoveryProbationsTable.status, "active")))
      .orderBy(recoveryProbationsTable.id)
      .limit(50);
    const row = rows.length > 0 ? rows[rows.length - 1]! : null;
    return { ok: true, row };
  } catch (err) {
    const code = pgCode(err);
    const missingTable = code === "42P01";
    return {
      ok: false,
      missingTable,
      reason: missingTable
        ? "recovery_probations table does not exist — apply docs/migrations-pending/build-engine-drivers.sql"
        : `probation read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

type HistoryEntry = {
  at: string;
  fromStage: RecoveryMode | null;
  toStage: RecoveryMode;
  direction: "arm" | "tighten" | "advance" | "exit";
  actor: string;
  reason: string;
};

function appendHistory(row: RecoveryProbationRow | null, entry: HistoryEntry): HistoryEntry[] {
  const prior = Array.isArray(row?.historyJson) ? (row!.historyJson as HistoryEntry[]) : [];
  return [...prior, entry];
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Arm probation at a release doorway. Runs on the CALLER'S transaction so a
 * failed arm fails the release itself (fail closed — the switch stays
 * engaged). If a probation is already active, the STRICTER of (existing,
 * initial) stage wins — arming never loosens.
 */
export async function armRecoveryProbation(
  exec: Tx | typeof db,
  args: {
    source: "kill_switch_release" | "activate_step_release" | "emergency_pause_release";
    actor: string;
    reason: string;
    nowMs?: number;
  },
): Promise<{ armed: true; stage: RecoveryMode }> {
  const nowMs = args.nowMs ?? Date.now();
  const now = new Date(nowMs);
  const initial = initialStageForSource(args.source);

  const existingRows = await exec
    .select()
    .from(recoveryProbationsTable)
    .where(and(
      eq(recoveryProbationsTable.scope, PROBATION_SCOPE_PLATFORM),
      eq(recoveryProbationsTable.status, "active"),
    ))
    .limit(50);
  const existing = existingRows.length > 0 ? existingRows[existingRows.length - 1]! : null;

  if (existing && isRecoveryMode(existing.stage)) {
    // Keep the stricter stage; never loosen on arm.
    const kept: RecoveryMode = isTighteningTransition(existing.stage, initial) ? initial : existing.stage;
    if (kept !== existing.stage) {
      await exec
        .update(recoveryProbationsTable)
        .set({
          stage: kept,
          stageEnteredAt: now,
          updatedAt: now,
          historyJson: appendHistory(existing, {
            at: now.toISOString(), fromStage: existing.stage, toStage: kept,
            direction: "tighten", actor: args.actor,
            reason: `re-armed via ${args.source}: ${args.reason}`,
          }),
        })
        .where(eq(recoveryProbationsTable.id, existing.id));
      return { armed: true, stage: kept };
    }
    return { armed: true, stage: existing.stage };
  }

  await exec.insert(recoveryProbationsTable).values({
    scope: PROBATION_SCOPE_PLATFORM,
    status: "active",
    stage: initial,
    stageEnteredAt: now,
    source: args.source,
    reasonsJson: [args.reason],
    historyJson: [{
      at: now.toISOString(), fromStage: null, toStage: initial,
      direction: "arm", actor: args.actor, reason: args.reason,
    } satisfies HistoryEntry],
    createdAt: now,
    updatedAt: now,
  });
  logger.info({ source: args.source, stage: initial }, "recovery_probation_armed");
  return { armed: true, stage: initial };
}

/**
 * AUTOMATIC tighten — the ONLY automatic transition. Refuses (returns
 * unchanged) unless the target stage has LESS-or-equal authority. Change-only:
 * an equal stage writes nothing.
 */
export async function tightenRecoveryProbation(args: {
  toStage: RecoveryMode;
  actor: string;
  reason: string;
  nowMs?: number;
}): Promise<{ applied: boolean; stage: RecoveryMode | null; reason: string }> {
  const read = await readActiveProbation();
  if (!read.ok) {
    logger.warn({ reason: read.reason }, "recovery_probation_tighten_skipped_unreadable");
    return { applied: false, stage: null, reason: read.reason };
  }
  if (!read.row) return { applied: false, stage: null, reason: "no active probation" };
  const row = read.row;
  const from: RecoveryMode = isRecoveryMode(row.stage) ? row.stage : "BLOCK_ALL";
  if (!isTighteningTransition(from, args.toStage)) {
    return { applied: false, stage: from, reason: `refused: ${args.toStage} has MORE authority than ${from} — automatic transitions may only tighten` };
  }
  if (args.toStage === from) return { applied: false, stage: from, reason: "already at stage (change-only)" };
  const nowMs = args.nowMs ?? Date.now();
  const now = new Date(nowMs);
  await db
    .update(recoveryProbationsTable)
    .set({
      stage: args.toStage,
      stageEnteredAt: now,
      updatedAt: now,
      historyJson: appendHistory(row, {
        at: now.toISOString(), fromStage: from, toStage: args.toStage,
        direction: "tighten", actor: args.actor, reason: args.reason,
      }),
    })
    .where(eq(recoveryProbationsTable.id, row.id));
  logger.info({ from, to: args.toStage, reason: args.reason }, "recovery_probation_tightened");
  return { applied: true, stage: args.toStage, reason: args.reason };
}

export type ProbationAdvanceResult =
  | { ok: true; exited: boolean; fromStage: RecoveryMode; toStage: RecoveryMode }
  | { ok: false; reason: string };

/**
 * OWNER-PRESS advance — one stage toward authority per press, dwell-gated.
 * The only callers are the typed-confirmation admin routes; this function is
 * never invoked from a worker or timer (asserted by the source-pin test).
 */
export async function advanceRecoveryProbationOneStage(args: {
  actor: string;
  reason: string;
  nowMs?: number;
}): Promise<ProbationAdvanceResult> {
  const nowMs = args.nowMs ?? Date.now();
  const read = await readActiveProbation();
  if (!read.ok) return { ok: false, reason: read.reason };
  if (!read.row) return { ok: false, reason: "no active probation to advance" };
  const row = read.row;
  const from: RecoveryMode = isRecoveryMode(row.stage) ? row.stage : "BLOCK_ALL";
  if (!advanceDwellSatisfied(row.stageEnteredAt.getTime(), nowMs)) {
    const remainMs = PROBATION_STAGE_MIN_DWELL_MS - (nowMs - row.stageEnteredAt.getTime());
    return {
      ok: false,
      reason: `stage ${from} has not met its minimum dwell — ${Math.ceil(remainMs / 60000)} minute(s) remaining before an advance press is accepted`,
    };
  }
  const to = nextStageTowardAuthority(from);
  const exited = to === "NORMAL";
  const now = new Date(nowMs);
  await db
    .update(recoveryProbationsTable)
    .set({
      stage: to,
      status: exited ? "exited" : "active",
      stageEnteredAt: now,
      updatedAt: now,
      historyJson: appendHistory(row, {
        at: now.toISOString(), fromStage: from, toStage: to,
        direction: exited ? "exit" : "advance", actor: args.actor, reason: args.reason,
      }),
    })
    .where(eq(recoveryProbationsTable.id, row.id));
  logger.info({ from, to, exited, actor: args.actor }, "recovery_probation_advanced_by_owner_press");
  return { ok: true, exited, fromStage: from, toStage: to };
}

// ── Consumer helper — resolve the effective stage for a dispatch decision ────

export type EffectiveProbation =
  | { kind: "none" }                             // no active probation / layer disabled or not deployed
  | { kind: "active"; stage: RecoveryMode }
  | { kind: "unreadable"; reason: string };      // deployed layer errored — consumers fail CLOSED

/** Resolve the effective probation state for consumers. Env-disabled and
 *  missing-table both read as "none" (loudly logged); any other read error is
 *  "unreadable" and consumers refuse. */
export async function resolveEffectiveProbation(): Promise<EffectiveProbation> {
  if (!recoveryProbationEnabled(process.env["ARX_RECOVERY_PROBATION_ENABLED"])) {
    logger.warn({ flag: "ARX_RECOVERY_PROBATION_ENABLED" }, "recovery_probation_DISABLED_by_env — post-release authority restoration is NOT staged");
    return { kind: "none" };
  }
  const read = await readActiveProbation();
  if (!read.ok) {
    if (read.missingTable) {
      logger.warn({ reason: read.reason }, "recovery_probation_table_missing — layer not deployed; existing walls unaffected");
      return { kind: "none" };
    }
    return { kind: "unreadable", reason: read.reason };
  }
  if (!read.row || !isRecoveryMode(read.row.stage) || read.row.stage === "NORMAL") {
    return { kind: "none" };
  }
  return { kind: "active", stage: read.row.stage };
}
