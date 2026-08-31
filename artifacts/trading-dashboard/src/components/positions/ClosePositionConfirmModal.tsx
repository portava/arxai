import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetPositionCloseConfirmation,
  useClosePosition,
  getGetOpenPositionsQueryKey,
  getGetLivePositionQueryKey,
} from "@workspace/api-client-react";

// The server refuses a close it cannot deliver to the broker (409 with an
// `error` + `blockedReason`). Surface that verbatim instead of a generic
// "Close failed." — the refusal reason IS the honest state of the position.
// Defensive on shape: the generated client may wrap the response differently.
function closeErrorMessage(err: unknown): string {
  const maybe = err as {
    response?: { data?: { error?: unknown; blockedReason?: unknown } };
    data?: { error?: unknown; blockedReason?: unknown };
  } | null;
  const data = maybe?.response?.data ?? maybe?.data;
  const base = typeof data?.error === "string" ? data.error : "Close failed.";
  const reason = typeof data?.blockedReason === "string" ? data.blockedReason : null;
  return reason ? `${base} ${reason}` : base;
}

export function ClosePositionConfirmModal({ positionId, onDone }: { positionId: number; onDone: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const conf = useGetPositionCloseConfirmation({ mutation: {} });
  const close = useClosePosition({ mutation: {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getGetOpenPositionsQueryKey() });
      qc.invalidateQueries({ queryKey: getGetLivePositionQueryKey(positionId) });
      onDone();
    },
  } });

  // Trigger the confirmation fetch lazily on mount.
  if (!conf.data && !conf.isPending && !conf.isError) conf.mutate({ id: positionId });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="text-base font-semibold text-foreground">Close position</div>
        {conf.isPending && <div className="text-xs text-txt-muted">Building confirmation…</div>}
        {conf.data && (
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
        {close.isError && (
          <div className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
            {closeErrorMessage(close.error)}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onDone} className="rounded-md border border-border px-3 py-1 text-xs text-txt-secondary hover:bg-secondary/80">Cancel</button>
          <button type="button"
            disabled={!conf.data || close.isPending}
            onClick={() => close.mutate({ id: positionId, data: { confirm: true, reason: reason || undefined } })}
            className="rounded-md bg-danger/80 px-3 py-1 text-xs font-medium text-white hover:bg-danger disabled:opacity-50">
            {close.isPending ? "Closing…" : "Confirm close"}
          </button>
        </div>
      </div>
    </div>
  );
}
