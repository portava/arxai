import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Sparkles, Loader2, RefreshCw, MessageCircle, Crosshair, ShieldAlert } from "lucide-react";
import { FeedConfidenceBadge } from "@/components/charts/FeedConfidenceBadge";
import { RubyReasoningBlock } from "@/components/ruby/RubyReasoningBlock";
import { buildReasoningFromChartRead } from "@/lib/rubyReasoningBlock";
import { useScannerTruth } from "@/hooks/useScannerTruth";
import {
  resolveRubyReadPanelState,
  type ChartRead,
} from "@/lib/rubyReadPanelState";
import { useRubyReadStore } from "@/components/scanner/rubyReadStore";
import { useAssistantName } from "@/lib/assistant-name";
import {
  actionabilityDisplayUi,
  resolveVisibleActionButtonLabel,
  type ScannerActionabilityDisplay,
  type ActionDirection,
} from "@/lib/scannerActionability";

// RubyChartRead — a compact, on-demand "Ruby reads this chart" panel.
//
// SAFETY: routes ONLY through the read-only assistant pipeline
// (`POST /api/me/assistant/read-chart`), which returns
// `{ readOnlyMode:true, safetyMode:"paper_only", liveLocked:true }`. Ruby can
// NEVER place, modify, or close a trade from here — it only reads the REAL
// candles the user is looking at into a structured, plain-English read with
// higher-timeframe bias and conditional buy/sell triggers. It never forces a
// trade when confidence is low, and never fabricates prices.
//
// FEED HONESTY: before (and after) a read, the panel surfaces the SHARED scanner
// truth for the exact symbol/timeframe (the ONE `useScannerTruth` contract every
// scanner surface consumes — Task #391). When that truth is not fully actionable
// (analysis.level !== "full") it shows a clear "feed not confirmed" notice and
// forwards `aiUsable: false` to the endpoint so the read is stamped
// `dataQuality: "insufficient"` — Ruby never silently reads a stale/invalid feed,
// and never disagrees with the header strip / chart / read-gate.

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

function biasTone(bias: string): string {
  const b = bias.toLowerCase();
  if (b.includes("bull")) return "text-success";
  if (b.includes("bear")) return "text-danger";
  if (b.includes("range")) return "text-primary";
  return "text-txt-secondary";
}

function confTone(conf: string): string {
  const c = conf.toLowerCase();
  if (c === "high") return "text-success";
  if (c === "medium") return "text-warning";
  return "text-txt-muted";
}

export function RubyChartRead({
  symbol,
  timeframe,
  draft,
  aiUsable: aiUsableProp,
  canonicalAction,
  canonicalDirection,
  canonicalReadId,
}: {
  symbol: string;
  timeframe: string;
  draft: { side: "BUY" | "SELL"; entry: number; sl: number; tp: number } | null;
  /**
   * Optional override of the Level 3 feed verdict from a parent that already
   * tracks it (e.g. an ARXNativeChart `onChartContextChange`). When omitted, the
   * panel resolves the verdict itself from the feed-status contract.
   */
  aiUsable?: boolean;
  /**
   * Canonical verdict from the parent's shared scanner-truth cycle. When provided,
   * the "Prepare Trade" button is display-gated on this verdict (canAct) so the
   * Eleanor panel can never show an actionable CTA while the header/chart say wait.
   * Convergence is downward-only — this can only restrict, never grant, affordances.
   * Display-only: no execution gate touches this.
   */
  canonicalAction?: ScannerActionabilityDisplay;
  /**
   * Direction derived from the canonical verdict's bias (BUY | SELL | null).
   * Drives the directional button label ("Prepare Conditional Buy", "Prepare Sell").
   */
  canonicalDirection?: ActionDirection;
  /**
   * Stable read-cycle ID from the parent consolidated truth block. Attached as a
   * data attribute in dev builds for cross-surface tracing.
   */
  canonicalReadId?: string;
}) {
  // The server read is lifted to a page-level store keyed by symbol+timeframe
  // (Task #600) so the header strip's Ruby cell shares the SAME read and the two
  // can never disagree. Switching symbol/timeframe reads a different key (an
  // empty key = honest pre-read state). Loading/error stay local to this panel.
  const { name } = useAssistantName();
  const store = useRubyReadStore();
  const read = store.get(symbol, timeframe);
  const setRead = (next: ChartRead | null) => store.set(symbol, timeframe, next);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Resolve the SHARED scanner truth for this exact symbol/timeframe so the
  // panel can warn the user BEFORE Ruby reads a stale or invalid feed — and so
  // its verdict can never diverge from the header strip / chart / read-gate.
  const { truth, feedStatus } = useScannerTruth(symbol, timeframe);

  // ONE derived verdict (Task #506). The badge, banner, and body all read from
  // this single resolution — the shared scanner truth folded together with the
  // server read-chart response — so they can never render contradictory claims
  // (e.g. badge "Clean · AI" + banner "not confirmed" + body "cannot verify").
  const panel = resolveRubyReadPanelState({
    truthLevel: truth?.analysis.level ?? null,
    truthReason: truth?.analysis.reason ?? null,
    aiUsableProp,
    read,
  });
  const feedNotConfirmed = panel.feedNotConfirmed;
  // Task #602 — a directional STRUCTURAL read is available, but the exact live
  // setup (entry/stop/target) is withheld until the feed confirms. This is a
  // distinct, more-informative state than a bare "feed not confirmed" block.
  const structuralOnly = panel.verdict === "structural_only";
  const reportedAiUsable = panel.reportedAiUsable;

  // Canonical verdict gate (display-only). When the parent passes its shared
  // consolidated actionability, the Prepare Trade CTA is gated on canAct so the
  // Eleanor panel can never offer an actionable button while the header/chart
  // surface shows a degraded / wait state. Convergence is downward-only — this
  // can only restrict the button, never grant affordances beyond what the canonical
  // verdict permits. When no canonical is provided (e.g. standalone use), fall back
  // to PENDING which resolves to canAct: false (safe default).
  const canonicalUi = actionabilityDisplayUi(canonicalAction ?? "PENDING");
  const buttonLabel = resolveVisibleActionButtonLabel(
    canonicalAction ?? "PENDING",
    canonicalDirection ?? null,
  );

  const ask = async () => {
    setLoading(true);
    setErr(null);
    try {
      const body = {
        symbol,
        timeframe,
        ...(reportedAiUsable != null ? { aiUsable: reportedAiUsable } : {}),
        ...(draft ? { draft } : {}),
      };
      const r = await fetch(`${BASE}/api/me/assistant/read-chart`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { chartRead: ChartRead };
      setRead(j.chartRead);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "network error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-2xl border border-ruby/25 bg-card p-4" data-testid="ruby-chart-read">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-ruby/15 text-ruby ring-1 ring-ruby/25">
          <Sparkles className="h-[18px] w-[18px]" />
        </span>
        <span className="text-[15px] font-semibold text-foreground">{name} Chart Read</span>
        {/* Level 3 feed-quality chip — capped by the ONE resolved verdict so it
            can never read Clean/AI when the panel says the feed isn't confirmed. */}
        <FeedConfidenceBadge feedStatus={feedStatus} aiUsableResolved={panel.badgeAiUsable} />
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-8 gap-1.5 px-3 text-xs"
          disabled={loading}
          onClick={() => void ask()}
          data-testid="ruby-chart-read-ask"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {read ? "Re-read" : draft ? "Read my plan" : "Read this chart"}
        </Button>
      </div>

      {/* Feed-not-confirmed notice — shown whenever the ONE resolved verdict says
          the feed isn't confirmed. The appended reason is resolved to describe the
          SAME dimension that drove the downgrade, so the header and reason can
          never contradict (never "not confirmed" + "valid for a live read"). */}
      {feedNotConfirmed && (
        <div
          className="mt-3 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
          data-testid="ruby-chart-read-feed-warning"
        >
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Feed not confirmed — {name} may have limited visibility on {symbol} {timeframe}.
            {panel.reason ? ` ${panel.reason}` : ""}
          </span>
        </div>
      )}

      {/* Structural-read notice (Task #602) — a directional read IS available,
          but the exact entry/stop/target are withheld until the feed confirms.
          Distinct from the hard "feed not confirmed" block above so the user
          knows the structure below is real and only the live setup is pending. */}
      {structuralOnly && (
        <div
          className="mt-3 flex items-start gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-xs text-primary"
          data-testid="ruby-chart-read-structural-notice"
        >
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Structural read available — exact entry, stop, and target are withheld until {symbol} {timeframe} confirms.
            {panel.reason ? ` ${panel.reason}` : ""}
          </span>
        </div>
      )}

      {err && <div className="mt-2 text-sm text-danger" data-testid="ruby-chart-read-err">{name} couldn't read this chart ({err}).</div>}

      {!read && !err && (
        <p className="mt-3 text-sm text-txt-secondary">Tap “Read this chart” and {name} will break down bias, conditions, levels, and risk for {symbol} {timeframe}.</p>
      )}

      {/* Gated read — the server could not verify the feed, so there is no
          directional structure to show. Surface the honest reason instead. */}
      {read && read.gated && (
        <div className="mt-3 space-y-2" data-testid="ruby-chart-read-gated">
          {read.headline && <p className="text-sm text-txt-secondary">{read.headline}</p>}
          {read.blockedReason && <p className="text-xs text-txt-muted">{read.blockedReason}</p>}
          {read.disclaimer && <p className="text-[10px] italic text-txt-muted">{read.disclaimer}</p>}
        </div>
      )}

      {read && !read.gated && (
        <div className="mt-3 space-y-3" data-testid="ruby-chart-read-body">
          {/* Bias / Confidence / HTF row */}
          <div className="grid grid-cols-3 gap-2 rounded-xl border border-border bg-background/40 p-3">
            <Metric label="Bias" value={read.bias ?? "—"} className={biasTone(read.bias ?? "")} testid="ruby-chart-read-bias" />
            <Metric label="Confidence" value={read.confidence ?? "—"} className={confTone(read.confidence ?? "")} />
            <Metric label="HTF Bias" value={read.htfBias ?? "—"} className={biasTone(read.htfBias ?? "")} />
          </div>

          {/* Ruby's full reasoning — ALWAYS visible (no accordion). Honesty flags
              from the ONE panel verdict flow into the builder, so a structural-only
              / unconfirmed read renders WAIT/conditional with the limitation stated
              in Feed/Data and never fabricates a direction or level. */}
          <RubyReasoningBlock
            data={buildReasoningFromChartRead({
              read,
              symbol,
              timeframe,
              structuralOnly,
              feedNotConfirmed,
              reason: panel.reason,
            }, name)}
            testid="ruby-chart-read-reasoning"
          />

          {read.disclaimer && <p className="text-[10px] italic text-txt-muted">{read.disclaimer}</p>}

          {/* Actions — "Prepare Trade" CTA is display-gated on the canonical verdict
              so the Eleanor panel can never show an actionable CTA while the
              header/chart surface shows a degraded or wait state. Downward-only. */}
          <div
            className="grid grid-cols-2 gap-2 pt-1"
            {...(import.meta.env.DEV && canonicalReadId ? { "data-canonical-read-id": canonicalReadId } : {})}
          >
            {canonicalUi.canAct ? (
              <Link
                href="/trade-command-room"
                className="flex h-10 items-center justify-center gap-1.5 rounded-xl bg-primary text-sm font-semibold text-white hover:bg-primary/90"
                data-testid="ruby-chart-prepare-trade"
              >
                <Crosshair className="h-4 w-4" /> {buttonLabel}
              </Link>
            ) : (
              <button
                type="button"
                className="flex h-10 cursor-not-allowed items-center justify-center gap-1.5 rounded-xl bg-primary/30 text-sm font-semibold text-white/50"
                disabled
                data-testid="ruby-chart-prepare-trade"
                title={canonicalUi.copy}
              >
                <Crosshair className="h-4 w-4" /> {buttonLabel}
              </button>
            )}
            <Link href="/ai-command-center" className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-ruby/30 text-sm font-semibold text-ruby hover:bg-ruby/10" data-testid="ruby-chart-ask-ruby">
              <MessageCircle className="h-4 w-4" /> Ask {name}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, className, testid }: { label: string; value: string; className?: string; testid?: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-txt-muted">{label}</div>
      <div className={`text-sm font-bold ${className ?? "text-foreground"}`} data-testid={testid}>{value}</div>
    </div>
  );
}

export default RubyChartRead;
