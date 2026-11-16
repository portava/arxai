import React from "react";
import { useGetActiveRiskLocks, useReleaseRiskLock, getGetActiveRiskLocksQueryKey, getGetPermissionStatusQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ShieldX, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CooldownTimer } from "./CooldownTimer";
import { useTradingMode } from "@/hooks/useTradingMode";

export function RiskLockBanner() {
  const qc = useQueryClient();
  const { data } = useGetActiveRiskLocks({ query: { queryKey: getGetActiveRiskLocksQueryKey(), refetchInterval: 5_000 } });
  const mode = useTradingMode();
  const release = useReleaseRiskLock({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetActiveRiskLocksQueryKey() });
        qc.invalidateQueries({ queryKey: getGetPermissionStatusQueryKey() });
      },
    },
  });

  const locks = data?.locks ?? [];
  if (locks.length === 0) return null;
  const top = locks[0]!;

  return (
    <div
      className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3"
      data-testid="risk-lock-banner"
    >
      <div className="flex items-start gap-3">
        <ShieldX className="text-red-300 shrink-0 mt-0.5" size={20} />
        <div>
          <div className="text-sm font-semibold text-red-200 flex items-center gap-2 flex-wrap">
            <span>Trading is locked: {top.lockType}</span>
            <span
              className="text-[10px] uppercase tracking-wider text-red-200/70 border border-red-300/30 rounded px-1 py-0.5"
              data-testid="risk-lock-banner-mode"
            >
              {mode.cleanModeLabel}
            </span>
            {mode.isAdminPreviewingUserMode && (
              <span
                className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-sky-200 border border-sky-400/40 rounded px-1 py-0.5"
                data-testid="risk-lock-banner-preview-badge"
                title="Previewing as a regular user"
              >
                <Eye className="w-3 h-3" /> Preview
              </span>
            )}
          </div>
          <div className="text-xs text-red-300/80 mt-0.5">{top.reason}</div>
          {mode.cleanBlockedReason && (
            <div className="text-[11px] text-red-200/70 mt-0.5" data-testid="risk-lock-banner-blocked-reason">
              {mode.cleanBlockedReason}
            </div>
          )}
          {top.endTimeIso && <CooldownTimer endTimeIso={top.endTimeIso} className="mt-1" />}
          {locks.length > 1 && (
            <div className="text-[11px] text-red-300/60 mt-1">+ {locks.length - 1} more active lock(s)</div>
          )}
        </div>
      </div>
      {top.overrideAllowed && !mode.isAdminPreviewingUserMode && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => release.mutate({ id: top.id, data: { acknowledgement: "User override from banner", releasedBy: "USER" } })}
          disabled={release.isPending}
          className="border-red-400/40 text-red-100 hover:bg-red-500/10"
          data-testid="button-risk-lock-override"
        >
          {release.isPending ? "Releasing…" : "Override & Release"}
        </Button>
      )}
    </div>
  );
}
