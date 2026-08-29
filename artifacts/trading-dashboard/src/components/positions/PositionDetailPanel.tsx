import { useGetLivePosition, getGetLivePositionQueryKey } from "@workspace/api-client-react";
import { useState } from "react";
import { PositionRiskWarningBanner } from "./PositionRiskWarningBanner";
import { StopLossTakeProfitEditor } from "./StopLossTakeProfitEditor";
import { PositionEventTimeline } from "./PositionEventTimeline";
import { ClosePositionConfirmModal } from "./ClosePositionConfirmModal";

// Build H — full detail page for a single live position. Composes the
// editor, risk banner, event timeline, and close-confirmation modal.
export function PositionDetailPanel({ positionId }: { positionId: number }) {
  const { data, isLoading } = useGetLivePosition(positionId, { query: { queryKey: getGetLivePositionQueryKey(positionId), refetchInterval: 5_000 } });
  const [showClose, setShowClose] = useState(false);
  if (isLoading || !data) return <div className="text-xs text-txt-muted">Loading position…</div>;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-xl border border-border bg-background/50 p-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-txt-muted">{data.symbol}</div>
          <div className="text-lg font-semibold text-foreground">{data.direction} · {data.lotSize}</div>
          <div className="text-xs text-txt-muted">Entry {data.entryPrice} · Last {data.currentPrice ?? "—"}</div>
        </div>
        <button type="button" onClick={() => setShowClose(true)}
          className="rounded-md border border-danger/40 bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/20">
          Close position
        </button>
      </div>
      <PositionRiskWarningBanner position={data} />
      <StopLossTakeProfitEditor position={data} />
      <div>
        <div className="mb-1 text-xs uppercase tracking-wide text-txt-muted">Event timeline</div>
        <PositionEventTimeline positionId={positionId} />
      </div>
      {showClose && <ClosePositionConfirmModal positionId={positionId} onDone={() => setShowClose(false)} />}
    </div>
  );
}
