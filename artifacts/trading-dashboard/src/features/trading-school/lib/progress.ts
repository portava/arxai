/**
 * Trading School — progress + risk-simulator logic.
 *
 * Progress is durable per-user via the backend:
 *   GET  /api/me/trading-school/progress  (read-through on load)
 *   PUT  /api/me/trading-school/progress  (write-through on every change)
 * localStorage is used as a fast local cache (and offline fallback) so the
 * synchronous helpers below stay instant; the server is the cross-device
 * source of truth. Every read/write goes through this single module, so the
 * UI never talks to storage or the API directly.
 *
 * On load we MERGE the local cache with the server copy (union of completed/
 * passed lessons + labs + badges, all recorded attempts, earliest start,
 * recomputed completion) so switching devices never loses progress, then
 * push the merged result back. After every mutation we push the new state to
 * the server (best-effort; failures keep the local cache intact).
 *
 * NOTE: artifacts in the chat sandbox cannot use localStorage, but this code
 * ships into the real app (Replit), where localStorage is available. We guard
 * every access so it degrades to in-memory if storage is unavailable.
 */
import { useEffect, useState } from "react";
import {
  getMeTradingSchoolProgress,
  putMeTradingSchoolProgress,
  deleteMeTradingSchoolProgress,
} from "@workspace/api-client-react";
import { STEPS, BADGES } from "../data/content";

const STORAGE_KEY = "arx.trading-school.progress.v1";
const PASS_THRESHOLD = 0.8; // 80% to pass

export interface QuizAttempt {
  lessonId: string;
  scorePct: number; // 0..1
  passed: boolean;
  at: string;       // ISO date
}

export interface SchoolProgress {
  startedAt: string | null;
  completedAt: string | null;
  lastLessonId: string | null;
  completedLessonIds: string[];
  passedLessonIds: string[];
  attempts: QuizAttempt[];
  labsAttempted: string[];
  earnedBadgeIds: string[];
}

const EMPTY: SchoolProgress = {
  startedAt: null,
  completedAt: null,
  lastLessonId: null,
  completedLessonIds: [],
  passedLessonIds: [],
  attempts: [],
  labsAttempted: [],
  earnedBadgeIds: [],
};

// in-memory fallback when storage is unavailable
let memory: SchoolProgress = { ...EMPTY };

// ── change subscription (so React views re-render after server sync) ──────────
type Listener = () => void;
const listeners = new Set<Listener>();

function notify() {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* a bad listener must not break the others */
    }
  }
}

/** Subscribe to progress changes. Returns an unsubscribe function. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function safeRead(): SchoolProgress {
  try {
    if (typeof window === "undefined" || !window.localStorage) return memory;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY };
    return { ...EMPTY, ...JSON.parse(raw) } as SchoolProgress;
  } catch {
    return memory;
  }
}

/** Persist locally only (cache); does NOT push to the server or notify. */
function writeLocal(p: SchoolProgress) {
  memory = p;
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable — memory already updated */
  }
}

function safeWrite(p: SchoolProgress) {
  writeLocal(p);
  notify();
  // Write-through to the server (best-effort). A failure (e.g. 401/offline)
  // leaves the local cache intact so the user keeps making progress.
  void pushToServer(p);
}

// ── server sync (read-through / write-through) ────────────────────────────────

/** Push the full progress blob to the server. Best-effort. */
async function pushToServer(p: SchoolProgress): Promise<void> {
  try {
    await putMeTradingSchoolProgress(p);
  } catch {
    /* unauthenticated or offline — local cache remains the source of truth */
  }
}

/** Union two string arrays preserving order (local first, then new server ids). */
function unionIds(a: string[], b: string[]): string[] {
  const out = [...a];
  for (const id of b) if (!out.includes(id)) out.push(id);
  return out;
}

/** Merge local + server attempts, de-duped by (lessonId, at), sorted by time. */
function mergeAttempts(a: QuizAttempt[], b: QuizAttempt[]): QuizAttempt[] {
  const seen = new Set<string>();
  const out: QuizAttempt[] = [];
  for (const at of [...a, ...b]) {
    const key = `${at.lessonId}|${at.at}|${at.scorePct}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(at);
  }
  out.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  return out;
}

/** Earliest non-null ISO timestamp (or null if both null). */
function earliest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

/** Latest non-null ISO timestamp (or null if both null). */
function latest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function mergeProgress(local: SchoolProgress, server: SchoolProgress): SchoolProgress {
  const merged: SchoolProgress = {
    startedAt: earliest(local.startedAt, server.startedAt),
    completedAt: latest(local.completedAt, server.completedAt),
    lastLessonId: local.lastLessonId ?? server.lastLessonId,
    completedLessonIds: unionIds(local.completedLessonIds, server.completedLessonIds),
    passedLessonIds: unionIds(local.passedLessonIds, server.passedLessonIds),
    attempts: mergeAttempts(local.attempts, server.attempts),
    labsAttempted: unionIds(local.labsAttempted, server.labsAttempted),
    earnedBadgeIds: unionIds(local.earnedBadgeIds, server.earnedBadgeIds),
  };
  recomputeBadgesAndCompletion(merged);
  return merged;
}

let syncInFlight: Promise<SchoolProgress> | null = null;

/**
 * Read-through sync: fetch the server copy, merge with the local cache, persist
 * the merged result locally, push it back to the server, and notify listeners.
 * On any failure (unauthenticated / offline) the local cache is returned
 * unchanged. Concurrent calls share one in-flight request.
 */
export function syncFromServer(): Promise<SchoolProgress> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    const local = safeRead();
    try {
      const res = await getMeTradingSchoolProgress();
      const server = { ...EMPTY, ...res.progress } as SchoolProgress;
      const merged = mergeProgress(local, server);
      writeLocal(merged);
      notify();
      void pushToServer(merged);
      return merged;
    } catch {
      // unauthenticated or offline — keep local as the source of truth
      return local;
    } finally {
      syncInFlight = null;
    }
  })();
  return syncInFlight;
}

export function getProgress(): SchoolProgress {
  return safeRead();
}

export function markLessonStarted(lessonId: string): SchoolProgress {
  const p = safeRead();
  if (!p.startedAt) p.startedAt = new Date().toISOString();
  p.lastLessonId = lessonId;
  safeWrite(p);
  return p;
}

export function markLessonComplete(lessonId: string): SchoolProgress {
  const p = safeRead();
  if (!p.completedLessonIds.includes(lessonId)) p.completedLessonIds.push(lessonId);
  recomputeBadgesAndCompletion(p);
  safeWrite(p);
  return p;
}

export function recordQuizAttempt(lessonId: string, scorePct: number): SchoolProgress {
  const p = safeRead();
  const passed = scorePct >= PASS_THRESHOLD;
  p.attempts.push({ lessonId, scorePct, passed, at: new Date().toISOString() });
  if (passed) {
    if (!p.passedLessonIds.includes(lessonId)) p.passedLessonIds.push(lessonId);
    if (!p.completedLessonIds.includes(lessonId)) p.completedLessonIds.push(lessonId);
  }
  recomputeBadgesAndCompletion(p);
  safeWrite(p);
  return p;
}

export function markLabAttempted(labId: string): SchoolProgress {
  const p = safeRead();
  if (!p.labsAttempted.includes(labId)) p.labsAttempted.push(labId);
  safeWrite(p);
  return p;
}

export function resetProgress(): SchoolProgress {
  const fresh = { ...EMPTY, completedLessonIds: [], passedLessonIds: [], attempts: [], labsAttempted: [], earnedBadgeIds: [] };
  // Clear the local cache and notify listeners immediately.
  writeLocal(fresh);
  notify();
  // Remove the saved server row outright (best-effort, still per-user). A
  // failure (401/offline) leaves the cleared local cache intact.
  void deleteFromServer();
  return fresh;
}

/** Delete the caller's saved progress row on the server. Best-effort. */
async function deleteFromServer(): Promise<void> {
  try {
    await deleteMeTradingSchoolProgress();
  } catch {
    /* unauthenticated or offline — local cache is already cleared */
  }
}

function recomputeBadgesAndCompletion(p: SchoolProgress) {
  // award badges whose step has been passed
  for (const b of BADGES) {
    const stepId = `step-${b.earnedAfterStep}`;
    if (p.passedLessonIds.includes(stepId) && !p.earnedBadgeIds.includes(b.id)) {
      p.earnedBadgeIds.push(b.id);
    }
  }
  // overall completion
  const allPassed = STEPS.every((s) => p.passedLessonIds.includes(s.id));
  if (allPassed && !p.completedAt) p.completedAt = new Date().toISOString();
  if (!allPassed) p.completedAt = null;
}

/** Completion percentage 0..100 based on steps passed. */
export function completionPct(p: SchoolProgress): number {
  return Math.round((p.passedLessonIds.length / STEPS.length) * 100);
}

/** Best score recorded for a lesson, or null if never attempted. */
export function bestScore(p: SchoolProgress, lessonId: string): number | null {
  const scores = p.attempts.filter((a) => a.lessonId === lessonId).map((a) => a.scorePct);
  return scores.length ? Math.max(...scores) : null;
}

export { PASS_THRESHOLD };

/* ------------------------------------------------------------------ */
/* REACT HOOK — synced, reactive progress                             */
/* ------------------------------------------------------------------ */

/**
 * Reactive progress for React views. Returns the current (synchronous, cached)
 * progress and re-renders whenever it changes — including after the read-through
 * server sync that runs once on mount. Mutations still go through the exported
 * helpers (markLessonComplete, recordQuizAttempt, …), which notify subscribers.
 */
export function useSchoolProgress(): SchoolProgress {
  const [progress, setProgress] = useState<SchoolProgress>(() => getProgress());

  useEffect(() => {
    // Re-read the cache on every change notification.
    const unsubscribe = subscribe(() => setProgress(getProgress()));
    // Pull the server copy, merge, and persist (best-effort; no-op if offline).
    void syncFromServer();
    // Pick up any mutation that happened between the initial render and effect.
    setProgress(getProgress());
    return unsubscribe;
  }, []);

  return progress;
}

/* ------------------------------------------------------------------ */
/* RISK SIMULATOR — pure math, no live execution                      */
/* ------------------------------------------------------------------ */

export interface RiskSimInputs {
  accountSize: number;
  riskPct: number;       // e.g. 2 for 2%
  stopDistance: number;  // in price units (e.g. pips/points)
  targetDistance: number;
  valuePerUnit?: number; // $ per 1 price unit per 1 lot (default 1)
}

export interface RiskSimResult {
  dollarRisk: number;
  dollarReward: number;
  riskReward: number;      // reward / risk
  positionSize: number;    // lots (approx)
  tooHighRisk: boolean;    // > 5% flagged
  rubyNote: string;
}

export function calcRiskSim(i: RiskSimInputs): RiskSimResult {
  const valuePerUnit = i.valuePerUnit && i.valuePerUnit > 0 ? i.valuePerUnit : 1;
  const dollarRisk = (i.accountSize * i.riskPct) / 100;
  const positionSize = i.stopDistance > 0 ? dollarRisk / (i.stopDistance * valuePerUnit) : 0;
  const dollarReward = positionSize * i.targetDistance * valuePerUnit;
  const riskReward = dollarRisk > 0 ? dollarReward / dollarRisk : 0;
  const tooHighRisk = i.riskPct > 5;

  let rubyNote: string;
  if (tooHighRisk) {
    rubyNote = `Risking ${i.riskPct}% on one trade is high. Many traders keep it near 1–2%. If this stop is hit, you'd lose $${dollarRisk.toFixed(2)} — make sure that's a loss you're truly comfortable with.`;
  } else if (riskReward < 1 && i.targetDistance > 0) {
    rubyNote = `This plan risks $${dollarRisk.toFixed(2)} to make $${dollarReward.toFixed(2)} — less than 1:1. You'd need to be right more often than wrong just to break even. Consider a closer stop or a further target.`;
  } else {
    rubyNote = `This plan risks $${dollarRisk.toFixed(2)} to attempt $${dollarReward.toFixed(2)} (about ${riskReward.toFixed(1)}:1). If the stop is hit, the idea is wrong and the trade ends there. I'm not predicting the outcome — only showing the math.`;
  }

  return { dollarRisk, dollarReward, riskReward, positionSize, tooHighRisk, rubyNote };
}
