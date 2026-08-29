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

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getGetOpenPositionsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetLivePositionQueryKey(position.id) });
  };
  const slMut = useUpdatePositionStopLoss({ mutation: { onSuccess: () => { setError(null); invalidate(); } , onError: (e) => setError(String(e)) } });
  const tpMut = useUpdatePositionTakeProfit({ mutation: { onSuccess: invalidate, onError: (e) => setError(String(e)) } });

  return (
    <div className="space-y-3 rounded-lg border border-border bg-background/50 p-3">
      <div className="text-xs uppercase tracking-wide text-txt-muted">Stop loss / Take profit</div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-xs text-txt-secondary">
          Stop loss
          <input value={sl} onChange={(e) => setSL(e.target.value)} className="mt-1 w-32 rounded border border-border bg-card px-2 py-1 text-sm text-foreground" placeholder="empty = remove" />
        </label>
        <label className="inline-flex items-center gap-1 text-xs text-txt-secondary">
          <input type="checkbox" checked={removeConfirm} onChange={(e) => setRemoveConfirm(e.target.checked)} />
          confirm SL removal
        </label>
        <button type="button"
          disabled={slMut.isPending}
          onClick={() => slMut.mutate({ id: position.id, data: {
            stopLoss: sl.trim() === "" ? null : Number(sl),
            removeConfirmed: removeConfirm,
          } })}
          className="rounded-md border border-border bg-card px-3 py-1 text-xs font-medium text-foreground hover:bg-secondary disabled:opacity-50">
          Update SL
        </button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-xs text-txt-secondary">
          Take profit
          <input value={tp} onChange={(e) => setTP(e.target.value)} className="mt-1 w-32 rounded border border-border bg-card px-2 py-1 text-sm text-foreground" placeholder="empty = remove" />
        </label>
        <button type="button"
          disabled={tpMut.isPending}
          onClick={() => tpMut.mutate({ id: position.id, data: {
            takeProfit: tp.trim() === "" ? null : Number(tp),
          } })}
          className="rounded-md border border-border bg-card px-3 py-1 text-xs font-medium text-foreground hover:bg-secondary disabled:opacity-50">
          Update TP
        </button>
      </div>
      {error && <div className="text-xs text-danger">{error}</div>}
    </div>
  );
}
