// Build RR — Onboarding state service.
//
// SAFETY: Acknowledgements are stored but NEVER unlock live trading.
// canPlaceTrades is never written. Live trading remains DISABLED.
//
// PER-USER ISOLATION (fixed): this service used to key the single progress row
// on a hardcoded `SINGLE_USER_ID = null` and read it back with an unfiltered
// `.limit(1)`. One user's onboarding was therefore everyone's: a second user
// saw the first user's progress at 100% with the safety-acknowledgement boxes
// already ticked — recorded as having acknowledged risk disclosures they never
// read — and any Reset wiped every other user's state. Every function below
// now takes the authenticated `userId` and both filters and writes on it. The
// unique index `user_onboarding_progress_user_idx` on (user_id) keeps it to
// one row per user. Legacy rows with a NULL user_id are deliberately NOT
// adopted by any user: they are invisible, so no one inherits a stranger's
// acknowledgements.

import { randomUUID } from "node:crypto";
import { db, userOnboardingProgressTable, onboardingEventsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { ONBOARDING_STEPS, REQUIRED_ACK_KEYS, type AckKey } from "./steps.js";
import { auditEvent } from "../systemHealth/audit.js";
import { createAlert } from "../alerts/alertManager.js";

export type Progress = typeof userOnboardingProgressTable.$inferSelect;

async function logEvent(onboardingId: string, eventType: string, message: string, opts: { stepId?: string | null; severity?: string; details?: Record<string, unknown> } = {}) {
  await db.insert(onboardingEventsTable).values({
    onboardingId,
    eventType,
    stepId: opts.stepId ?? null,
    severity: opts.severity ?? "INFO",
    message,
    details: opts.details ?? {},
  }).catch(() => { /* non-fatal */ });
}

async function audit(action: string, details: Record<string, unknown>) {
  try { await auditEvent({ eventType: "ONBOARDING", action, sourceBuild: "MM", actor: "USER", metadata: { build: "RR", ...details } }); } catch { /* non-fatal */ }
}

export async function getOrCreateProgress(userId: number): Promise<Progress> {
  const existing = await db.select().from(userOnboardingProgressTable)
    .where(eq(userOnboardingProgressTable.userId, userId))
    .limit(1);
  if (existing[0]) return existing[0];
  const onboardingId = `onb_${randomUUID()}`;
  // Concurrent first loads from the same user must not create two rows; the
  // unique index on user_id decides, and we re-read the winner.
  const inserted = await db.insert(userOnboardingProgressTable).values({
    onboardingId,
    userId,
    status: "NOT_STARTED",
  }).onConflictDoNothing().returning();
  if (inserted[0]) {
    await logEvent(onboardingId, "CREATED", "Onboarding progress row initialized.");
    return inserted[0];
  }
  const raced = await db.select().from(userOnboardingProgressTable)
    .where(eq(userOnboardingProgressTable.userId, userId))
    .limit(1);
  if (!raced[0]) throw new Error("ONBOARDING_PROGRESS_UNAVAILABLE");
  return raced[0];
}

/** Ownership-scoped WHERE for every mutation below. */
function ownRow(userId: number, id: number) {
  return and(
    eq(userOnboardingProgressTable.id, id),
    eq(userOnboardingProgressTable.userId, userId),
  );
}

export async function getStatus(userId: number): Promise<Progress & { totalSteps: number; nextStep: string | null }> {
  const p = await getOrCreateProgress(userId);
  const completed = (p.completedSteps as string[]) ?? [];
  const skipped = (p.skippedSteps as string[]) ?? [];
  const next = ONBOARDING_STEPS.find(s => !completed.includes(s.step_id) && !skipped.includes(s.step_id))?.step_id ?? null;
  return { ...p, totalSteps: ONBOARDING_STEPS.length, nextStep: next };
}

export async function startOnboarding(userId: number): Promise<Progress> {
  const p = await getOrCreateProgress(userId);
  const [row] = await db.update(userOnboardingProgressTable).set({
    status: "IN_PROGRESS",
    currentStep: p.currentStep ?? ONBOARDING_STEPS[0]!.step_id,
    lastSeenAt: new Date(),
    updatedAt: new Date(),
  }).where(ownRow(userId, p.id)).returning();
  await logEvent(p.onboardingId, "STARTED", "Onboarding started.");
  await audit("onboarding.started", { onboardingId: p.onboardingId, userId });
  await createAlert({ type: "AI_COACH", priority: "LOW", title: "Onboarding started", message: "Guided onboarding has been started. Live trading remains DISABLED." }).catch(() => {});
  return row!;
}

export async function completeStep(userId: number, stepId: string): Promise<Progress> {
  const step = ONBOARDING_STEPS.find(s => s.step_id === stepId);
  if (!step) throw new Error("UNKNOWN_STEP");
  const p = await getOrCreateProgress(userId);
  const completed = new Set([...(p.completedSteps as string[]) ?? [], stepId]);
  const skipped = new Set((p.skippedSteps as string[]) ?? []); skipped.delete(stepId);
  const next = ONBOARDING_STEPS.find(s => !completed.has(s.step_id) && !skipped.has(s.step_id))?.step_id ?? null;
  const [row] = await db.update(userOnboardingProgressTable).set({
    status: next ? "IN_PROGRESS" : "COMPLETED",
    currentStep: next,
    completedSteps: [...completed],
    skippedSteps: [...skipped],
    walkthroughCompleted: !next,
    lastSeenAt: new Date(),
    updatedAt: new Date(),
  }).where(ownRow(userId, p.id)).returning();
  await logEvent(p.onboardingId, "STEP_COMPLETED", `Step '${stepId}' completed.`, { stepId });
  if (!next) {
    await audit("onboarding.completed", { onboardingId: p.onboardingId, userId });
    await createAlert({ type: "AI_COACH", priority: "LOW", title: "Onboarding completed", message: "Guided onboarding finished. Live trading remains DISABLED." }).catch(() => {});
  }
  return row!;
}

export async function skipStep(userId: number, stepId: string): Promise<Progress> {
  const step = ONBOARDING_STEPS.find(s => s.step_id === stepId);
  if (!step) throw new Error("UNKNOWN_STEP");
  if (step.required) throw new Error("STEP_REQUIRED");
  const p = await getOrCreateProgress(userId);
  const skipped = new Set([...(p.skippedSteps as string[]) ?? [], stepId]);
  const completed = (p.completedSteps as string[]) ?? [];
  const next = ONBOARDING_STEPS.find(s => !completed.includes(s.step_id) && !skipped.has(s.step_id))?.step_id ?? null;
  const [row] = await db.update(userOnboardingProgressTable).set({
    skippedSteps: [...skipped],
    currentStep: next,
    status: next ? "IN_PROGRESS" : "COMPLETED",
    walkthroughCompleted: !next,
    lastSeenAt: new Date(),
    updatedAt: new Date(),
  }).where(ownRow(userId, p.id)).returning();
  await logEvent(p.onboardingId, "STEP_SKIPPED", `Step '${stepId}' skipped.`, { stepId, severity: "INFO" });
  return row!;
}

export async function completeOnboarding(userId: number): Promise<Progress> {
  const p = await getOrCreateProgress(userId);
  const [row] = await db.update(userOnboardingProgressTable).set({
    status: "COMPLETED",
    walkthroughCompleted: true,
    currentStep: null,
    lastSeenAt: new Date(),
    updatedAt: new Date(),
  }).where(ownRow(userId, p.id)).returning();
  await logEvent(p.onboardingId, "COMPLETED", "Onboarding marked complete.");
  await audit("onboarding.completed", { onboardingId: p.onboardingId, userId });
  return row!;
}

export async function resetOnboarding(userId: number): Promise<Progress> {
  const p = await getOrCreateProgress(userId);
  // Reset clears the caller's OWN progress and their own acknowledgements —
  // never anybody else's.
  const [row] = await db.update(userOnboardingProgressTable).set({
    status: "NOT_STARTED",
    currentStep: null,
    completedSteps: sql`'[]'::jsonb`,
    skippedSteps: sql`'[]'::jsonb`,
    walkthroughCompleted: false,
    lastSeenAt: new Date(),
    updatedAt: new Date(),
  }).where(ownRow(userId, p.id)).returning();
  await logEvent(p.onboardingId, "RESET", "Onboarding reset.");
  await audit("onboarding.reset", { onboardingId: p.onboardingId, userId });
  return row!;
}

export async function acknowledge(userId: number, key: AckKey): Promise<Progress> {
  if (!REQUIRED_ACK_KEYS.includes(key)) throw new Error("UNKNOWN_ACK");
  const p = await getOrCreateProgress(userId);
  const patch: Record<string, unknown> = { lastSeenAt: new Date(), updatedAt: new Date() };
  patch[key] = true;
  const [row] = await db.update(userOnboardingProgressTable)
    .set(patch as Partial<typeof userOnboardingProgressTable.$inferInsert>)
    .where(ownRow(userId, p.id)).returning();
  await logEvent(p.onboardingId, "ACKNOWLEDGED", `Acknowledgement '${key}' recorded. Live trading remains DISABLED.`, { stepId: key });
  await audit("onboarding.acknowledged", { onboardingId: p.onboardingId, userId, key, liveTradingStatus: "DISABLED" });
  return row!;
}

export async function listEvents(userId: number, limit = 50) {
  const p = await getOrCreateProgress(userId);
  return db.select().from(onboardingEventsTable)
    .where(eq(onboardingEventsTable.onboardingId, p.onboardingId))
    .orderBy(sql`${onboardingEventsTable.createdAt} desc`)
    .limit(limit);
}
