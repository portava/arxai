import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useUpdatePositionStopLoss,
  useUpdatePositionTakeProfit,
  getGetOpenPositionsQueryKey,
  getGetLivePositionQueryKey,
  type LivePosition,
} from "@workspace/api-client-react";

export function StopLossTakeProfitEditor({ position }: { position: LivePosition }) {
  const qc = useQueryClient();
  const [sl, setSL] = useState<string>(position.stopLoss?.toString() ?? "");
  const [tp, setTP] = useState<string>(position.takeProfit?.toString() ?? "");
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The route queues the change to the broker and does NOT edit the position:
  // the new level is only real once the broker confirms and the next snapshot
  // moves it. Say that instead of implying the change already took effect.
  const [sent, setSent] = useState<string | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getGetOpenPositionsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetLivePositionQueryKey(position.id) });
  };
  const pendingNote = (what: string) =>
    `${what} request sent to the broker. It is not applied until the broker confirms; this position shows the new level only after that.`;
  const slMut = useUpdatePositionStopLoss({ mutation: {
    onSuccess: (_d, v) => { setError(null); setSent(pendingNote(v.data.stopLoss == null ? "Stop loss removal" : "Stop loss change")); invalidate(); },
    onError: (e) => { setSent(null); setError(e instanceof Error ? e.message : String(e)); },
  } });
  const tpMut = useUpdatePositionTakeProfit({ mutation: {
    onSuccess: (_d, v) => { setError(null); setSent(pendingNote(v.data.takeProfit == null ? "Take profit removal" : "Take profit change")); invalidate(); },
    onError: (e) => { setSent(null); setError(e instanceof Error ? e.message : String(e)); },
  } });

  return (
    <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
      <div className="text-xs uppercase tracking-wide text-zinc-500">Stop loss / Take profit</div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-xs text-zinc-400">
          Stop loss
          <input value={sl} onChange={(e) => setSL(e.target.value)} className="mt-1 w-32 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100" placeholder="empty = remove" />
        </label>
        <label className="inline-flex items-center gap-1 text-xs text-zinc-400">
          <input type="checkbox" checked={removeConfirm} onChange={(e) => setRemoveConfirm(e.target.checked)} />
          confirm SL removal
        </label>
        <button type="button"
          disabled={slMut.isPending}
          onClick={() => slMut.mutate({ id: position.id, data: {
            stopLoss: sl.trim() === "" ? null : Number(sl),
            removeConfirmed: removeConfirm,
          } })}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">
          Update SL
        </button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-xs text-zinc-400">
          Take profit
          <input value={tp} onChange={(e) => setTP(e.target.value)} className="mt-1 w-32 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100" placeholder="empty = remove" />
        </label>
        <button type="button"
          disabled={tpMut.isPending}
          onClick={() => tpMut.mutate({ id: position.id, data: {
            takeProfit: tp.trim() === "" ? null : Number(tp),
          } })}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">
          Update TP
        </button>
      </div>
      {sent && <div className="text-xs text-amber-300" data-testid="sltp-pending">{sent}</div>}
      {error && <div className="text-xs text-rose-300" data-testid="sltp-error">{error}</div>}
    </div>
  );
}
