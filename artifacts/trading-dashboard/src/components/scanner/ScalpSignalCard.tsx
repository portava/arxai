import { useEffect, useState, type ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Zap, Eye, Sparkles, AlertTriangle, Clock, Flame } from "lucide-react";
import type { ScalpResult, ScalpResultStatus } from "@workspace/api-client-react";
import { evaluateMarketDataSufficiency, MIN_SUFFICIENT_CLOSED_BARS } from "@workspace/domain/market";
import {
  resolveScannerActionability,
  SCANNER_ACTIONABILITY_UI,
  type ActionDirection,
  type ScannerActionability,
} from "@/lib/scannerActionability";
import { RubyChartRead } from "@/components/scanner/RubyChartRead";
import { SetupSignalStrip } from "@/components/signals/SetupSignalStrip";
import {
  scalpStatusToSetup,
  scalpStatusLabel,
  isScalpAwaitingFeed,
  hasKnownScalpRejectReason,
  scalpBusTimeframe,
  scalpEngineTimeframe,
  SCALP_ENGINE_FALLBACK_TIMEFRAME,
  SCALP_STATUS_TONE,
  SCALP_MODE_LABEL,
  SCALP_TIMING_LABEL,
  SCALP_TARGET_REALITY_LABEL,
  FLAME_SCALP_STATUS_LABEL,
  FLAME_SCALP_STATUS_TONE,
  FLAME_STAGE_LABEL,
  FLAME_STAGE_TONE,
  FLAME_FRESHNESS_LABEL,
  FLAME_TIMING_LABEL,
  FLAME_CHASE_LABEL,
  FLAME_RUNWAY_LABEL,
  FLAME_EXECUTION_LABEL,
  FLAME_HTF_LABEL,
  FLAME_SETUP_LABEL,
  flameChaseTone,
  flameRunwayTone,
  directionTone,
  riskTone,
  fmtPrice,
  fmtScalpMoney,
  fmtRr,
} from "./scalpLabels";
import { RubyReasoningBlock } from "@/components/ruby/RubyReasoningBlock";
import { buildReasoningFromScalp } from "@/lib/rubyReasoningBlock";
import { useAssistantName } from "@/lib/assistant-name";
import { useEvidenceDeadline } from "@/hooks/useEvidenceDeadline";

// ScalpSignalCard — one shared, mobile-clean card that renders a single
// Ruby Scalp Signal (the `ScalpResult` the shared engine produced). Used by
// the Focus card, the Broad-scan ranking picks, and the Builder result so
// the three surfaces always look and behave identically.
//
// SAFETY: this card NEVER places a trade. "Build Scalp Trade" only calls the
// parent-provided onBuild handler, which routes through the existing gated
// trade ticket (every server safety gate re-runs there). All numbers come
// from the engine result — there is no client-side fabrication. Raw engine
// status tokens stay in data-* attributes; visible copy is plain English.

// A standalone signal/metric label wrapped with a one-line plain-English
// hover/tap tooltip (Task #388). The Scanner cards surface several bare
// metric labels (confidence, spread/slippage/news risk, freshness, quality,
// reward:risk, flame score, and the flame execution chips) that the shared
// SetupSignalStrip does NOT cover. Mirroring the strip's approach, each
// tooltip explains what the metric MEASURES and how to read it — never the
// current reading itself — so the explanation stays honest in every state
// (including "not consulted"/blind reads where no value is shown).
function Tip({
  help,
  children,
  className,
}: {
  help: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={`cursor-help ${className ?? ""}`}>{children}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[16rem] text-[11px] leading-snug">
        {help}
      </TooltipContent>
    </Tooltip>
  );
}

// The Focus scalp engine reads M5 (server SCALP_TIMEFRAME; every Focus result
// carries it as `timeframe`). Its lifted action verdict is therefore an M5
// verdict — published under the SCANNER BUS form of the engine timeframe ("5m")
// so the header adopts it ONLY when the user is viewing 5m, never under the 1m
// cell (owner screenshot 2026-10-27: an M5 "Feed limited" sat under V75 1m).
// This constant is the key used before any result exists (the CHECK_FAILED
// marker); a result's own `timeframe` always decides its publish key.
export const SCALP_SIGNAL_BUS_TIMEFRAME =
  scalpBusTimeframe({ timeframe: SCALP_ENGINE_FALLBACK_TIMEFRAME }) ?? "5m";

export function ScalpSignalCard({
  result,
  onBuild,
  onWatch,
  compact = false,
  highlightLabel,
  onActionability,
}: {
  result: ScalpResult;
  onBuild?: (r: ScalpResult) => void;
  onWatch?: (r: ScalpResult) => void;
  compact?: boolean;
  highlightLabel?: string;
  /** Publish (or retract with null) this card's verdict for symbol+timeframe. */
  onActionability?: (
    symbol: string,
    timeframe: string,
    a: ScannerActionability | null,
    side?: ActionDirection,
  ) => void;
}) {
  const r = result;
  const { name } = useAssistantName();
  const [askRuby, setAskRuby] = useState(false);

  const flame = r.flame;
  const flameLive = flame != null && !flame.blind;

  // READABILITY CONTRACT (display-only): route the direction/confidence affordance
  // through the ONE shared data-sufficiency contract instead of hard-coding a
  // status check, so this surface can never drift from the scanner, Ruby, and
  // chart reads (identical mayShow* flags + reasonCode app-wide). The scalp ENGINE
  // is the authority on scalp data readiness — it collapses ANY non-live /
  // insufficient read to AWAITING_DATA across BOTH the candle-backed Focus path
  // and the intentionally-blind, scanner-backed Broad path. We map that single
  // readiness bit onto the shared contract (a ready read => live + sufficiently
  // back-filled; an AWAITING_DATA read => awaiting feed) rather than re-deriving a
  // candle count, which would wrongly hide the intentionally-blind Broad reads.
  // Display-only — build/watch eligibility is re-gated server-side on every action
  // regardless of what is shown here.
  //
  // AWAITING_DATA has four engine reasons. Only the feed/data ones (no scanner
  // read / not live / insufficient — or an unnamed reason from an older server,
  // fail-closed) collapse the data cap. NO_SPECS means the feed passed every
  // check and the scalp stopped only because the broker's symbol details are
  // unavailable — that is never shown as "Feed limited".
  const scalpDataReady = !isScalpAwaitingFeed(r);
  const engineTf = scalpEngineTimeframe(r);
  const readability = evaluateMarketDataSufficiency({
    symbol: r.symbol,
    timeframe: engineTf,
    freshnessVerdict: scalpDataReady ? "LIVE" : "AWAITING",
    availableClosedCandles: scalpDataReady ? MIN_SUFFICIENT_CLOSED_BARS : 0,
  });
  const directionReadable = readability.mayShowDirection;
  const confidenceReadable = readability.mayShowConfidence;

  // The ONE shared scanner action verdict (Task #600). The data cap derives from
  // the engine's single readiness bit (AWAITING_DATA collapses ANY non-live read)
  // so it never re-queries the feed and never drifts from the contract; the setup
  // readiness comes from the engine status. The verdict gates the Build button on
  // top of the server's `canBuildTrade` (stricter wins → fail toward NOT trading),
  // guaranteeing the card can never offer an enabled action the unified verdict
  // would deny. Display-only — every action re-runs all server safety gates.
  const actionability = resolveScannerActionability(
    {
      quoteStatus: scalpDataReady ? "LIVE" : "UNAVAILABLE",
      candleStatus: scalpDataReady ? "CONFIRMED" : "UNAVAILABLE",
      chartIntelligenceStatus: scalpDataReady ? "FULL" : "UNAVAILABLE",
    },
    scalpDataReady ? scalpStatusToSetup(r.status) : "UNKNOWN",
  );
  const actionUi = SCANNER_ACTIONABILITY_UI[actionability];

  // The scalp read is one-shot (the Focus card does not poll). Past its
  // server-declared expiresAt — or with no parseable expiresAt — it is not a
  // current read: its verdict is retracted from the page (the header and chart
  // fall back to the current data-only verdict), Build is disabled, and the
  // card says the read expired instead of "Valid now".
  const expiresAtMs = typeof r.expiresAt === "string" ? Date.parse(r.expiresAt) : NaN;
  const expiryNowMs = useEvidenceDeadline(Number.isFinite(expiresAtMs) ? expiresAtMs : null);
  const scalpExpired = !(Number.isFinite(expiresAtMs) && expiryNowMs < expiresAtMs);

  // Lift the ONE selected-symbol verdict to the page (Task #600): the Focus card
  // passes onActionability so the header's Action cell shows EXACTLY this card's
  // setup-aware verdict instead of its own data-only one. Keyed by r.symbol (the
  // engine's bare symbol) AND the bus form of the engine timeframe the result
  // was read on ("5m" for M5) — matching the rubyReadStore symbol+timeframe
  // convention — so the header only adopts this verdict when the user is
  // actually viewing that timeframe, and a timeframe switch can never leave an
  // M5 verdict showing under another timeframe (e.g. 1m). MUST sit
  // after `actionability` is declared (temporal-dead-zone trap). Other render
  // sites omit the prop, so only the Focus card publishes.
  //
  // What may be lifted: any non-AWAITING verdict, and a feed-reason
  // AWAITING_DATA the server explicitly named (a genuine engine-timeframe feed
  // verdict). NOT lifted (retracted with null so a stale earlier verdict can't
  // survive a refresh): NO_SPECS — the engine never evaluated a setup, so the
  // header falls back to its own data-only verdict — and an AWAITING_DATA with no
  // named reason, whose feed state this card cannot vouch for.
  const busTf = scalpBusTimeframe(r);
  const liftable =
    r.status !== "AWAITING_DATA" || (isScalpAwaitingFeed(r) && hasKnownScalpRejectReason(r));
  const published: ScannerActionability | null = liftable && !scalpExpired ? actionability : null;
  // The scalp's OWN side, published alongside the verdict so the header can
  // drop a contradicting side from its label (never add one).
  const publishedSide: ActionDirection =
    published != null && (r.direction === "BUY" || r.direction === "SELL") ? r.direction : null;
  useEffect(() => {
    if (!busTf) return;
    onActionability?.(r.symbol, busTf, published, publishedSide);
  }, [r.symbol, busTf, published, publishedSide, onActionability]);

  const borderColor =
    r.direction === "BUY" ? "#10b981" : r.direction === "SELL" ? "#f43f5e" : "#3f3f46";

  const entry =
    r.entryZone != null
      ? `${fmtPrice(r.entryZone.from, r.digits)} – ${fmtPrice(r.entryZone.to, r.digits)}`
      : fmtPrice(r.currentPrice, r.digits);

  return (
    <TooltipProvider delayDuration={150}>
    <Card
      className="border-l-4"
      style={{ borderLeftColor: borderColor }}
      data-testid={`scalp-card-${r.symbol}`}
      data-scalp-status={r.status}
      data-scalp-action={r.userAction}
      data-actionability={actionability}
    >
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2 min-w-0">
            <span className="truncate">{r.displayName || r.symbol}</span>
            {highlightLabel && (
              <Badge className="bg-ruby/15 text-ruby border-ruby/30 text-[10px] shrink-0">
                {highlightLabel}
              </Badge>
            )}
          </CardTitle>
          <Badge
            className={`${SCALP_STATUS_TONE[r.status]} text-xs shrink-0`}
            data-status-token={r.status}
          >
            {scalpStatusLabel(r)}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {r.direction && directionReadable && (
            <Badge className={`${directionTone(r.direction)} text-xs`}>{r.direction}</Badge>
          )}
          <Badge variant="outline" className="text-xs">{SCALP_MODE_LABEL[r.mode]}</Badge>
          <Badge variant="outline" className="text-xs">{r.scalpType}</Badge>
          {confidenceReadable && (
            <Tip help="How confident the scalp engine is in this signal overall — higher confidence means the setup's conditions line up more cleanly. It's a read, not a guarantee.">
              <Badge variant="outline" className="text-xs">{r.confidenceLabel}</Badge>
            </Tip>
          )}
          <Tip
            className="ml-auto text-[10px] text-muted-foreground flex items-center gap-1"
            help="Whether now is a good moment to act on this setup — it flags if the ideal entry window is open, still early, or already passing."
          >
            <Clock className="h-3 w-3" />
            {scalpExpired ? "Expired" : SCALP_TIMING_LABEL[r.timingStatus]}
          </Tip>
        </div>

        {/* Flame read row — only shown when the engine actually read live candles. */}
        {flameLive && flame && (
          <div
            className="flex flex-wrap items-center gap-1.5 pt-1.5"
            data-testid={`scalp-flame-${r.symbol}`}
            data-flame-status={flame.scalpStatus}
            data-flame-stage={flame.flameStage}
          >
            <Badge className={`${FLAME_SCALP_STATUS_TONE[flame.scalpStatus]} text-xs`}>
              {FLAME_SCALP_STATUS_LABEL[flame.scalpStatus]}
            </Badge>
            <Badge className={`${FLAME_STAGE_TONE[flame.flameStage]} text-xs flex items-center gap-1`}>
              <Flame className="h-3 w-3" />
              {FLAME_STAGE_LABEL[flame.flameStage]}
            </Badge>
            <Tip help="The flame's momentum-quality score out of 100 — higher means a stronger, cleaner move with more conviction behind it. It's a read, not a guarantee.">
              <Badge variant="outline" className="text-xs font-mono" data-testid={`scalp-flame-score-${r.symbol}`}>
                {flame.scalpScore}/100
              </Badge>
            </Tip>
            <Tip
              className="ml-auto text-[10px] text-muted-foreground"
              help="How recent the live candle read behind this signal is — a fresher read is more reliable, while a stale read means the signal may be out of date."
            >
              {scalpExpired ? "Read expired" : FLAME_FRESHNESS_LABEL[flame.freshness]}
              {!scalpExpired && flame.flameAgeCandles > 0 ? ` · ${flame.flameAgeCandles} ${flame.flameAgeCandles === 1 ? "candle" : "candles"}` : ""}
            </Tip>
          </div>
        )}
      </CardHeader>

      <CardContent className="text-xs space-y-2.5">
        {/* Shared glanceable signal strip (Task #383) — the same honest readout
            the chart AI setup-preview card shows. Every value is read straight
            from this card's existing ScalpResult; signals the scalp engine
            doesn't surface to the client (risk score, team governance) are
            never fabricated and are hidden rather than shown as fake values. */}
        <SetupSignalStrip
          signals={{
            scannerScore: r.qualityScore,
            riskScore: null,
            flameStage: flameLive && flame ? flame.flameStage : null,
            runOnQuality: null,
            governanceOutcome: null,
          }}
          testIdPrefix={`scalp-signal-${r.symbol}`}
          nullBehavior="hide"
        />

        <p className="text-sm text-foreground leading-snug" data-testid="scalp-reason">
          {r.plainEnglishReason}
        </p>

        {/* Price plan */}
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded border border-border bg-background/40 p-2">
            <div className="text-txt-muted">Entry zone</div>
            <div className="font-mono text-foreground">{entry}</div>
          </div>
          <div className="rounded border border-border bg-background/40 p-2">
            <div className="text-txt-muted">Stop loss</div>
            <div className="font-mono text-danger">{fmtPrice(r.stopLoss, r.digits)}</div>
          </div>
        </div>

        {/* Take-profit ladder */}
        <div className="grid grid-cols-3 gap-1 text-center">
          <div className="rounded border border-border p-1.5">
            <div className="text-txt-muted">Quick TP</div>
            <div className="font-mono text-success">{fmtPrice(r.takeProfit.quick, r.digits)}</div>
          </div>
          <div className="rounded border border-success/40 bg-success/10 p-1.5">
            <div className="text-txt-secondary">Main TP</div>
            <div className="font-mono text-success font-semibold">{fmtPrice(r.takeProfit.main, r.digits)}</div>
          </div>
          <div className="rounded border border-border p-1.5">
            <div className="text-txt-muted">Stretch TP</div>
            <div className="font-mono text-success">{fmtPrice(r.takeProfit.stretch, r.digits)}</div>
          </div>
        </div>

        {/* Sizing + money */}
        <div className="grid grid-cols-3 gap-1 text-center">
          <div className="rounded border border-border p-1.5">
            <div className="text-txt-muted">Lot size</div>
            <div className="font-mono font-semibold">{r.suggestedLot ?? "—"}</div>
          </div>
          <div className="rounded border border-border p-1.5">
            <div className="text-txt-muted">
              <Tip help="How much you stand to gain versus what you risk if the plan plays out — e.g. 2:1 means the target is twice the distance of the stop. Higher is better.">
                Reward : risk
              </Tip>
            </div>
            <div className="font-mono">{fmtRr(r.rewardToRisk)}</div>
          </div>
          <div className="rounded border border-border p-1.5">
            <div className="text-txt-muted">
              <Tip help="The scanner's overall quality score for this setup — a higher score means a cleaner, higher-conviction pattern.">
                Quality
              </Tip>
            </div>
            <div className="font-mono">{r.qualityScore}</div>
          </div>
        </div>

        {!compact && (
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded border border-border bg-background/40 p-2">
              <div className="text-txt-muted">Target profit (main TP)</div>
              <div className="font-mono text-success">{fmtScalpMoney(r.estimatedProfitMainTP, r.moneyCurrency)}</div>
            </div>
            <div className="rounded border border-border bg-background/40 p-2">
              <div className="text-txt-muted">Risk if stopped</div>
              <div className="font-mono text-danger">{fmtScalpMoney(r.estimatedRiskAmount, r.moneyCurrency)}</div>
            </div>
          </div>
        )}

        {/* Lot spec note — honours the broker's real min/step/max */}
        {(r.minLot != null || r.lotStep != null || r.maxLot != null) && (
          <p className="text-[10px] text-muted-foreground">
            Sized to your broker's limits — min {r.minLot ?? "—"}, step {r.lotStep ?? "—"}, max {r.maxLot ?? "—"}.
          </p>
        )}

        {/* Risk chips */}
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <Tip className="text-txt-muted" help="How wide the broker's buy/sell price gap is right now — a wider spread costs more to enter and exit, so a higher reading is worse for a quick scalp.">
            Spread <span className={riskTone(r.spreadRisk)}>{r.spreadRisk}</span>
          </Tip>
          <Tip className="text-txt-muted" help="The risk your order fills at a worse price than expected — higher in fast-moving or thin markets, which eats into a scalp's small target.">
            Slippage <span className={riskTone(r.slippageRisk)}>{r.slippageRisk}</span>
          </Tip>
          <Tip className="text-txt-muted" help="The risk of upcoming or recent news shaking this market — a higher reading means more event risk around now, so the move can turn sharply.">
            News{" "}
            {r.newsRiskUnchecked ? (
              <span className="text-warning" data-testid="scalp-news-unchecked">Unchecked</span>
            ) : r.newsRiskNotConfigured ? (
              <span
                className="text-warning"
                data-testid="scalp-news-not-configured"
                title="No economic calendar is configured, so scheduled news was not checked. This scalp is read from technicals only."
              >
                Not checked (no calendar)
              </span>
            ) : (
              <span className={riskTone(r.newsRisk)}>{r.newsRisk}</span>
            )}
          </Tip>
          {r.targetRealityCheck && (
            <Tip className="text-txt-muted ml-auto" help="A sanity check on whether the planned target is realistically reachable in current conditions — not just mathematically possible.">
              Target: {SCALP_TARGET_REALITY_LABEL[r.targetRealityCheck]}
            </Tip>
          )}
        </div>

        {/* Flame execution-quality chips — live read only. */}
        {flameLive && flame && (
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <Tip className="text-txt-muted" help="How well-timed an entry is right now within the move — it flags whether you're early, on time, or already late to the flame.">
              Timing <span className="text-foreground">{FLAME_TIMING_LABEL[flame.entryTiming]}</span>
            </Tip>
            <Tip className="text-txt-muted" help="How much you'd be chasing price by entering now — a higher chase means the move has already run, raising the risk of a poor entry.">
              Chase <span className={flameChaseTone(flame.chaseRisk)}>{FLAME_CHASE_LABEL[flame.chaseRisk]}</span>
            </Tip>
            <Tip className="text-txt-muted" help="How much room the move may still have before it stalls — more runway favours holding for the target, less warns it could be running out.">
              Runway <span className={flameRunwayTone(flame.runway)}>{FLAME_RUNWAY_LABEL[flame.runway]}</span>
            </Tip>
            <Tip className="text-txt-muted" help="How clean the conditions look for actually getting in and out on this setup right now — better execution quality means fewer surprises filling the trade.">
              Execution <span className="text-foreground">{FLAME_EXECUTION_LABEL[flame.executionQuality]}</span>
            </Tip>
            <Tip className="text-txt-muted ml-auto" help="How this setup sits within the higher-timeframe trend — being aligned with the bigger trend is generally more reliable than fighting it.">
              {FLAME_HTF_LABEL[flame.htfContext]}
            </Tip>
          </div>
        )}

        {/* ONE standardized, ALWAYS-VISIBLE Ruby Reasoning Block (no collapse).
            The scalp engine collapses any non-live / insufficient read to
            AWAITING_DATA, which the builder turns into WAIT + the limitation in
            Feed/Data with no fabricated direction or levels. Display only — this
            grants no execution permission; "Build Scalp Trade" still routes
            through every server gate. */}
        <RubyReasoningBlock
          data={buildReasoningFromScalp({
            result: r,
            patternLabel: flameLive && flame ? FLAME_SETUP_LABEL[flame.setupType] : null,
          })}
          testid={`scalp-reasoning-${r.symbol}`}
          dense
        />

        {r.chaseWarning && (
          <div className="flex items-start gap-1.5 text-warning">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>{r.chaseWarning}</span>
          </div>
        )}
        {r.riskWarning && (
          <div className="flex items-start gap-1.5 text-danger">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>{r.riskWarning}</span>
          </div>
        )}
        {scalpExpired && (
          <div
            className="flex items-start gap-1.5 rounded border border-warning/30 bg-warning/5 p-2 text-warning"
            data-testid={`scalp-expired-${r.symbol}`}
          >
            <Clock className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              {Number.isFinite(expiresAtMs)
                ? "This scalp read has expired — its status, entry and targets describe the market when it was read, not now. Refresh for a current read."
                : "This scalp read has no valid expiry time, so it can't be treated as current. Refresh for a current read."}
            </span>
          </div>
        )}
        {r.noTradeReason && (
          <div className="rounded border border-border bg-background/40 p-2 text-txt-secondary">
            {r.noTradeReason}
          </div>
        )}

        {/* Actions */}
        <div className="grid grid-cols-2 gap-2 pt-1">
          <Button
            className="h-11 text-sm font-bold bg-success hover:bg-success/90 text-white disabled:opacity-50"
            disabled={!r.canBuildTrade || !actionUi.canAct || scalpExpired || !onBuild}
            onClick={() => onBuild?.(r)}
            data-testid={`scalp-build-${r.symbol}`}
          >
            <Zap className="h-4 w-4 mr-1" />Build Scalp Trade
          </Button>
          {onWatch && r.canWatch ? (
            <Button
              variant="outline"
              className="h-11 text-sm"
              onClick={() => onWatch(r)}
              data-testid={`scalp-watch-${r.symbol}`}
            >
              <Eye className="h-4 w-4 mr-1" />Watch Setup
            </Button>
          ) : (
            <Button
              variant="outline"
              className="h-11 text-sm"
              onClick={() => setAskRuby((v) => !v)}
              data-testid={`scalp-ask-ruby-${r.symbol}`}
            >
              <Sparkles className="h-4 w-4 mr-1" />Ask {name}
            </Button>
          )}
        </div>

        {askRuby && (
          <RubyChartRead
            symbol={r.symbol}
            timeframe={engineTf}
            draft={
              r.direction && r.entryZone && r.stopLoss != null && r.takeProfit.main != null
                ? {
                    side: r.direction,
                    entry: (r.entryZone.from + r.entryZone.to) / 2,
                    sl: r.stopLoss,
                    tp: r.takeProfit.main,
                  }
                : null
            }
          />
        )}
      </CardContent>
    </Card>
    </TooltipProvider>
  );
}

export default ScalpSignalCard;
