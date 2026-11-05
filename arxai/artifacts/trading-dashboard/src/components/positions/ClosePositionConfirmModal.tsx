import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetPositionCloseConfirmation,
  useClosePosition,
  getGetOpenPositionsQueryKey,
  getGetLivePositionQueryKey,
} from "@workspace/api-client-react";

export function ClosePositionConfirmModal({ positionId, onDone }: { positionId: number; onDone: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const conf = useGetPositionCloseConfirmation({ mutation: {} });
  // The close route queues the close to the broker; the position stays open
  // until the broker confirms. Keep the modal up with that message instead of
  // dismissing it as if the position were already closed.
  const close = useClosePosition({ mutation: {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getGetOpenPositionsQueryKey() });
      qc.invalidateQueries({ queryKey: getGetLivePositionQueryKey(positionId) });
    },
  } });
  const errText = (e: unknown) => (e instanceof Error && e.message ? e.message : "unknown error");

  // Trigger the confirmation fetch lazily on mount.
  if (!conf.data && !conf.isPending && !conf.isError) conf.mutate({ id: positionId });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="text-base font-semibold text-foreground">Close position</div>
        {conf.isPending && <div className="text-xs text-txt-muted">Building confirmation…</div>}
        {conf.isError && (
          <div className="text-xs text-danger" data-testid="close-confirm-error">
            Couldn&apos;t build the close confirmation ({errText(conf.error)}). Nothing was sent; the position is unchanged.
          </div>
        )}
        {close.isSuccess ? (
          <div className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning" data-testid="close-requested">
            Close request sent to the broker. The position stays open until the broker confirms the close; its final P&amp;L comes from that fill.
          </div>
        ) : conf.data && (
          <>
            <div className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
              {conf.data.aiExplanation}
            </div>
            <div className="text-sm text-txt-secondary">{conf.data.summary}</div>
            <label className="block text-xs text-txt-secondary">
              Reason (optional)
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className="mt-1 w-full rounded border border-border bg-background/40 px-2 py-1 text-sm text-foreground" />
            </label>
          </>
        )}
        {close.isError && <div className="text-xs text-danger" data-testid="close-failed">Close not sent: {errText(close.error)}. The position is still open.</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onDone} className="rounded-md border border-border px-3 py-1 text-xs text-txt-secondary hover:bg-secondary/80">{close.isSuccess ? "Done" : "Cancel"}</button>
          {!close.isSuccess && <button type="button"
            disabled={!conf.data || close.isPending}
            onClick={() => close.mutate({ id: positionId, data: { confirm: true, reason: reason || undefined } })}
            className="rounded-md bg-danger/80 px-3 py-1 text-xs font-medium text-white hover:bg-danger disabled:opacity-50">
            {close.isPending ? "Sending close…" : "Confirm close"}
          </button>}
        </div>
      </div>
    </div>
  );
}
