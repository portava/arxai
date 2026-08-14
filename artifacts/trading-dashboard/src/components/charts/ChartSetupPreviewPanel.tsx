import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PencilRuler, Loader2, ShieldOff, Eraser, X } from "lucide-react";
import {
  canUseSetup,
  type SetupPreview,
} from "@/lib/setup-preview";
import { SetupSignalStrip } from "@/components/signals/SetupSignalStrip";
import type { UseChartSetupPreview } from "@/hooks/useChartSetupPreview";

// ChartSetupPreviewPanel — Task #374 control + legend surface for an AI/Ruby
// "drawn" trade setup. PURE VISUALISATION + a user-initiated draw trigger and an
// optional, role-gated "Use this setup" ticket prefill. It NEVER places,
// modifies, or closes a trade — a drawing is a preview, not an order.
//
// HONESTY: every figure shown is a REAL producer output. When the feed isn't
// AI-confirmed the draw is suppressed and we say so. A refusal/avoid verdict
// shows the producer's plain reason instead of fabricated levels. Risk in
// account currency is shown ONLY when the producer returned it (never invented).

function verdictTone(v: SetupPreview["verdict"]): string {
  switch (v) {
    case "tradeable": return "text-emerald-300 border-emerald-500/40";
    case "caution": return "text-amber-300 border-amber-500/40";
    case "avoid": return "text-rose-300 border-rose-500/40";
    default: return "text-zinc-300 border-zinc-600/40";
  }
}

function num(n: number): string {
  const abs = Math.abs(n);
  const dp = abs >= 100 ? 2 : abs >= 1 ? 4 : 5;
  return n.toFixed(dp);
}

export function ChartSetupPreviewPanel({
  data,
  canUseSetup: canUse,
  onUseSetup,
}: {
  data: UseChartSetupPreview;
  /** Role/mode gate: investor + view-only never get an execute affordance. */
  canUseSetup: boolean;
  onUseSetup: (preview: SetupPreview) => void;
}) {
  const { preview, status, lifecycle, error, expired, requestDraw, discard, clear } = data;
  const loading = status === "loading";
  const suppressed = status === "suppressed";

  return (
    <div
      className="rounded-md border border-sky-500/20 bg-sky-950/10 p-3 text-[11px] leading-snug"
      data-testid="chart-setup-preview-panel"
    >
      <div className="flex items-center gap-2">
        <PencilRuler className="h-3.5 w-3.5 text-sky-400" />
        <span className="font-semibold text-sky-300">AI setup preview</span>
        <Badge variant="outline" className="h-4 border-zinc-600/50 px-1 text-[9px] uppercase tracking-wide text-zinc-400">
          Preview · Not executed
        </Badge>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-6 px-2 text-[10px]"
          disabled={suppressed || loading}
          onClick={() => requestDraw()}
          data-testid="chart-setup-draw"
        >
          {loading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
          {preview ? "Re-draw" : "Draw a setup"}
        </Button>
      </div>

      {suppressed && (
        <div className="mt-2 flex items-start gap-1.5 text-zinc-400" data-testid="chart-setup-suppressed">
          <ShieldOff className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{error ?? "Chart feed isn't AI-confirmed — no setup is drawn on an unverified feed."}</span>
        </div>
      )}

      {!suppressed && error && (
        <p className="mt-2 text-rose-300" data-testid="chart-setup-error">{error}</p>
      )}

      {preview && !suppressed && (
        <div className="mt-2 space-y-2" data-testid="chart-setup-body">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className={`h-4 px-1 text-[9px] uppercase ${verdictTone(preview.verdict)}`}>
              {preview.verdict}
            </Badge>
            {preview.side && (
              <Badge variant="outline" className="h-4 px-1 text-[9px]">{preview.side}</Badge>
            )}
            <span className="text-zinc-300">{preview.setupType}</span>
            <span className="ml-auto text-zinc-400">
              Confidence: <span className="text-zinc-200">{preview.confidence.label}</span> ({preview.confidence.score})
            </span>
          </div>

          <SetupSignalStrip
            signals={{
              scannerScore: preview.scannerScore,
              riskScore: preview.riskScore,
              flameStage: preview.flameStage,
              runOnQuality: preview.runOnQuality,
              governanceOutcome: preview.governanceOutcome,
            }}
            testIdPrefix="chart-setup-signal"
          />

          {preview.levels ? (
            <div className="grid grid-cols-3 gap-2 font-mono text-[10px]">
              <div><div className="text-zinc-500">Entry</div><div className="text-zinc-100">{num(preview.levels.entry)}</div></div>
              <div><div className="text-rose-400">Stop</div><div className="text-zinc-100">{num(preview.levels.sl)}</div></div>
              <div><div className="text-emerald-400">Target</div><div className="text-zinc-100">{num(preview.levels.tp)}</div></div>
            </div>
          ) : (
            <p className="text-zinc-400" data-testid="chart-setup-no-levels">
              {preview.refusalReason ?? "No drawable levels — the read isn't confident enough to place a setup."}
            </p>
          )}

          {preview.rewardToRisk != null && (
            <div className="text-zinc-400">
              Reward:Risk <span className="text-zinc-200">{preview.rewardToRisk.toFixed(2)}:1</span>
              {preview.riskAmount != null && preview.potentialReward != null ? (
                <span className="ml-2 text-zinc-500">
                  (risk {preview.riskAmount.toFixed(2)} → reward {preview.potentialReward.toFixed(2)})
                </span>
              ) : (
                <span className="ml-2 text-zinc-500">— account-currency risk shown only in the ticket</span>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-zinc-500">
            <span>Data: {preview.dataFreshness.basis} · {preview.dataFreshness.trustLine}</span>
            <span>Source: {preview.providerSource.label}{preview.providerSource.composite ? " (composite)" : ""}</span>
            {preview.bridgeStatus && <span>Bridge: {preview.bridgeStatus.availability}</span>}
          </div>

          {preview.explanation.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4 text-zinc-300" data-testid="chart-setup-explanation">
              {preview.explanation.map((line, i) => <li key={i}>{line}</li>)}
            </ul>
          )}

          {preview.invalidationNote && (
            <p className="text-amber-300/90">{preview.invalidationNote}</p>
          )}

          {(expired || lifecycle === "stale") && (
            <p className="text-zinc-500" data-testid="chart-setup-stale">
              This drawing has expired — draw again for a current read.
            </p>
          )}
          {lifecycle === "discarded" && (
            <p className="text-zinc-500">Setup discarded.</p>
          )}

          <div className="flex items-center gap-2 pt-1">
            {canUse && canUseSetup(preview, lifecycle) && (
              <Button
                size="sm"
                className="h-6 bg-sky-600 px-2 text-[10px] text-white hover:bg-sky-500"
                onClick={() => onUseSetup(preview)}
                data-testid="chart-setup-use"
              >
                Use this setup
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[10px]"
              onClick={discard}
              data-testid="chart-setup-discard"
            >
              <X className="mr-1 h-3 w-3" /> Discard
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[10px]"
              onClick={clear}
              data-testid="chart-setup-clear"
            >
              <Eraser className="mr-1 h-3 w-3" /> Clear
            </Button>
          </div>

          <p className="pt-1 text-[9px] text-zinc-600">
            A drawing is a preview, not an order. "Use this setup" only pre-fills the
            trade ticket — you still review and confirm, and every safety check runs.
          </p>
        </div>
      )}
    </div>
  );
}
