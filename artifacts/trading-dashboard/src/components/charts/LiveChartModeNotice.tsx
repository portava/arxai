// The live-chart page's account-mode notice: what the trade ticket on this
// page does in the user's current account mode. Read-only copy.
import { AlertTriangle } from "lucide-react";
import type { UseTradingModeResult } from "@/hooks/useTradingMode";

export function LiveChartModeNotice({ mode }: { mode: UseTradingModeResult }) {
  return (
    <div className="flex items-start gap-2 rounded-2xl border border-warning/30 bg-warning/10 p-4 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 text-warning" />
      <p>
        {mode.isLiveShared
          ? <>Read-only chart. Check the chart's feed status for current data. Orders only dispatch after you <strong>review and confirm</strong> in the trade ticket, and every server safety check still applies.</>
          : mode.isDemo || mode.isPaper
            ? <>Read-only chart. The trade ticket on this page still requires your confirmation, and in {mode.cleanModeLabel} no real broker order is placed.</>
            : mode.isModeUnknown
              // Unknown mode: the user may be live, so make no demo claim.
              ? <>Read-only chart. Your account mode could not be checked just now, so this page cannot say whether an order would reach a real broker. Orders only dispatch after you <strong>review and confirm</strong> in the trade ticket, and every server safety check still applies.</>
              : <>Read-only chart. Checking your account mode. Orders only dispatch after you <strong>review and confirm</strong> in the trade ticket, and every server safety check still applies.</>}
      </p>
    </div>
  );
}
