import { useEffect, useMemo, useReducer } from "react";
import {
  ACCOUNT_SNAPSHOT_LIVE_MS as LIVE_MS,
  ACCOUNT_SNAPSHOT_FRESH_MS as FRESH_MS,
  ACCOUNT_SNAPSHOT_DELAYED_MS as DELAYED_MS,
} from "@workspace/domain/broker-health";
import type { Freshness, LiveAccountSnapshot } from "./useLiveAccountSnapshot";

const rank: Record<Freshness, number> = { live: 0, fresh: 1, delayed: 2, stale: 3, unavailable: 4 };
const floor: Record<Freshness, number> = { live: 0, fresh: LIVE_MS + 1, delayed: FRESH_MS + 1, stale: DELAYED_MS + 1, unavailable: Infinity };
const validAge = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
function worse(a: Freshness, b: Freshness): Freshness { return rank[a] >= rank[b] ? a : b; }
function fromAge(age: number): Freshness {
  if (!validAge(age)) return "unavailable";
  return age <= LIVE_MS ? "live" : age <= FRESH_MS ? "fresh" : age <= DELAYED_MS ? "delayed" : "stale";
}

/** Degrade display evidence only. Never change amounts, release funds or upgrade a server verdict. */
export function ageAccountSnapshot(source: LiveAccountSnapshot, elapsedMs: number) {
  const elapsed = Math.max(0, elapsedMs);
  let nextInMs = Infinity;
  function ageFreshness(status: Freshness, baseAge: number): Freshness {
    if (status === "unavailable") return status;
    const age = baseAge + elapsed;
    const aged = worse(status, fromAge(age));
    const limit = aged === "live" ? LIVE_MS : aged === "fresh" ? FRESH_MS : aged === "delayed" ? DELAYED_MS : Infinity;
    if (Number.isFinite(limit)) nextInMs = Math.min(nextInMs, Math.max(1, limit + 1 - age));
    return aged;
  }
  let freshness = ageFreshness(source.freshness, floor[source.freshness]);
  const positions = source.positions.map(position => {
    const age = source.lastComputedAtMs - position.lastUpdateAtMs;
    const positionFreshness = ageFreshness(position.freshness, validAge(age) ? age : NaN);
    freshness = worse(freshness, positionFreshness);
    return positionFreshness === position.freshness ? position : { ...position, freshness: positionFreshness };
  });
  let live = source.live;
  if (live) {
    const evidence = live.freshness;
    const stampedAge = evidence.lastUpdatedAt == null ? NaN : source.lastComputedAtMs - Date.parse(evidence.lastUpdatedAt);
    const ages = [evidence.ageMs, stampedAge].filter(validAge);
    const timestampInvalid = evidence.lastUpdatedAt != null && !validAge(stampedAge);
    const ageMs = ages.length && !timestampInvalid ? Math.max(...ages) + elapsed : null;
    const status = evidence.status !== "fresh" ? evidence.status
      : ageMs == null || freshness === "unavailable" ? "unavailable"
        : ageMs > FRESH_MS || rank[freshness] >= rank.delayed ? "stale" : "fresh";
    if (status === "fresh" && ageMs != null) nextInMs = Math.min(nextInMs, Math.max(1, FRESH_MS + 1 - ageMs));
    live = { ...live, freshness: { ...evidence, status, ageMs } };
  }
  return { snapshot: { ...source, positions, live, freshness }, nextInMs };
}

/** One timer at the next evidence boundary, not a per-second whole-page rerender.
 * Wall time catches sleep; monotonic elapsed prevents backward clock changes rejuvenating data.
 * Heartbeats and reconnects do not replace the receipt. Only a new snapshot does.
 */
export function useAgedAccountSnapshot(source: LiveAccountSnapshot | null): LiveAccountSnapshot | null {
  const [version, refresh] = useReducer(n => n + 1, 0);
  const receipt = useMemo(() => {
    const wall = Date.now();
    return { wall, mono: performance.now(), elapsed: 0,
      transit: source && Number.isFinite(source.lastComputedAtMs) ? Math.max(0, wall - source.lastComputedAtMs) : 0 };
  }, [source]);
  const result = useMemo(() => {
    receipt.elapsed = Math.max(receipt.elapsed, Date.now() - receipt.wall, performance.now() - receipt.mono, 0);
    return source ? ageAccountSnapshot(source, receipt.transit + receipt.elapsed) : null;
  }, [source, receipt, version]);
  useEffect(() => {
    if (!result || !Number.isFinite(result.nextInMs)) return;
    const timer = setTimeout(refresh, result.nextInMs);
    const onVisible = () => { if (!document.hidden) refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [result]);
  return result?.snapshot ?? null;
}
