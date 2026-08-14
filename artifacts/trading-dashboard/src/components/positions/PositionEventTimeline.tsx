import { useGetPositionEvents, getGetPositionEventsQueryKey } from "@workspace/api-client-react";

const SEV_TONE: Record<string, string> = {
  INFO: "text-zinc-300",
  WARN: "text-amber-300",
  DANGER: "text-rose-300",
};

export function PositionEventTimeline({ positionId, limit = 50 }: { positionId: number; limit?: number }) {
  const { data, isLoading } = useGetPositionEvents(positionId, { limit }, { query: { queryKey: getGetPositionEventsQueryKey(positionId, { limit }), refetchInterval: 8_000 } });
  if (isLoading || !data) return <div className="text-xs text-zinc-500">Loading timeline…</div>;
  if (data.events.length === 0) return <div className="text-xs text-zinc-500">No events yet.</div>;
  return (
    <ul className="space-y-1.5">
      {data.events.map((ev) => (
        <li key={ev.id} className="rounded-md border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-xs">
          <div className="flex items-center justify-between">
            <span className={`font-medium ${SEV_TONE[ev.severity] ?? "text-zinc-300"}`}>{ev.eventType.replace(/_/g, " ")}</span>
            <span className="text-[10px] text-zinc-500">{new Date(ev.createdAtIso).toLocaleTimeString()}</span>
          </div>
          <div className="mt-0.5 text-zinc-400">{ev.message}</div>
        </li>
      ))}
    </ul>
  );
}
