import React from "react";
import { Sparkles, Crosshair, AlertTriangle, Wrench } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { confidenceTier, CONFIDENCE_LABEL, STATUS_COLORS } from "@/lib/design-tokens";
import { cn } from "@/lib/utils";

interface Props {
  setupQuality?: number | null;          // 0-100
  invalidation?: string | null;          // text
  warning?: string | null;               // text
  managementSuggestion?: string | null;  // text
  explanation?: string | null;           // longer summary
  className?: string;
  /**
   * DISPLAY-ONLY ceiling from the shared Trade-Health contract
   * (`resolveTradeAffordance().mayDescribeSetup` / `truth.readiness.mayDescribeSetup`).
   * When explicitly `false`, the read is NOT live-confirmed for this
   * symbol+timeframe, so the card must not present a confident directional setup:
   * the quality %/tier badge and the concrete setup narrative (explanation /
   * invalidation / management) are withheld in favour of an honest read-quality
   * note. A cautionary `warning` still shows. Omitted/undefined keeps the legacy
   * behaviour (no ceiling). This can only HIDE the confident framing — it never
   * grants anything, and execution stays gated server-side regardless.
   */
  mayDescribeSetup?: boolean;
  /** Shared read-state label shown when the setup claim is withheld. */
  readinessLabel?: string | null;
  /** Shared read-quality trust line shown when the setup claim is withheld. */
  readinessTrustLine?: string | null;
}

export function AIInsightCard({ setupQuality, invalidation, warning, managementSuggestion, explanation, className, mayDescribeSetup, readinessLabel, readinessTrustLine }: Props) {
  // A confident setup narrative is withheld ONLY when the contract explicitly
  // says so (mayDescribeSetup === false). Undefined keeps the legacy behaviour.
  const setupWithheld = mayDescribeSetup === false;
  const tier = confidenceTier(setupQuality ?? 0);
  const colors = STATUS_COLORS[tier === "elite" ? "premium" : tier === "strong" ? "success" : tier === "moderate" ? "warning" : "danger"];
  const showQuality = !setupWithheld && setupQuality !== null && setupQuality !== undefined;

  return (
    <Card className={cn("border-card-border", colors.border, className)}>
      <CardHeader className="pb-2 border-b border-border">
        <CardTitle className="text-sm font-semibold uppercase tracking-wider flex items-center gap-2">
          <Sparkles size={14} className={colors.text} />
          AI Insight
          {showQuality && (
            <span className={cn("ml-auto text-xs font-mono", colors.text)}>{CONFIDENCE_LABEL[tier]} · {setupQuality}%</span>
          )}
          {setupWithheld && readinessLabel && (
            <span className="ml-auto text-xs font-mono text-muted-foreground" data-testid="ai-insight-readiness-label">{readinessLabel}</span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 space-y-3">
        {setupWithheld ? (
          // Read not live-confirmed: withhold the concrete setup narrative and show
          // the shared read-quality trust line instead, so this card can never
          // contradict the scanner / Ruby / chart for the same symbol+timeframe.
          <p className="text-xs text-muted-foreground flex items-start gap-2" data-testid="ai-insight-withheld">
            <AlertTriangle size={14} className="shrink-0 mt-0.5 text-warning" />
            {readinessTrustLine || "Read isn't live-confirmed yet — the detailed setup is withheld until the feed confirms."}
          </p>
        ) : (
          <>
            {explanation && (
              <p className="text-sm text-foreground/90 leading-relaxed">{explanation}</p>
            )}
            <div className="grid gap-2.5 sm:grid-cols-2">
              {invalidation && (
                <InsightRow icon={Crosshair} tone="info" label="Invalidation" text={invalidation} />
              )}
              {managementSuggestion && (
                <InsightRow icon={Wrench} tone="info" label="Management" text={managementSuggestion} />
              )}
              {warning && (
                <InsightRow icon={AlertTriangle} tone="warning" label="Warning" text={warning} className="sm:col-span-2" />
              )}
            </div>
            {!explanation && !invalidation && !warning && !managementSuggestion && (
              <p className="text-xs text-muted-foreground italic">AI explanation not available for this signal.</p>
            )}
          </>
        )}
        {/* A cautionary warning always shows, even when the setup is withheld. */}
        {setupWithheld && warning && (
          <InsightRow icon={AlertTriangle} tone="warning" label="Warning" text={warning} />
        )}
      </CardContent>
    </Card>
  );
}

function InsightRow({ icon: Icon, tone, label, text, className }: { icon: React.ComponentType<{ size?: number; className?: string }>; tone: "info" | "warning"; label: string; text: string; className?: string }) {
  const colors = STATUS_COLORS[tone];
  return (
    <div className={cn("flex gap-2 p-2.5 rounded-md border", colors.bg, colors.border, className)}>
      <Icon size={14} className={cn("shrink-0 mt-0.5", colors.text)} />
      <div className="min-w-0">
        <div className={cn("text-[10px] uppercase tracking-wider font-semibold", colors.text)}>{label}</div>
        <div className="text-xs text-foreground/90 mt-0.5">{text}</div>
      </div>
    </div>
  );
}
