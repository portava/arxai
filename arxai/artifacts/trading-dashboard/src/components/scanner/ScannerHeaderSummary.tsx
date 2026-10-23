// ScannerHeaderSummary — hero + ONE consolidated truth strip for the Scanner.
//
// UI ONLY. Task #391: this strip consumes the single shared scanner-truth
// contract (useScannerTruth → resolveScannerTruth) so it can never disagree with
// the chart about feed state, freshness, permissions, or whether a read is
// actionable. The displayed price is the REAL candle close from
// /api/chart/candles — the simulator quote endpoint is no longer read here (that
// was the source of the header≈1.08 vs chart≈1.15 mismatch). Plain-English
// verdicts only; the precise provider name is shown to admins.

import { useEffect, useState } from "react";
import { Activity, Crosshair } from "lucide-react";
import { useChartSymbol, bareSymbol } from "@/lib/use-chart-symbol";
import { useScannerTimeframe } from "@/hooks/useScannerTimeframe";
import { useSymbolTruth } from "@/hooks/useSymbolTruth";
import { useTradingMode } from "@/hooks/useTradingMode";
import {
  type DataVerdict,
  type TradingVerdict,
  type RubyVerdict,
  type ScannerTruth,
} from "@/lib/scannerTruth";
import { resolveCappedRubyReadStatus } from "@/lib/rubyReadPanelState";
import {
  type RubyReadStatus,
  type ActionabilityTone,
  type ScannerActionabilityDisplay,
  actionabilityDisplayUi,
  resolveSelectedSymbolActionabilityDisplay,
  resolveVisibleActionLabel,
  biasToActionDirection,
  PENDING_RESOLVE_TIMEOUT_MS,
} from "@/lib/scannerActionability";
import { useRubyReadStore } from "@/components/scanner/rubyReadStore";
import { useSelectedActionStore } from "@/components/scanner/selectedActionStore";
import { coerceVisibleTimeframe } from "@/components/scanner/scannerChartFormat";
import { TruthVerdictBias, TruthVerdictStage } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { useAssistantName } from "@/lib/assistant-name";

// The contract's Ruby read status → the header's plain-English verdict label.
// These map 1:1 onto the existing RubyVerdict copy so the existing `rubyTone`
// keeps working after the cap.
const RUBY_STATUS_LABEL: Record<RubyReadStatus, RubyVerdict> = {
  FULL_READ: "Full read",
  LIMITED_READ: "Limited read",
  NO_READ: "No read",
};

// Composed-verdict labels — the ONE directional read (Task #512). The header's
// bias/stage chips come from the snapshot verdict (the same brain every surface
// reads) instead of an independent /selected-market fetch that could disagree
// with the chart. Display-ready text only; never the raw enum.
const BIAS_LABEL: Record<string, string> = {
  [TruthVerdictBias.BULLISH]: "Bullish",
  [TruthVerdictBias.BEARISH]: "Bearish",
  [TruthVerdictBias.NEUTRAL]: "Neutral",
  [TruthVerdictBias.CONFLICT]: "Mixed signals",
  [TruthVerdictBias.UNKNOWN]: "",
};
const STAGE_LABEL: Record<string, string> = {
  [TruthVerdictStage.ALIGNED]: "Aligned",
  [TruthVerdictStage.DEVELOPING]: "Developing",
  [TruthVerdictStage.CONFLICT]: "Conflicting",
  [TruthVerdictStage.UNKNOWN]: "",
};

function dataTone(v: DataVerdict): string {
  switch (v) {
    case "Live": return "text-success";
    case "Delayed": return "text-warning";
    case "Stale": return "text-warning";
    case "Unavailable": return "text-danger";
    default: return "text-txt-muted";
  }
}
function tradingTone(v: TradingVerdict): string {
  switch (v) {
    case "Enabled": return "text-success";
    case "Approval required": return "text-primary";
    case "Blocked": return "text-danger";
    default: return "text-txt-muted";
  }
}
function rubyTone(v: RubyVerdict): string {
  switch (v) {
    case "Full read": return "text-success";
    case "Limited read": return "text-warning";
    default: return "text-txt-muted";
  }
}
function actionTone(t: ActionabilityTone): string {
  switch (t) {
    case "success": return "text-success";
    case "warning": return "text-warning";
    case "danger": return "text-danger";
    case "info": return "text-primary";
    default: return "text-txt-muted";
  }
}

// Trade-Health readiness → honest visual tone. This maps the EXISTING shared
// `ScannerTruth.readiness` verdict (the Trade-Health contract) onto colour, and
// is DISPLAY-ONLY — it reads the already-decided verdict and never recomputes
// it. CORE RULE: only a genuinely LIVE_CONFIRMED read earns the emphasised
// success (green + ring) treatment, so a delayed / historical / awaiting /
// unavailable read can NEVER be dressed up to look more trade-ready than it is.
function readinessTone(r: ScannerTruth["readiness"]): { container: string; label: string } {
  if (r.status === "blocked") return { container: "border-danger/40 bg-danger/5", label: "text-danger" };
  switch (r.dataFreshness) {
    case "LIVE_CONFIRMED":
      return { container: "border-success/45 bg-success/10 ring-1 ring-success/20", label: "text-success" };
    case "LIVE_DELAYED":
    case "HISTORICAL_ONLY":
      return { container: "border-warning/40 bg-warning/5", label: "text-warning" };
    case "AWAITING":
      return { container: "border-border bg-card", label: "text-txt-secondary" };
    default: // UNKNOWN
      return { container: "border-border bg-card", label: "text-txt-muted" };
  }
}

function formatPrice(p: number | null): string {
  if (p == null || !Number.isFinite(p)) return "—";
  return p.toLocaleString(undefined, { maximumFractionDigits: p >= 100 ? 2 : 5 });
}

export function ScannerHeaderSummary({ running }: { running: boolean }) {
  const [symbol] = useChartSymbol();
  const bare = bareSymbol(symbol);
  const [timeframe] = useScannerTimeframe();
  const { scannerTruth: truth, verdict } = useSymbolTruth(bare, timeframe);
  const { shouldShowAdminDiagnostics } = useTradingMode();
  const { name } = useAssistantName();
  const rubyStore = useRubyReadStore();
  const selectedActionStore = useSelectedActionStore();

  // ONE directional read: bias + stage come from the composed snapshot verdict
  // so the header can never disagree with the chart / Ruby surfaces about which
  // way the market is leaning (closes the header-vs-pill self-contradiction).
  const biasLabel = verdict ? BIAS_LABEL[verdict.bias] ?? "" : "";
  const stageLabel = verdict ? STAGE_LABEL[verdict.stage] ?? "" : "";
  const biasTone =
    verdict?.bias === "BULLISH"
      ? "text-success"
      : verdict?.bias === "BEARISH"
        ? "text-danger"
        : "text-primary";

  const price = formatPrice(truth?.candles.lastClose ?? null);
  const dataV = truth?.strip.data.verdict ?? "Unavailable";
  const tradingV = truth?.strip.trading.verdict ?? "Read-only";

  // Ruby cell reconciliation (Task #600): the base read CAPABILITY comes from the
  // shared contract, then is capped DOWN by the actual server read the panel ran
  // (lifted into the page store, keyed by symbol+timeframe). Header and panel call
  // the SAME pure monotonic cap, so the header can never claim a fuller read than
  // the panel actually produced. The timeframe is coerced to match the panel's
  // store key exactly.
  const sharedRead = rubyStore.get(bare, coerceVisibleTimeframe(timeframe));
  const rubyBase: RubyReadStatus = truth?.consolidated.rubyReadStatus ?? "NO_READ";
  const cappedRuby = resolveCappedRubyReadStatus(rubyBase, sharedRead, undefined, name);
  const rubyV: RubyVerdict = RUBY_STATUS_LABEL[cappedRuby.status];
  const rubyDetail = cappedRuby.reason ?? truth?.strip.ruby.detail ?? "";

  // Action cell + single "Why?" (Task #600): the Action cell shows the SELECTED
  // symbol+timeframe's verdict. The Focus scalp card lifts its setup-aware
  // verdict into the page store (keyed by bare symbol AND the timeframe it read);
  // the header consumes that ONLY for the SAME symbol+timeframe — coerced to the
  // panel's store key exactly like the Ruby cell above — so the cell can never
  // disagree with the card (e.g. card "Ready now" while the header's data-only
  // verdict reads "Wait for confirmation"), and a timeframe switch can never
  // leave a stale cross-timeframe verdict showing. With no published card verdict
  // for this symbol+timeframe it falls back to the data-only consolidated verdict
  // for that timeframe — the ONE precedence rule lives in the pure contract. The
  // "Why?" reason still comes from the consolidated block.
  // Resolved-verdict mirroring: `truth` here comes from the symbol+timeframe-
  // keyed truth source (null mid-switch — never a stale key), so a present
  // data-only verdict is ALWAYS a resolved scanner verdict for the CURRENT
  // selection, computed from the same candles the chart renders. The shared
  // display resolver therefore renders ANY resolved verdict immediately —
  // including the data-only WAIT_FOR_CONFIRMATION the chart shows as its own
  // "wait" state — and reserves the neutral PENDING ("Checking…") state for
  // the ONLY genuinely-unresolved gap: no lifted verdict AND no truth verdict
  // for this key. The Action cell can never sit on "Checking…" while the
  // chart already displays a resolved verdict.
  //
  // BOUNDED pending (finite state resolution): PENDING is a transition, never
  // a terminal state. If NO verdict ever arrives for this key (the truth read
  // never lands — dead feed / failed fetch), then once PENDING has shown for
  // PENDING_RESOLVE_TIMEOUT_MS the shared resolver converts it to the FINAL
  // honest "No confirmation" state. The timer is keyed by symbol+timeframe:
  // any switch starts a fresh window; expiry never overrides a resolved
  // verdict (lifted or data-only).
  const coercedTf = coerceVisibleTimeframe(timeframe);
  const pendingKey = `${bare}|${coercedTf}`;
  const liftedAction = selectedActionStore.get(bare, coercedTf);
  const dataOnlyAction = truth?.consolidated.scannerActionability ?? null;
  const provisionalAction = resolveSelectedSymbolActionabilityDisplay(liftedAction, dataOnlyAction);
  const [expiredPendingKey, setExpiredPendingKey] = useState<string | null>(null);
  const isPendingNow = provisionalAction === "PENDING";
  useEffect(() => {
    if (!isPendingNow) return;
    const t = setTimeout(() => setExpiredPendingKey(pendingKey), PENDING_RESOLVE_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [isPendingNow, pendingKey]);
  const finalAction = resolveSelectedSymbolActionabilityDisplay(
    liftedAction,
    dataOnlyAction,
    expiredPendingKey === pendingKey,
  );
  // Eleanor-feed gate: when Eleanor has actually read the chart and found the
  // feed unconfirmed (sharedRead.gated === true), propagate her stricter result
  // downward — both capping READY_NOW to WAIT_FOR_CONFIRMATION (so the action
  // status itself never claims "ready" while Eleanor says the feed is unconfirmed)
  // and nulling the direction (so no directional label leaks on an unconfirmed
  // read). Convergence is downward-only — this can only restrict, never promote.
  // DISPLAY-ONLY: no execution gate, verdict, tone, or pipeline changes.
  const eleanorFeedGated = sharedRead?.gated === true;
  const finalActionWithEleanor: ScannerActionabilityDisplay = (
    eleanorFeedGated && finalAction === "READY_NOW"
  ) ? "WAIT_FOR_CONFIRMATION" : finalAction;
  // The display resolver is total: it always yields a display state (verdict,
  // PENDING, NO_CONFIRMATION, or CHECK_FAILED) — the cell never shows a bare
  // "Waiting" placeholder.
  const actionUi = actionabilityDisplayUi(finalActionWithEleanor);
  const actionDirection = eleanorFeedGated ? null : biasToActionDirection(verdict?.bias);
  const visibleActionLabel = resolveVisibleActionLabel(finalActionWithEleanor, actionDirection);
  const whyMessage = truth?.consolidated.userMessage ?? "";
  const whyCode = truth?.consolidated.internalReasonCode ?? "";

  return (
    <div className="space-y-3">
      {/* Hero */}
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 ring-1 ring-primary/25">
          <Crosshair className="h-5 w-5 text-primary" />
        </span>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold leading-tight">Market Scanner</h1>
          <p className="text-sm text-txt-secondary">Find setups, compare opportunities, and let {name} explain the market.</p>
        </div>
      </div>

      {/* Identity row — symbol · timeframe · price */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="font-mono font-semibold">{symbol}</span>
        <Dot />
        <span className="text-txt-secondary">{timeframe}</span>
        <Dot />
        <span className="font-mono">{price}</span>
        <Dot />
        <span className={cn("font-medium", running ? "text-primary" : "text-txt-muted")}>{running ? "Scanning" : "Idle"}</span>
        {biasLabel && (<><Dot /><span className={cn("font-semibold", biasTone)}>{biasLabel}</span></>)}
        {stageLabel && (<><Dot /><span className="text-txt-secondary">{stageLabel}</span></>)}
      </div>

      {/* Trade-Health readiness — the ONE shared read-quality verdict
          (truth.readiness, the Trade-Health contract) surfaced prominently so a
          user sees AT A GLANCE whether this read is live-confirmed or only
          delayed / historical / awaiting BEFORE parsing the four pills below.
          DISPLAY-ONLY: it reads the EXISTING ScannerTruth.readiness verdict and
          derives nothing new — only a genuinely LIVE_CONFIRMED read gets the
          emphasised green treatment, so a stale/weak read is never made to look
          more trade-ready than it is. Guarded on truth.readiness so a partial
          payload can never crash the header. */}
      {truth?.readiness && (() => {
        const r = truth.readiness;
        const tone = readinessTone(r);
        return (
          <div
            className={cn("flex items-center gap-2.5 rounded-xl border px-3 py-2", tone.container)}
            data-testid="scanner-header-readiness"
          >
            <Activity className={cn("h-4 w-4 shrink-0", tone.label)} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-xs uppercase tracking-wide text-txt-muted">Trade Health</span>
                <span className={cn("text-sm font-semibold", tone.label)} data-testid="scanner-header-readiness-label">
                  {r.displayLabel}
                </span>
              </div>
              {r.userFacingTrustLine && (
                <p className="mt-0.5 line-clamp-1 text-[11px] leading-snug text-txt-secondary" data-testid="scanner-header-readiness-trust">
                  {r.userFacingTrustLine}
                </p>
              )}
            </div>
          </div>
        );
      })()}

      {/* ONE truth strip — Data / Ruby / Trading / Action (single source). All
          four cells derive from the SAME shared contract, so they can never
          disagree with each other or with a card's badge. */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4" data-testid="scanner-header-strip">
        <TruthPill label="Data" verdict={dataV} tone={dataTone(dataV)} detail={truth?.strip.data.detail ?? "Waiting for market data…"} testId="scanner-header-data" />
        <TruthPill label={name} verdict={rubyV} tone={rubyTone(rubyV)} detail={rubyDetail} testId="scanner-header-ruby" />
        <TruthPill label="Trading" verdict={tradingV} tone={tradingTone(tradingV)} detail={truth?.strip.trading.detail ?? ""} testId="scanner-header-trading" />
        <TruthPill
          label="Action"
          verdict={visibleActionLabel}
          tone={actionTone(actionUi.tone)}
          detail={actionUi.copy}
          testId="scanner-header-action"
          prominent
        />
      </div>

      {/* ONE expandable "Why?" — explains, from the contract's single governing
          userMessage / internalReasonCode, exactly why action is allowed,
          limited, or blocked for the selected symbol. There is no second
          explanation surface in the header. */}
      {truth && (
        <details className="rounded-xl border border-border bg-card px-3 py-2" data-testid="scanner-why-panel">
          <summary className="cursor-pointer list-none text-xs font-medium text-txt-secondary [&::-webkit-details-marker]:hidden" data-testid="scanner-why-toggle">
            Why? <span className="text-txt-muted">— what the scanner is allowing right now</span>
          </summary>
          <p className="mt-1.5 text-[12px] leading-snug text-txt-secondary" data-testid="scanner-why-message">
            {whyMessage}
          </p>
          {shouldShowAdminDiagnostics && whyCode && (
            <p className="mt-1 font-mono text-[11px] text-txt-muted" data-testid="scanner-why-code">
              reason: {whyCode}
            </p>
          )}
        </details>
      )}

      {/* Honest, plain-English source line for EVERYONE. Says WHERE the chart
          bars come from (broker feed vs ARX market data vs synthetic). A
          connected MT5 execution bridge never makes this claim broker-live, so
          the header can't imply live broker bars when only execution is online. */}
      {truth && (
        <p className="text-[11px] text-txt-secondary" data-testid="scanner-header-source-note">
          {truth.dataHealth.sourceNote}
        </p>
      )}

      {shouldShowAdminDiagnostics && truth && (
        <p className="text-[11px] text-txt-muted">
          source: {truth.candles.sourceTechnical} · candles {truth.candles.count}/{truth.candles.minRequired} · {truth.candles.status}
        </p>
      )}
      {shouldShowAdminDiagnostics && truth?.consolidated.readId && (
        <p className="font-mono text-[11px] text-txt-muted" data-testid="scanner-header-read-id">
          read-id: {truth.consolidated.readId}
        </p>
      )}
    </div>
  );
}

function TruthPill({ label, verdict, tone, detail, testId, prominent }: { label: string; verdict: string; tone: string; detail: string; testId?: string; prominent?: boolean }) {
  return (
    <div
      className={cn(
        "flex h-full flex-col rounded-xl border px-3 py-2",
        prominent ? "border-primary/40 bg-primary/5 ring-1 ring-primary/15" : "border-border bg-card",
      )}
      data-testid={testId}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs uppercase tracking-wide text-txt-muted">{label}</span>
        <span className={cn("text-sm font-semibold", tone)}>{verdict}</span>
      </div>
      {detail && <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-txt-secondary">{detail}</p>}
    </div>
  );
}

function Dot() {
  return <span className="text-txt-muted">·</span>;
}
