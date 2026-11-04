import type { ChartReplaySnapshot } from "./chartReplay";

export function replayDrawingKey(snapshot: ChartReplaySnapshot): string {
  return `arx.chart.replay.drawings:${snapshot.ownerId}:${snapshot.id}`;
}

/** Browser Back can contain URL syntax as well as a route. Parse before using
 * it for a hard reload; slash/backslash and encoded origin escapes fall back. */
export function replayExitUrl(path: string, base: string, origin: string): string {
  const fallback = new URL(`${base}/live-chart`, origin);
  if (!path.startsWith("/")) return fallback.href;
  try {
    const target = new URL(`${base}${path}`, origin);
    return target.origin === fallback.origin ? target.href : fallback.href;
  } catch {
    return fallback.href;
  }
}
