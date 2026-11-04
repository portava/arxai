import type { ChartFeedStatus } from "@workspace/api-client-react";

/** Last stored bar's age, not a claim of live feed or original clock authority. */
export function storedHistoryChipText(newestOpenIso: string, nowMs: number): string {
  const opened = Date.parse(newestOpenIso);
  if (!Number.isFinite(opened)) return "Stored history, not live";
  const mins = Math.max(0, Math.floor((nowMs - opened) / 60_000));
  const age = mins < 60 ? `${mins} min` : mins < 2880 ? `${Math.floor(mins / 60)} h` : `${Math.floor(mins / 1440)} days`;
  return `Stored history up to the last bar (${age} ago), not live`;
}

export function StoredHistoryChip({ status, newestOpenIso, nowMs = Date.now() }: {
  status: Pick<ChartFeedStatus, "notLiveReason"> | null | undefined;
  newestOpenIso: string | null;
  nowMs?: number;
}) {
  if (status?.notLiveReason !== "stored_history" || newestOpenIso == null) return null;
  return <span className="rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-200" data-testid="arx-stored-history">
    {storedHistoryChipText(newestOpenIso, nowMs)}
  </span>;
}
