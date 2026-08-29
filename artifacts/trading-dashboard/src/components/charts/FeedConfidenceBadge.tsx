import { type ChartFeedStatus } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  Activity,
  ShieldCheck,
  ShieldAlert,
  BarChart3,
  Landmark,
  Boxes,
  Globe,
  Unplug,
} from "lucide-react";
import {
  feedConfidence,
  capConfidence,
  providerInfo,
  relativeTime,
  formatTrailingGap,
  type FeedSeverity,
  type FeedProviderTier,
} from "@/lib/feed-confidence";
import type { LucideIcon } from "lucide-react";

// ARX Native Chart — Level 3 feed confidence badge.
//
// A compact-when-clean / prominent-when-poor chip that surfaces the real
// backend feed status (source, live/stale, latency, last update times,
// missing-candle count, AI-usable, warning). The chip opens a popover with the
// full readout, and when the feed can't be trusted it offers the TradingView
// fallback. The component is purely presentational — it never gates anything.

const DOT: Record<FeedSeverity, string> = {
  clean: "bg-success",
  caution: "bg-warning",
  danger: "bg-danger",
  unknown: "bg-muted-foreground",
};

const CHIP: Record<FeedSeverity, string> = {
  // Compact + quiet when clean; filled + loud when degraded.
  clean: "border-success/25 text-success",
  caution: "border-warning/25 bg-warning/10 text-warning",
  danger: "border-danger/25 bg-danger/10 text-danger",
  unknown: "border-border bg-muted/60 text-txt-secondary",
};

// Provider trust tier → distinct icon + colour for the source sub-chip. The
// MT5 broker (primary) reads emerald-shielded; third-party fallbacks read sky;
// Deriv synthetic reads violet; no-feed reads zinc.
const TIER_ICON: Record<FeedProviderTier, LucideIcon> = {
  broker: Landmark,
  synthetic: Boxes,
  thirdParty: Globe,
  none: Unplug,
};

const TIER_CHIP: Record<FeedProviderTier, string> = {
  broker: "border-success/25 bg-success/10 text-success",
  synthetic: "border-premium/25 bg-premium/10 text-premium",
  thirdParty: "border-ruby/25 bg-ruby/10 text-ruby",
  none: "border-border bg-muted/60 text-txt-secondary",
};

const TIER_LABEL: Record<FeedProviderTier, string> = {
  broker: "Primary broker feed",
  synthetic: "Synthetic feed",
  thirdParty: "Fallback feed",
  none: "No feed",
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </div>
  );
}

export interface FeedConfidenceBadgeProps {
  feedStatus: ChartFeedStatus | null | undefined;
  /** Render a "Use TradingView" action inside the detail popover. */
  showFallback?: boolean;
  onRequestFallback?: () => void;
  /**
   * Optional RESOLVED verdict that overrides the raw-feed verdict (Task #506).
   * When provided, the badge consumes this instead of the socket-level feed
   * quality so it can never claim Clean/AI when a stricter resolved verdict
   * (shared scanner truth folded with the server read) says the feed is not
   * confirmed:
   *   - `true`  → confirmed; the badge may read Clean/AI.
   *   - `false` → not confirmed; severity is capped away from "clean" and the
   *               AI marker reads "No AI".
   *   - `null`  → unknown (verdict still resolving) → neutral state.
   * Omit (`undefined`) to keep the legacy raw-feed behaviour for other callers.
   */
  aiUsableResolved?: boolean | null;
  /**
   * Task #780 — when true, the ALWAYS-VISIBLE quality sub-chip appends an inline
   * "· N missing" trailing-interval count (the SAME `trailingIntervals` the
   * detail popover already shows) so a degrading feed is diagnosable without
   * opening the popover. Opt-in (Ruby chat feed chip): other callers keep the
   * bare chip. Suppressed for a current feed (<=1), honest "· —" when null.
   */
  showTrailingGap?: boolean;
}

export function FeedConfidenceBadge({
  feedStatus,
  showFallback = false,
  onRequestFallback,
  aiUsableResolved,
  showTrailingGap = false,
}: FeedConfidenceBadgeProps) {
  const rawConf = feedConfidence(feedStatus);
  // Cap the raw feed verdict by the resolved verdict when one is supplied, so
  // the badge can never look more confident than the rest of the panel.
  const conf = capConfidence(rawConf, aiUsableResolved);
  const fs = feedStatus ?? null;
  const provider = providerInfo(fs?.source);
  const ProviderIcon = TIER_ICON[provider.tier];
  // Task #776 — a synthetic served by the MT5 broker has NO separate Deriv tick
  // stream, so liveness is judged on broker candle freshness alone (and
  // "Last tick" is empty by design). Surface that explicitly so the empty tick
  // row is never misread as a degraded/limited feed on a genuinely live broker
  // synthetic.
  const brokerSynthetic = fs?.assetClass === "synthetic" && provider.tier === "broker";
  // Inline trailing-interval gap for the always-visible chip (opt-in). Reuses
  // the shared formatTrailingGap over the SAME feed status the popover reads.
  const inlineGap = showTrailingGap ? formatTrailingGap(fs?.trailingIntervals) : null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="arx-feed-badge"
          data-severity={conf.severity}
          data-ai-usable={conf.aiUsable ? "true" : "false"}
          data-provider-tier={provider.tier}
          className="inline-flex items-center gap-1"
          aria-label={`Data source: ${provider.label} (${TIER_LABEL[provider.tier]}). Feed status: ${conf.statusLabel}`}
        >
          {/* Source sub-chip — distinct icon + colour per trust tier. Names the
              primary broker feed vs. whatever fallback is actually serving. */}
          <Badge
            variant="outline"
            data-testid="arx-feed-provider"
            className={`flex items-center gap-1 text-[10px] font-medium ${TIER_CHIP[provider.tier]}`}
          >
            <ProviderIcon className="h-3 w-3" />
            {provider.label}
          </Badge>
          {/* Quality sub-chip — live/stale severity + AI-usability. */}
          <Badge
            variant="outline"
            className={`flex items-center gap-1.5 text-[10px] ${CHIP[conf.severity]}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${DOT[conf.severity]}`} />
            {conf.statusLabel}
            {inlineGap ? (
              <span data-testid="arx-feed-inline-gap" className="opacity-90">
                · {inlineGap}
              </span>
            ) : null}
            {fs?.isLive && conf.severity === "clean" ? (
              <Activity className="h-3 w-3" />
            ) : null}
            {conf.aiUsable ? (
              <span className="inline-flex items-center gap-0.5">
                <ShieldCheck className="h-3 w-3" /> AI
              </span>
            ) : (
              <span className="inline-flex items-center gap-0.5 opacity-90">
                <ShieldAlert className="h-3 w-3" /> No&nbsp;AI
              </span>
            )}
          </Badge>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-2" data-testid="arx-feed-detail">
        <div className="flex items-center gap-2">
          <ProviderIcon className="h-4 w-4 text-txt-secondary" />
          <span className="text-sm font-semibold text-foreground">{provider.label}</span>
          <Badge
            variant="outline"
            className={`ml-auto text-[10px] font-medium ${TIER_CHIP[provider.tier]}`}
          >
            {TIER_LABEL[provider.tier]}
          </Badge>
        </div>
        {/* What this source means for freshness/trust. */}
        <p className="text-xs text-muted-foreground" data-testid="arx-feed-trust-note">
          {provider.trustNote}
        </p>

        <div className="flex items-center gap-2 pt-0.5">
          <span className={`h-2 w-2 rounded-full ${DOT[conf.severity]}`} />
          <span className="text-xs font-medium text-foreground">{conf.statusLabel} feed</span>
        </div>
        <p className="text-xs text-muted-foreground">{conf.message}</p>

        <div className="space-y-1 rounded-md border border-border p-2">
          <Row label="Source" value={fs?.source || "—"} />
          <Row label="State" value={fs ? (fs.stale ? "Stale" : fs.isLive ? "Live" : "Delayed") : "—"} />
          <Row label="Latency" value={fs?.latencyMs != null ? `${fs.latencyMs} ms` : "—"} />
          <Row label="Last candle" value={relativeTime(fs?.lastCandleTime)} />
          <Row
            label="Last tick"
            value={
              brokerSynthetic && !fs?.lastTickTime
                ? "broker candles"
                : relativeTime(fs?.lastTickTime)
            }
          />
          <Row label="Missing candles" value={fs ? fs.missingCandleCount : "—"} />
          {/* Trailing-interval gap — how many recent bar-intervals the newest
              bar lags behind now (clean <=1, delayed 2, stale >=3). Surfaces the
              exact number that drives "delayed" vs "stale" so a degrading broker
              feed is self-explanatory. null (no candles) reads "—". */}
          <Row
            label="Missing intervals"
            value={
              fs && fs.trailingIntervals != null ? fs.trailingIntervals : "—"
            }
          />
          {fs && (fs.duplicateCount > 0 || fs.outOfOrderCount > 0 || fs.invalidOhlcCount > 0) ? (
            <Row
              label="Anomalies"
              value={`${fs.duplicateCount} dup · ${fs.outOfOrderCount} ooo · ${fs.invalidOhlcCount} bad`}
            />
          ) : null}
          <Row
            label="AI-usable"
            value={
              conf.aiUsable ? (
                <span className="text-success">Confirmed</span>
              ) : (
                <span className="text-warning">Not confirmed</span>
              )
            }
          />
          {fs?.feedReadinessState ? (
            <Row label="Readiness" value={fs.feedReadinessState} />
          ) : null}
        </div>

        {fs?.warning ? (
          <p className="text-xs text-warning" data-testid="arx-feed-warning">{fs.warning}</p>
        ) : null}

        {conf.suggestFallback && showFallback && onRequestFallback ? (
          <Button
            size="sm"
            className="w-full"
            onClick={onRequestFallback}
            data-testid="arx-feed-fallback"
          >
            <BarChart3 className="mr-1 h-3.5 w-3.5" /> Use TradingView reference
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

export default FeedConfidenceBadge;
