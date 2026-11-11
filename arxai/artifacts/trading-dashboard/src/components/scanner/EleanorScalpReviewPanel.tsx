import { useState } from "react";
import { SYNTHETIC_DIRECTION_LABEL } from "@workspace/domain/truth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  RefreshCw,
  ChevronDown,
  ChevronUp,
  BookOpen,
  Brain,
  CheckCircle2,
  XCircle,
  MinusCircle,
} from "lucide-react";
import {
  useGetMeScalpReviews,
  useGetMeScalpPersonality,
} from "@workspace/api-client-react";
import type {
  ScalpJournalEntry,
  ScalpSymbolPersonality,
} from "@workspace/api-client-react";
import { directionTone, fmtScalpMoney } from "./scalpLabels";
import { useAssistantName } from "@/lib/assistant-name";

// EleanorScalpReviewPanel (Phase 3) — the after-action review of recently closed
// scalps, plus what Eleanor has learned about how each market behaves for THIS
// user. 100% read-only: every line is reflection and guidance. No trade
// buttons, no internal enum tokens visible, plain-English only.

// Only a KNOWN (broker-realised) P/L earns a plain "Win" / "Loss". Every other
// graded result came from the last floating reading before the close (no
// commission or swap, and price may have moved after it), so the badge says it
// is an estimate.
function resultBadge(entry: ScalpJournalEntry): { label: string; tone: string; icon: typeof CheckCircle2 } {
  const known = entry.plQuality === "KNOWN";
  switch (entry.result) {
    case "WIN":
      return { label: known ? "Win" : "Likely win (estimated)", tone: "text-success border-emerald-500/40", icon: CheckCircle2 };
    case "LOSS":
      return { label: known ? "Loss" : "Likely loss (estimated)", tone: "text-danger border-rose-500/40", icon: XCircle };
    case "BREAKEVEN":
      return { label: known ? "Break-even" : "Roughly flat (estimated)", tone: "text-muted-foreground border-border/60", icon: MinusCircle };
    default:
      return { label: "Outcome unclear", tone: "text-warning border-amber-500/40", icon: MinusCircle };
  }
}

// Outcome P/L line — honest about what we actually know. KNOWN is reserved
// for a broker-reported realised number, which the server does not record
// today; ESTIMATED = the last floating reading of every leg (the server sends
// this for every closed scalp it can estimate); UNKNOWN = no reading covered
// every leg, so there is no trustworthy close figure. The figures are in the
// account's currency, which the entry does not carry, so no "$" is assumed.
function plLine(entry: ScalpJournalEntry): { text: string; tone: string; note: string | null } {
  if (entry.plQuality === "KNOWN" && entry.realizedPl != null) {
    const tone = entry.realizedPl > 0 ? "text-success" : entry.realizedPl < 0 ? "text-danger" : "text-muted-foreground";
    return { text: fmtScalpMoney(entry.realizedPl, null), tone, note: null };
  }
  if (entry.plQuality === "ESTIMATED" && entry.lastFloatingPl != null) {
    const tone = entry.lastFloatingPl > 0 ? "text-success" : entry.lastFloatingPl < 0 ? "text-danger" : "text-muted-foreground";
    return { text: fmtScalpMoney(entry.lastFloatingPl, null), tone, note: "estimated from the last reading" };
  }
  return { text: "—", tone: "text-muted-foreground", note: "the broker never sent a final figure" };
}

function ReviewRow({ entry, name }: { entry: ScalpJournalEntry; name: string }) {
  const badge = resultBadge(entry);
  const pl = plLine(entry);
  const Icon = badge.icon;
  return (
    <div
      className="rounded-lg border border-border/60 bg-card/40 p-3 space-y-2"
      data-testid="scalp-review-row"
      data-symbol={entry.symbol}
      data-result={entry.result}
      data-pl-quality={entry.plQuality}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{entry.displayName ?? entry.symbol}</span>
        <Badge variant="outline" className={directionTone(entry.direction as "BUY" | "SELL")}>
          {entry.direction === "BUY" ? "Buy" : "Sell"}
        </Badge>
        <Badge variant="outline" className={`flex items-center gap-1 ${badge.tone}`}>
          <Icon className="h-3 w-3" /> {badge.label}
        </Badge>
        <span className={`ml-auto font-mono text-sm ${pl.tone}`}>{pl.text}</span>
      </div>

      {pl.note && (
        <p className="text-[11px] text-muted-foreground/70">P/L {pl.note}.</p>
      )}

      {entry.lesson && (
        <p className="text-sm text-muted-foreground" data-testid="scalp-review-lesson">
          {entry.lesson}
        </p>
      )}

      {entry.exitReason && (
        <p className="text-xs text-muted-foreground/80">{entry.exitReason}</p>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground/70">
        {entry.eleanorWarnedCorrectly != null && (
          <span>
            {/* Derived from the result; unless that result is a KNOWN
                (broker-realised) P/L it was graded from the last reading. */}
            {entry.plQuality === "KNOWN"
              ? entry.eleanorWarnedCorrectly
                ? `${name}'s warning matched what happened.`
                : `This one didn't follow ${name}'s read.`
              : entry.eleanorWarnedCorrectly
                ? `${name}'s warning matched the last reading before the close (estimated).`
                : `Going by the last reading before the close, this one didn't follow ${name}'s read (estimated).`}
          </span>
        )}
        {entry.entryCount > 1 && <span>{entry.entryCount} entries</span>}
        {entry.addOnCount > 0 && <span>{entry.addOnCount} add-on{entry.addOnCount === 1 ? "" : "s"}</span>}
      </div>
    </div>
  );
}

function PersonalityRow({ p, name }: { p: ScalpSymbolPersonality; name: string }) {
  return (
    <div
      className="rounded-lg border border-border/60 bg-card/40 p-3 space-y-2"
      data-testid="scalp-personality-row"
      data-symbol={p.symbol}
      data-cautious={p.cautious ? "true" : "false"}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{p.displayName ?? p.symbol}</span>
        {p.isSynthetic && (
          <Badge variant="outline" className="text-violet-300 border-violet-500/40" title={SYNTHETIC_DIRECTION_LABEL}>
            Synthetic · random by design
          </Badge>
        )}
        {p.cautious && (
          <Badge variant="outline" className="text-warning border-amber-500/40">
            {name} is being more careful here
          </Badge>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {p.tradesClosed} closed
          {/* Wins are graded from the last reading before each close (no
              broker-realised P/L is recorded), so the share is an estimate. */}
          {p.winRatePct != null ? ` · ${p.winRatePct}% won (estimated)` : ""}
        </span>
      </div>

      {p.notes && (
        <p className="text-sm text-muted-foreground" data-testid="scalp-personality-note">
          {p.notes}
        </p>
      )}

      <div className="grid grid-cols-3 gap-x-3 text-[11px] text-muted-foreground/80">
        <span>Followed through: {p.continuationCount}</span>
        <span>Reversed: {p.reversalCount}</span>
        <span>Faked out: {p.fakeoutCount}</span>
      </div>
    </div>
  );
}

export function EleanorScalpReviewPanel() {
  const [collapsed, setCollapsed] = useState(true);
  const { name } = useAssistantName();
  const reviews = useGetMeScalpReviews(
    { limit: 10 },
    {
      query: {
        queryKey: ["me-scalp-reviews"],
        refetchInterval: 30_000,
        refetchIntervalInBackground: false,
        enabled: !collapsed,
      },
    },
  );
  const personality = useGetMeScalpPersonality(
    { limit: 12 },
    {
      query: {
        queryKey: ["me-scalp-personality"],
        refetchInterval: 60_000,
        refetchIntervalInBackground: false,
        enabled: !collapsed,
      },
    },
  );

  // React Query keeps the last successful data after a failed refetch. Its age
  // is unknown, so after a failed read the old reviews / win rates are not
  // shown as current (same rule as the Position Manager).
  const reviewList = reviews.isError ? [] : reviews.data?.reviews ?? [];
  const personalityList = personality.isError ? [] : personality.data?.symbols ?? [];
  const isFetching = reviews.isFetching || personality.isFetching;

  return (
    <Card data-testid="eleanor-scalp-reviews" className="rounded-2xl border-eleanor/25 bg-card">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-eleanor/15 text-eleanor ring-1 ring-eleanor/25">
              <BookOpen className="h-[18px] w-[18px]" />
            </span>
            {name} Journal &amp; Lessons
          </CardTitle>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={() => { reviews.refetch(); personality.refetch(); }}
              disabled={isFetching || collapsed}
              data-testid="eleanor-scalp-reviews-refresh"
            >
              <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={() => setCollapsed((c) => !c)}
              data-testid="eleanor-scalp-reviews-collapse"
            >
              {collapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </CardHeader>

      {!collapsed && (
        <CardContent className="space-y-5">
          {/* After-action reviews */}
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-muted-foreground">
              After every close, {name} writes a plain-English review.
            </h3>
            {reviews.isError && (
              <p className="text-sm text-danger">
                {name} couldn't read your reviews right now. Try Refresh in a moment.
              </p>
            )}
            {reviews.isPending && !reviews.data && (
              <p className="text-sm text-muted-foreground animate-pulse">
                {name} is gathering your recent closes…
              </p>
            )}
            {reviews.data && !reviews.isError && reviewList.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No closed scalps yet. Once you close a position, {name}'s review
                will land here.
              </p>
            )}
            {reviewList.map((r) => (
              <ReviewRow key={r.id} entry={r} name={name} />
            ))}
          </div>

          {/* Per-symbol personality */}
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Brain className="h-4 w-4 text-eleanor" />
              What {name} has learned about each market
            </h3>
            {personality.isError && (
              <p className="text-sm text-danger">
                {name} couldn't load what she's learned right now.
              </p>
            )}
            {personality.data && !personality.isError && personalityList.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {name} learns a market's personality after a few closed trades on
                it. Keep trading and patterns will show up here.
              </p>
            )}
            {personalityList.map((p) => (
              <PersonalityRow key={p.symbol} p={p} name={name} />
            ))}
            {personalityList.length > 0 && (
              <p className="text-[11px] text-muted-foreground/70">
                When a market keeps reversing or faking out, {name} quietly raises
                the bar for new signals there. She only ever gets more careful —
                never less.
              </p>
            )}
          </div>
        </CardContent>
      )}
    </Card>
  );
}

export default EleanorScalpReviewPanel;
