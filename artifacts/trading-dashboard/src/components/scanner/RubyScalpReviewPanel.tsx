import { useState } from "react";
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
import { directionTone, fmtMoney } from "./scalpLabels";
import { useAssistantName } from "@/lib/assistant-name";

// RubyScalpReviewPanel (Phase 3) — the after-action review of recently closed
// scalps, plus what Ruby has learned about how each market behaves for THIS
// user. 100% read-only: every line is reflection and guidance. No trade
// buttons, no internal enum tokens visible, plain-English only.

function resultBadge(entry: ScalpJournalEntry): { label: string; tone: string; icon: typeof CheckCircle2 } {
  switch (entry.result) {
    case "WIN":
      return { label: "Win", tone: "text-success border-success/25", icon: CheckCircle2 };
    case "LOSS":
      return { label: "Loss", tone: "text-danger border-danger/25", icon: XCircle };
    case "BREAKEVEN":
      return { label: "Break-even", tone: "text-muted-foreground border-border/60", icon: MinusCircle };
    default:
      return { label: "Outcome unclear", tone: "text-warning border-warning/25", icon: MinusCircle };
  }
}

// Outcome P/L line — honest about what we actually know. KNOWN = the broker's
// realised number; ESTIMATED = our last observed floating figure; UNKNOWN =
// we never got a trustworthy close figure (common on the demo path).
function plLine(entry: ScalpJournalEntry): { text: string; tone: string; note: string | null } {
  if (entry.plQuality === "KNOWN" && entry.realizedPl != null) {
    const tone = entry.realizedPl > 0 ? "text-success" : entry.realizedPl < 0 ? "text-danger" : "text-muted-foreground";
    return { text: fmtMoney(entry.realizedPl), tone, note: null };
  }
  if (entry.plQuality === "ESTIMATED" && entry.lastFloatingPl != null) {
    const tone = entry.lastFloatingPl > 0 ? "text-success" : entry.lastFloatingPl < 0 ? "text-danger" : "text-muted-foreground";
    return { text: `${fmtMoney(entry.lastFloatingPl)}`, tone, note: "estimated from the last reading" };
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
        {entry.rubyWarnedCorrectly != null && (
          <span>
            {entry.rubyWarnedCorrectly
              ? `${name}'s warning matched what happened.`
              : `This one didn't follow ${name}'s read.`}
          </span>
        )}
        {entry.entryCount > 1 && <span>{entry.entryCount} entries</span>}
        {entry.addOnCount > 0 && <span>{entry.addOnCount} add-on{entry.addOnCount === 1 ? "" : "s"}</span>}
      </div>
    </div>
  );
}

// A symbol's personality only carries a trustworthy win rate / behaviour split
// once it has enough closed trades behind it. Below that we say so honestly
// instead of implying a learned edge from one or two samples. Mirrors the
// scalp-journal page's PERSONALITY_MIN_SAMPLE — the two surfaces must not
// disagree about when a number is quotable.
const PERSONALITY_MIN_SAMPLE = 5;

function PersonalityRow({ p, name }: { p: ScalpSymbolPersonality; name: string }) {
  const stillLearning = p.tradesClosed < PERSONALITY_MIN_SAMPLE;
  return (
    <div
      className="rounded-lg border border-border/60 bg-card/40 p-3 space-y-2"
      data-testid="scalp-personality-row"
      data-symbol={p.symbol}
      data-cautious={p.cautious ? "true" : "false"}
      data-still-learning={stillLearning ? "true" : "false"}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{p.displayName ?? p.symbol}</span>
        {p.isSynthetic && (
          <Badge variant="outline" className="text-premium border-premium/25">
            Synthetic
          </Badge>
        )}
        {stillLearning ? (
          <Badge variant="outline" className="text-ruby border-ruby/25">
            Still learning
          </Badge>
        ) : (
          p.cautious && (
            <Badge variant="outline" className="text-warning border-warning/25">
              {name} is being more careful here
            </Badge>
          )
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {p.tradesClosed} closed
          {!stillLearning && p.winRatePct != null ? ` · ${p.winRatePct}% won` : ""}
        </span>
      </div>

      {stillLearning ? (
        <p className="text-sm text-muted-foreground">
          Not enough data yet. {name} needs a few more closed trades on this
          market ({p.tradesClosed} of {PERSONALITY_MIN_SAMPLE}) before its win
          rate and behaviour are meaningful.
        </p>
      ) : (
        p.notes && (
          <p className="text-sm text-muted-foreground" data-testid="scalp-personality-note">
            {p.notes}
          </p>
        )
      )}

      <div className="grid grid-cols-3 gap-x-3 text-[11px] text-muted-foreground/80">
        <span>Followed through: {p.continuationCount}</span>
        <span>Reversed: {p.reversalCount}</span>
        <span>Faked out: {p.fakeoutCount}</span>
      </div>
    </div>
  );
}

export function RubyScalpReviewPanel() {
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

  const reviewList = reviews.data?.reviews ?? [];
  const personalityList = personality.data?.symbols ?? [];
  const isFetching = reviews.isFetching || personality.isFetching;

  return (
    <Card data-testid="ruby-scalp-reviews" className="rounded-2xl border-ruby/25 bg-card">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-ruby/15 text-ruby ring-1 ring-ruby/25">
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
              data-testid="ruby-scalp-reviews-refresh"
            >
              <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={() => setCollapsed((c) => !c)}
              data-testid="ruby-scalp-reviews-collapse"
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
            {reviews.data && reviewList.length === 0 && (
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
              <Brain className="h-4 w-4 text-ruby" />
              What {name} has learned about each market
            </h3>
            {personality.isError && (
              <p className="text-sm text-danger">
                {name} couldn't load what she's learned right now.
              </p>
            )}
            {personality.data && personalityList.length === 0 && (
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

export default RubyScalpReviewPanel;
