import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  RefreshCw,
  BookOpen,
  Brain,
  CheckCircle2,
  XCircle,
  MinusCircle,
  CircleDot,
  Search,
  Download,
} from "lucide-react";
import {
  useGetMeScalpJournal,
  useGetMeScalpReviews,
  useGetMeScalpPersonality,
} from "@workspace/api-client-react";
import type {
  ScalpJournalEntry,
  ScalpSymbolPersonality,
} from "@workspace/api-client-react";
import { directionTone, fmtMoney } from "@/components/scanner/scalpLabels";
import { useAssistantName } from "@/lib/assistant-name";

// Scalp Journal & Lessons — a dedicated, filterable history page for the
// per-user scalp record Ruby keeps. Backed entirely by the existing read-only
// endpoints (/api/me/scalp/journal, /reviews, /personality). 100% read-only:
// no trade buttons, no internal enum tokens visible, plain-English only. Raw
// tokens stay in data-* attributes for tests/devtools (same pattern as the
// scanner status badges).

// ── Result / outcome helpers (shared shape with RubyScalpReviewPanel) ────────

function resultBadge(
  result: string,
): { label: string; tone: string; icon: typeof CheckCircle2 } {
  switch (result) {
    case "WIN":
      return { label: "Win", tone: "text-success border-success/25", icon: CheckCircle2 };
    case "LOSS":
      return { label: "Loss", tone: "text-danger border-danger/25", icon: XCircle };
    case "BREAKEVEN":
      return { label: "Break-even", tone: "text-muted-foreground border-border/60", icon: MinusCircle };
    case "OPEN":
      return { label: "Still open", tone: "text-ruby border-ruby/25", icon: CircleDot };
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

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── CSV export ───────────────────────────────────────────────────────────────
// Client-side export of the currently-filtered journal rows. We deliberately
// emit the honest P/L quality alongside the figure so the spreadsheet never
// implies a realised number we never actually got from the broker. The P/L cell
// is left blank when we have no trustworthy figure (UNKNOWN), rather than
// printing a fabricated 0.

const JOURNAL_CSV_HEADERS = [
  "Symbol",
  "Direction",
  "Result",
  "P/L",
  "P/L Quality",
  "Lesson",
  "Opened",
  "Closed",
] as const;

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// The numeric P/L we are honest enough to put in a spreadsheet cell: the
// broker's realised figure when KNOWN, our last floating reading when
// ESTIMATED, otherwise blank.
function journalPlCell(entry: ScalpJournalEntry): string {
  if (entry.plQuality === "KNOWN" && entry.realizedPl != null) return String(entry.realizedPl);
  if (entry.plQuality === "ESTIMATED" && entry.lastFloatingPl != null) return String(entry.lastFloatingPl);
  return "";
}

function buildJournalCsv(entries: ScalpJournalEntry[]): string {
  const rows = entries.map((e) =>
    [
      e.displayName ?? e.symbol,
      e.direction === "BUY" ? "Buy" : "Sell",
      resultBadge(e.result).label,
      journalPlCell(e),
      e.plQuality,
      e.lesson ?? "",
      e.openedAt ?? "",
      e.closedAt ?? "",
    ]
      .map((c) => csvEscape(String(c)))
      .join(","),
  );
  return [JOURNAL_CSV_HEADERS.join(","), ...rows].join("\r\n");
}

function downloadJournalCsv(entries: ScalpJournalEntry[]): void {
  // Prepend a UTF-8 BOM so Excel reads accented symbol names correctly.
  const blob = new Blob([`\uFEFF${buildJournalCsv(entries)}`], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `scalp-journal-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Rows ─────────────────────────────────────────────────────────────────────

function JournalRow({ entry }: { entry: ScalpJournalEntry }) {
  const { name } = useAssistantName();
  const badge = resultBadge(entry.result);
  const pl = plLine(entry);
  const Icon = badge.icon;
  return (
    <div
      className="rounded-lg border border-border/60 bg-card/40 p-3 space-y-2"
      data-testid="scalp-journal-row"
      data-symbol={entry.symbol}
      data-result={entry.result}
      data-status={entry.status}
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
        {entry.isSynthetic && (
          <Badge variant="outline" className="text-premium border-premium/25">
            Synthetic
          </Badge>
        )}
        <span className={`ml-auto font-mono tabular-nums text-sm ${pl.tone}`}>{pl.text}</span>
      </div>

      {pl.note && (
        <p className="text-[11px] text-muted-foreground/70">P/L {pl.note}.</p>
      )}

      {entry.lesson && (
        <p className="text-sm text-muted-foreground" data-testid="scalp-journal-lesson">
          {entry.lesson}
        </p>
      )}

      {entry.exitReason && (
        <p className="text-xs text-muted-foreground/80">{entry.exitReason}</p>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground/70">
        <span>Opened {fmtDate(entry.openedAt)}</span>
        {entry.closedAt && <span>Closed {fmtDate(entry.closedAt)}</span>}
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

function ReviewRow({ entry }: { entry: ScalpJournalEntry }) {
  const { name } = useAssistantName();
  const badge = resultBadge(entry.result);
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
        <span className="text-[11px] text-muted-foreground/70">Closed {fmtDate(entry.closedAt)}</span>
        <span className={`ml-auto font-mono tabular-nums text-sm ${pl.tone}`}>{pl.text}</span>
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
// instead of implying a learned edge from one or two samples.
const PERSONALITY_MIN_SAMPLE = 5;

// We only quote a portfolio-level win rate once enough trades have actually
// resolved into a win or a loss. Below that the number is noise, so we say so
// rather than printing a misleading percentage off one or two closes.
const WIN_RATE_MIN_SAMPLE = 5;

// ── Summary strip ────────────────────────────────────────────────────────────
// At-a-glance read of the whole scalp record. Every number is derived from the
// existing read-only endpoints — no new backend, no fabricated realised P/L.

interface ScalpSummary {
  total: number;
  closed: number;
  wins: number;
  losses: number;
  breakeven: number;
  open: number;
  unknown: number;
  decided: number;
  winRatePct: number | null;
  stillLearning: number;
  cautious: number;
}

function buildSummary(
  entries: ScalpJournalEntry[],
  personalities: ScalpSymbolPersonality[],
): ScalpSummary {
  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let open = 0;
  let unknown = 0;
  for (const e of entries) {
    switch (e.result) {
      case "WIN":
        wins += 1;
        break;
      case "LOSS":
        losses += 1;
        break;
      case "BREAKEVEN":
        breakeven += 1;
        break;
      case "OPEN":
        open += 1;
        break;
      default:
        unknown += 1;
    }
  }
  const closed = wins + losses + breakeven;
  const decided = wins + losses;
  const winRatePct =
    decided >= WIN_RATE_MIN_SAMPLE ? Math.round((wins / decided) * 100) : null;

  let stillLearning = 0;
  let cautious = 0;
  for (const p of personalities) {
    if (p.tradesClosed < PERSONALITY_MIN_SAMPLE) {
      stillLearning += 1;
    } else if (p.cautious) {
      cautious += 1;
    }
  }

  return {
    total: entries.length,
    closed,
    wins,
    losses,
    breakeven,
    open,
    unknown,
    decided,
    winRatePct,
    stillLearning,
    cautious,
  };
}

function SummaryStat({
  label,
  value,
  tone,
  testid,
}: {
  label: string;
  value: string;
  tone?: string;
  testid: string;
}) {
  return (
    <div className="flex flex-col gap-0.5" data-testid={testid}>
      <span className={`text-lg font-semibold leading-none ${tone ?? ""}`}>{value}</span>
      <span className="text-[11px] text-muted-foreground">{label}</span>
    </div>
  );
}

function ScalpSummaryStrip({ summary }: { summary: ScalpSummary }) {
  const { name } = useAssistantName();
  return (
    <Card data-testid="scalp-summary-strip">
      <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3 pt-4">
        <SummaryStat
          label="signals tracked"
          value={String(summary.total)}
          testid="scalp-summary-total"
        />
        <SummaryStat
          label="closed"
          value={String(summary.closed)}
          testid="scalp-summary-closed"
        />
        <div className="flex flex-col gap-0.5" data-testid="scalp-summary-winrate">
          {summary.winRatePct != null ? (
            <>
              <span className="text-lg font-semibold leading-none text-success">
                {summary.winRatePct}%
              </span>
              <span className="text-[11px] text-muted-foreground">
                win rate ({summary.decided} decided)
              </span>
            </>
          ) : (
            <>
              <span className="text-lg font-semibold leading-none text-muted-foreground">
                —
              </span>
              <span className="text-[11px] text-muted-foreground">
                win rate (need {WIN_RATE_MIN_SAMPLE}+ decided, have {summary.decided})
              </span>
            </>
          )}
        </div>
        <div className="h-8 w-px bg-border/60" aria-hidden />
        <SummaryStat
          label="wins"
          value={String(summary.wins)}
          tone="text-success"
          testid="scalp-summary-wins"
        />
        <SummaryStat
          label="losses"
          value={String(summary.losses)}
          tone="text-danger"
          testid="scalp-summary-losses"
        />
        <SummaryStat
          label="break-even"
          value={String(summary.breakeven)}
          testid="scalp-summary-breakeven"
        />
        <SummaryStat
          label="still open"
          value={String(summary.open)}
          tone="text-ruby"
          testid="scalp-summary-open"
        />
        {summary.unknown > 0 && (
          <SummaryStat
            label="outcome unclear"
            value={String(summary.unknown)}
            tone="text-warning"
            testid="scalp-summary-unknown"
          />
        )}
        <div className="h-8 w-px bg-border/60" aria-hidden />
        <SummaryStat
          label="markets still learning"
          value={String(summary.stillLearning)}
          tone="text-ruby"
          testid="scalp-summary-still-learning"
        />
        <SummaryStat
          label={`markets ${name} is cautious on`}
          value={String(summary.cautious)}
          tone="text-warning"
          testid="scalp-summary-cautious"
        />
      </CardContent>
    </Card>
  );
}

function PersonalityRow({ p }: { p: ScalpSymbolPersonality }) {
  const { name } = useAssistantName();
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

// ── Page ─────────────────────────────────────────────────────────────────────

const RESULT_FILTERS = [
  { value: "all", label: "All outcomes" },
  { value: "WIN", label: "Wins" },
  { value: "LOSS", label: "Losses" },
  { value: "BREAKEVEN", label: "Break-even" },
  { value: "OPEN", label: "Still open" },
  { value: "UNKNOWN", label: "Outcome unclear" },
] as const;

export default function ScalpJournalPage() {
  const { name } = useAssistantName();
  const [symbolQuery, setSymbolQuery] = useState("");
  const [resultFilter, setResultFilter] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const journal = useGetMeScalpJournal(
    { limit: 200 },
    {
      query: {
        queryKey: ["me-scalp-journal-page"],
        refetchInterval: 30_000,
        refetchIntervalInBackground: false,
      },
    },
  );
  const reviews = useGetMeScalpReviews(
    { limit: 100 },
    {
      query: {
        queryKey: ["me-scalp-reviews-page"],
        refetchInterval: 30_000,
        refetchIntervalInBackground: false,
      },
    },
  );
  const personality = useGetMeScalpPersonality(
    { limit: 100 },
    {
      query: {
        queryKey: ["me-scalp-personality-page"],
        refetchInterval: 60_000,
        refetchIntervalInBackground: false,
      },
    },
  );

  const journalEntries = useMemo(() => journal.data?.entries ?? [], [journal.data]);
  const reviewList = useMemo(() => reviews.data?.reviews ?? [], [reviews.data]);
  const personalityList = useMemo(() => personality.data?.symbols ?? [], [personality.data]);

  const isFetching = journal.isFetching || reviews.isFetching || personality.isFetching;

  const summary = useMemo(
    () => buildSummary(journalEntries, personalityList),
    [journalEntries, personalityList],
  );
  const summaryReady = journal.data != null && personality.data != null;

  function matchesFilters(entry: ScalpJournalEntry): boolean {
    // Symbol — match the human display name or the raw symbol, case-insensitive.
    const q = symbolQuery.trim().toLowerCase();
    if (q) {
      const hay = `${entry.displayName ?? ""} ${entry.symbol}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    // Result.
    if (resultFilter !== "all") {
      if (resultFilter === "UNKNOWN") {
        if (["WIN", "LOSS", "BREAKEVEN", "OPEN"].includes(entry.result)) return false;
      } else if (entry.result !== resultFilter) {
        return false;
      }
    }
    // Date — filter on opened date (falls back to closed date if no open date).
    const ref = entry.openedAt ?? entry.closedAt;
    if (dateFrom) {
      const from = new Date(`${dateFrom}T00:00:00`).getTime();
      if (!ref || new Date(ref).getTime() < from) return false;
    }
    if (dateTo) {
      const to = new Date(`${dateTo}T23:59:59.999`).getTime();
      if (!ref || new Date(ref).getTime() > to) return false;
    }
    return true;
  }

  const filteredJournal = useMemo(
    () => journalEntries.filter(matchesFilters),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [journalEntries, symbolQuery, resultFilter, dateFrom, dateTo],
  );
  const filteredReviews = useMemo(
    () => reviewList.filter(matchesFilters),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reviewList, symbolQuery, resultFilter, dateFrom, dateTo],
  );

  const filtersActive =
    symbolQuery.trim() !== "" || resultFilter !== "all" || dateFrom !== "" || dateTo !== "";

  function clearFilters() {
    setSymbolQuery("");
    setResultFilter("all");
    setDateFrom("");
    setDateTo("");
  }

  function refreshAll() {
    journal.refetch();
    reviews.refetch();
    personality.refetch();
  }

  return (
    <div className="space-y-6" data-testid="scalp-journal-page">
      <div className="flex items-center gap-3">
        <BookOpen className="h-6 w-6 text-ruby" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold tracking-tight">Scalp Journal &amp; Lessons</h1>
          <p className="text-sm text-muted-foreground">
            Your full scalp record — every signal {name} tracked, the plain-English
            review after each close, and what she has learned about each market.
            Read-only.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-8"
          onClick={refreshAll}
          disabled={isFetching}
          data-testid="scalp-journal-refresh"
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {summaryReady && summary.total > 0 && <ScalpSummaryStrip summary={summary} />}

      <Tabs defaultValue="journal">
        <TabsList>
          <TabsTrigger value="journal" data-testid="scalp-tab-journal">
            Journal
          </TabsTrigger>
          <TabsTrigger value="reviews" data-testid="scalp-tab-reviews">
            Reviews
          </TabsTrigger>
          <TabsTrigger value="personality" data-testid="scalp-tab-personality">
            Market Lessons
          </TabsTrigger>
        </TabsList>

        {/* ── Filters (shared by Journal + Reviews tabs) ── */}
        <Card className="mt-4">
          <CardContent className="flex flex-wrap items-end gap-3 pt-4">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-muted-foreground" htmlFor="scalp-symbol-filter">
                Market
              </label>
              <div className="relative">
                <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
                <Input
                  id="scalp-symbol-filter"
                  value={symbolQuery}
                  onChange={(e) => setSymbolQuery(e.target.value)}
                  placeholder="Search symbol…"
                  className="h-9 w-44 pl-7"
                  data-testid="scalp-filter-symbol"
                />
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-muted-foreground">Outcome</label>
              <Select value={resultFilter} onValueChange={setResultFilter}>
                <SelectTrigger className="h-9 w-40" data-testid="scalp-filter-result">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RESULT_FILTERS.map((f) => (
                    <SelectItem key={f.value} value={f.value}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-muted-foreground" htmlFor="scalp-date-from">
                From
              </label>
              <Input
                id="scalp-date-from"
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="h-9 w-40"
                data-testid="scalp-filter-date-from"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[11px] text-muted-foreground" htmlFor="scalp-date-to">
                To
              </label>
              <Input
                id="scalp-date-to"
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="h-9 w-40"
                data-testid="scalp-filter-date-to"
              />
            </div>

            {filtersActive && (
              <Button
                variant="ghost"
                size="sm"
                className="h-9"
                onClick={clearFilters}
                data-testid="scalp-filter-clear"
              >
                Clear
              </Button>
            )}
          </CardContent>
        </Card>

        {/* ── Journal tab ── */}
        <TabsContent value="journal" className="mt-4">
          <Card data-testid="scalp-journal-card">
            <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2 space-y-0">
              <CardTitle className="text-base">
                {filteredJournal.length} of {journalEntries.length} signals
              </CardTitle>
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => downloadJournalCsv(filteredJournal)}
                disabled={filteredJournal.length === 0}
                data-testid="scalp-journal-export-csv"
              >
                <Download className="h-4 w-4 mr-1.5" />
                Export CSV
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              {journal.isError && (
                <p className="text-sm text-danger">
                  {name} couldn't read your journal right now. Try Refresh in a moment.
                </p>
              )}
              {journal.isPending && !journal.data && (
                <p className="text-sm text-muted-foreground animate-pulse">
                  {name} is gathering your scalp history…
                </p>
              )}
              {journal.data && journalEntries.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No scalps recorded yet. As you take scalp signals, every one
                  lands here with its full context and outcome.
                </p>
              )}
              {journal.data && journalEntries.length > 0 && filteredJournal.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No signals match these filters.
                </p>
              )}
              {filteredJournal.map((e) => (
                <JournalRow key={e.id} entry={e} />
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Reviews tab ── */}
        <TabsContent value="reviews" className="mt-4">
          <Card data-testid="scalp-reviews-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                {filteredReviews.length} of {reviewList.length} reviews
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                After every close, {name} writes a plain-English review of what
                happened and why.
              </p>
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
              {reviews.data && reviewList.length > 0 && filteredReviews.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No reviews match these filters.
                </p>
              )}
              {filteredReviews.map((e) => (
                <ReviewRow key={e.id} entry={e} />
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Personality / Market Lessons tab ── */}
        <TabsContent value="personality" className="mt-4">
          <Card data-testid="scalp-personality-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Brain className="h-4 w-4 text-ruby" />
                What {name} has learned about each market
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {personality.isError && (
                <p className="text-sm text-danger">
                  {name} couldn't load what she's learned right now.
                </p>
              )}
              {personality.isPending && !personality.data && (
                <p className="text-sm text-muted-foreground animate-pulse">
                  {name} is gathering what she's learned…
                </p>
              )}
              {personality.data && personalityList.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {name} learns a market's personality after a few closed trades on
                  it. Keep trading and patterns will show up here.
                </p>
              )}
              {personalityList.map((p) => (
                <PersonalityRow key={p.symbol} p={p} />
              ))}
              {personalityList.length > 0 && (
                <p className="text-[11px] text-muted-foreground/70">
                  When a market keeps reversing or faking out, {name} quietly raises
                  the bar for new signals there. She only ever gets more careful —
                  never less.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
