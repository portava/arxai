// Build RR — Onboarding state service.
//
// SAFETY: Acknowledgements are stored but NEVER unlock live trading.
// canPlaceTrades is never written. Live trading remains DISABLED.

import { randomUUID } from "node:crypto";
import { db, userOnboardingProgressTable, onboardingEventsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { ONBOARDING_STEPS, REQUIRED_ACK_KEYS, type AckKey } from "./steps.js";
import { auditEvent } from "../systemHealth/audit.js";
import { createAlert } from "../alerts/alertManager.js";

export type Progress = typeof userOnboardingProgressTable.$inferSelect;

const SINGLE_USER_ID: number | null = null; // single-user repl; one row keyed by null user_id

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

export async function getOrCreateProgress(): Promise<Progress> {
  const existing = await db.select().from(userOnboardingProgressTable).limit(1);
  if (existing[0]) return existing[0];
  const onboardingId = `onb_${randomUUID()}`;
  const [row] = await db.insert(userOnboardingProgressTable).values({
    onboardingId,
    userId: SINGLE_USER_ID,
    status: "NOT_STARTED",
  }).returning();
  await logEvent(onboardingId, "CREATED", "Onboarding progress row initialized.");
  return row!;
}

export async function getStatus(): Promise<Progress & { totalSteps: number; nextStep: string | null }> {
  const p = await getOrCreateProgress();
  const completed = (p.completedSteps as string[]) ?? [];
  const skipped = (p.skippedSteps as string[]) ?? [];
  const next = ONBOARDING_STEPS.find(s => !completed.includes(s.step_id) && !skipped.includes(s.step_id))?.step_id ?? null;
  return { ...p, totalSteps: ONBOARDING_STEPS.length, nextStep: next };
}

export async function startOnboarding(): Promise<Progress> {
  const p = await getOrCreateProgress();
  const [row] = await db.update(userOnboardingProgressTable).set({
    status: "IN_PROGRESS",
    currentStep: p.currentStep ?? ONBOARDING_STEPS[0]!.step_id,
    lastSeenAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(userOnboardingProgressTable.id, p.id)).returning();
  await logEvent(p.onboardingId, "STARTED", "Onboarding started.");
  await audit("onboarding.started", { onboardingId: p.onboardingId });
  await createAlert({ type: "AI_COACH", priority: "LOW", title: "Onboarding started", message: "Guided onboarding has been started. Live trading remains DISABLED." }).catch(() => {});
  return row!;
}

export async function completeStep(stepId: string): Promise<Progress> {
  const step = ONBOARDING_STEPS.find(s => s.step_id === stepId);
  if (!step) throw new Error("UNKNOWN_STEP");
  const p = await getOrCreateProgress();
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
  }).where(eq(userOnboardingProgressTable.id, p.id)).returning();
  await logEvent(p.onboardingId, "STEP_COMPLETED", `Step '${stepId}' completed.`, { stepId });
  if (!next) {
    await audit("onboarding.completed", { onboardingId: p.onboardingId });
    await createAlert({ type: "AI_COACH", priority: "LOW", title: "Onboarding completed", message: "Guided onboarding finished. Live trading remains DISABLED." }).catch(() => {});
  }
  return row!;
}

export async function skipStep(stepId: string): Promise<Progress> {
  const step = ONBOARDING_STEPS.find(s => s.step_id === stepId);
  if (!step) throw new Error("UNKNOWN_STEP");
  if (step.required) throw new Error("STEP_REQUIRED");
  const p = await getOrCreateProgress();
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
  }).where(eq(userOnboardingProgressTable.id, p.id)).returning();
  await logEvent(p.onboardingId, "STEP_SKIPPED", `Step '${stepId}' skipped.`, { stepId, severity: "INFO" });
  return row!;
}

export async function completeOnboarding(): Promise<Progress> {
  const p = await getOrCreateProgress();
  const [row] = await db.update(userOnboardingProgressTable).set({
    status: "COMPLETED",
    walkthroughCompleted: true,
    currentStep: null,
    lastSeenAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(userOnboardingProgressTable.id, p.id)).returning();
  await logEvent(p.onboardingId, "COMPLETED", "Onboarding marked complete.");
  await audit("onboarding.completed", { onboardingId: p.onboardingId });
  return row!;
}

export async function resetOnboarding(): Promise<Progress> {
  const p = await getOrCreateProgress();
  const [row] = await db.update(userOnboardingProgressTable).set({
    status: "NOT_STARTED",
    currentStep: null,
    completedSteps: sql`'[]'::jsonb`,
    skippedSteps: sql`'[]'::jsonb`,
    walkthroughCompleted: false,
    lastSeenAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(userOnboardingProgressTable.id, p.id)).returning();
  await logEvent(p.onboardingId, "RESET", "Onboarding reset.");
  await audit("onboarding.reset", { onboardingId: p.onboardingId });
  return row!;
}

export async function acknowledge(key: AckKey): Promise<Progress> {
  if (!REQUIRED_ACK_KEYS.includes(key)) throw new Error("UNKNOWN_ACK");
  const p = await getOrCreateProgress();
  const patch: Record<string, unknown> = { lastSeenAt: new Date(), updatedAt: new Date() };
  patch[key] = true;
  const [row] = await db.update(userOnboardingProgressTable).set(patch as Partial<typeof userOnboardingProgressTable.$inferInsert>).where(eq(userOnboardingProgressTable.id, p.id)).returning();
  await logEvent(p.onboardingId, "ACKNOWLEDGED", `Acknowledgement '${key}' recorded. Live trading remains DISABLED.`, { stepId: key });
  await audit("onboarding.acknowledged", { onboardingId: p.onboardingId, key, liveTradingStatus: "DISABLED" });
  return row!;
}

export async function listEvents(limit = 50) {
  const p = await getOrCreateProgress();
  return db.select().from(onboardingEventsTable).where(eq(onboardingEventsTable.onboardingId, p.onboardingId)).orderBy(sql`${onboardingEventsTable.createdAt} desc`).limit(limit);
}
