import { useEffect, useMemo, useReducer } from "react";
import {
  ACCOUNT_SNAPSHOT_LIVE_MS,
  ACCOUNT_SNAPSHOT_FRESH_MS,
  MT5_ACCOUNT_SNAPSHOT_FRESH_MS,
} from "@workspace/domain/broker-health";
import type { Freshness } from "./useLiveAccountSnapshot";

export interface MasterAccountEvidenceInput {
  lastMt5SnapshotAt?: string | null;
  snapshotAgeMs?: number | null;
  snapshotStatus?: string;
  syncStatus?: string;
}
const observationTime = (value: string | null | undefined): number =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const validAge = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** This dates the account UPDATE, not every retained value. The current
 * persistence contract cannot prove all amounts were observed together. */
export function masterAccountEvidence(source: MasterAccountEvidenceInput | null, now: number, elapsed: number, initialAge: number, failed: boolean) {
  const stamp = observationTime(source?.lastMt5SnapshotAt);
  const wallAge = now - stamp;
  const serverAge = source?.snapshotAgeMs;
  const timestampKnown = Number.isFinite(stamp) && stamp > 0 && validAge(wallAge);
  const ageValid = serverAge == null || validAge(serverAge);
  const ageMs = timestampKnown && ageValid ? Math.max(wallAge, serverAge ?? 0, initialAge + Math.max(0, elapsed)) : null;
  const unavailable = !source || failed || ageMs == null
    || !["FRESH", "STALE"].includes(source.snapshotStatus ?? "")
    || !["LIVE", "STALE"].includes(source.syncStatus ?? "");
  const freshness: Freshness = unavailable ? "unavailable"
    : source.snapshotStatus === "STALE" || source.syncStatus === "STALE" ? "stale"
      : ageMs! <= ACCOUNT_SNAPSHOT_LIVE_MS ? "live"
        : ageMs! <= ACCOUNT_SNAPSHOT_FRESH_MS ? "fresh"
          : ageMs! <= MT5_ACCOUNT_SNAPSHOT_FRESH_MS ? "delayed" : "stale";
  const boundary = freshness === "live" ? ACCOUNT_SNAPSHOT_LIVE_MS : freshness === "fresh" ? ACCOUNT_SNAPSHOT_FRESH_MS : freshness === "delayed" ? MT5_ACCOUNT_SNAPSHOT_FRESH_MS : Infinity;
  return { freshness, ageMs, observedAtMs: timestampKnown ? stamp : null,
    nextInMs: ageMs == null || !Number.isFinite(boundary) ? Infinity : Math.max(1, boundary + 1 - ageMs) };
}

/** A repeated HTTP success cannot rejuvenate the same account observation.
 * One boundary timer; wall time catches sleep and monotonic time catches rollback. */
export function useMasterAccountEvidence(source: MasterAccountEvidenceInput | null, failed: boolean) {
  const [version, refresh] = useReducer(n => n + 1, 0);
  const receipt = useMemo(() => {
    const wall = Date.now(), stamp = observationTime(source?.lastMt5SnapshotAt);
    return { wall, mono: performance.now(), elapsed: 0, stale: false, age: Number.isFinite(stamp) ? Math.max(0, wall - stamp) : 0 };
  }, [source?.lastMt5SnapshotAt]);
  receipt.elapsed = Math.max(receipt.elapsed, Date.now() - receipt.wall, performance.now() - receipt.mono, 0);
  // Preserve the greatest age supplied for the same observation even when a
  // subsequent response repeats it with a smaller age or the clock moves back.
  if (validAge(source?.snapshotAgeMs)) receipt.age = Math.max(receipt.age, source.snapshotAgeMs - receipt.elapsed);
  receipt.stale ||= source?.snapshotStatus === "STALE" || source?.syncStatus === "STALE";
  const result = masterAccountEvidence(receipt.stale && source ? { ...source, snapshotStatus: "STALE" } : source, Date.now(), receipt.elapsed, receipt.age, failed);
  useEffect(() => {
    if (!Number.isFinite(result.nextInMs)) return;
    const timer = setTimeout(refresh, result.nextInMs);
    const onVisible = () => { if (!document.hidden) refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [result.nextInMs, source?.lastMt5SnapshotAt, version]);
  return result;
}
