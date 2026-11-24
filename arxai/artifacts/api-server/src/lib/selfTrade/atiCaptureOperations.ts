import { and, asc, eq, gte, isNull, lt, lte, sql } from "drizzle-orm";
import {
  atiShadowRunsTable as runs,
  atiShadowObservationsTable as observations,
  atiShadowOutcomesTable as outcomes,
  db,
} from "@workspace/db";
import { ATI_FLEET_BASELINE, ATI_FLEET_CAPTURE } from "./atiFleetShadow.js";
import { atiShadowDefinition, ATI_SHADOW_HOLD_WINDOW_MS, isAtiEntryDecision } from "./atiShadowGrading.js";

export async function readAtiCaptureOperations(owner: number, agent: number, runId: string, asOf: Date) {
  const [run] = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.ownerId, owner),
        eq(runs.agentId, agent),
        isNull(runs.researchSource),
        lte(runs.startedAt, asOf),
      ),
    )
    .limit(1);
  if (!run) return null;
  const records = await db
    .select({
      key: observations.observationKey,
      at: observations.observedAt,
      recorded: observations.recordedAt,
      coverage: observations.coverage,
      setup: observations.setup,
      outcome: observations.baselineOutcome,
      grade: sql<string | null>`${outcomes.evidence}->>'state'`,
      gradeStatus: sql<string | null>`${outcomes.evidence}->>'status'`,
      retestIncomplete: sql<
        boolean | null
      >`'UNRESOLVED' in (${outcomes.evidence} #>> '{baseline,state}', ${outcomes.evidence} #>> '{challenger,state}')`,
    })
    .from(observations)
    .leftJoin(
      outcomes,
      and(
        eq(observations.runId, outcomes.runId),
        eq(observations.observationKey, outcomes.observationKey),
        lte(outcomes.evaluatedAt, asOf),
        lte(outcomes.recordedAt, asOf),
      ),
    )
    .where(
      and(
        eq(observations.runId, runId),
        gte(observations.observedAt, run.startedAt),
        lt(observations.observedAt, run.endsAt),
        lte(observations.observedAt, asOf),
        lte(observations.recordedAt, asOf),
      ),
    )
    .orderBy(asc(observations.observedAt), asc(observations.observationKey));
  const step = atiShadowDefinition.barMs;
  const floor = (ms: number) => Math.floor(ms / step) * step;
  const bySlot = new Map<number, typeof records>();
  for (const row of records) {
    const slot = floor(+row.at);
    const entries = bySlot.get(slot);
    if (entries) entries.push(row);
    else bySlot.set(slot, [row]);
  }
  const lastSlot = floor(Math.min(+asOf, +run.endsAt - 1));
  const slots = [];
  for (let t = floor(+run.startedAt); t <= lastSlot; t += step) {
    const entries = bySlot.get(t) ?? [];
    const observed = entries.filter((e) => e.coverage === "OBSERVED").length;
    const complete = +asOf >= Math.min(t + step, +run.endsAt);
    const state = observed
      ? "OBSERVED"
      : entries.length
        ? "CAPTURE_WITHOUT_BOUND_FEED"
        : complete
          ? "NO_SAVED_READ"
          : "OPEN_SLOT";
    slots.push({
      startsAt: Math.max(t, +run.startedAt),
      endsAt: Math.min(t + step, +run.endsAt),
      complete,
      state,
      reads: entries.length,
      observed,
      sourceChanged: entries.filter((e) => e.coverage === "SOURCE_CHANGED").length,
      unavailable: entries.filter((e) => e.coverage === "NO_OBSERVED_FEED").length,
    });
  }
  const eligible = records.filter(
    (e) => e.coverage === "OBSERVED" && e.setup === run.setup && isAtiEntryDecision(e.outcome),
  );
  const overdue = eligible.filter((e) => !e.grade && +e.at + ATI_SHADOW_HOLD_WINDOW_MS <= +asOf);
  return {
    policy: "ati-shadow-capture-monitor-v1",
    runId,
    symbol: run.symbol,
    baselineVersion: run.baselineVersion,
    challengerVersion: run.challengerVersion,
    timeframe: run.timeframe,
    asOf: asOf.toISOString(),
    captureMode: run.baselineVersion === ATI_FLEET_BASELINE ? ATI_FLEET_CAPTURE : "ON_DEMAND",
    executionAuthority: "NONE",
    slots,
    missingCompletedSlots: slots.filter((s) => s.state === "NO_SAVED_READ").length,
    lastSavedReceiptAt: records.reduce<number | null>(
      (last, r) => (r.recorded ? Math.max(last ?? 0, +r.recorded) : last),
      null,
    ),
    grading: {
      eligible: eligible.length,
      waitingForGrade: eligible.filter((e) => !e.grade).length - overdue.length,
      overdueObservationKeys: overdue.map((e) => e.key),
      unresolvedGrades: eligible.filter(
        (e) =>
          e.grade === "UNRESOLVED" ||
          e.gradeStatus === "UNRESOLVED" ||
          (e.grade === "RETEST_COMPARISON" && e.retestIncomplete),
      ).length,
    },
  };
}
