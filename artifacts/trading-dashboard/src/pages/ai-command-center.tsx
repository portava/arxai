import { useEffect } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import {
  Brain,
  Activity,
  RefreshCcw,
  AlertTriangle,
  Lightbulb,
  CheckCircle2,
  Target,
  MessageCircle,
  Sparkles,
  ListChecks,
  Database,
  Mic,
  ShieldCheck,
} from "lucide-react";
import { SelectedMarketPanel } from "@/components/scanner/SelectedMarketPanel";
import { RubyAccountHealthStrip } from "@/components/ruby/RubyAccountHealthStrip";
import { useAssistantName } from "@/lib/assistant-name";
import {
  DailyMentorBriefingCard,
  MentorActionItems,
  MentorHistory,
  MentorWarningCard,
  isMentorWarningSession,
  type MentorActionItem,
  type MentorSession,
} from "@/components/aiMentor";
import { MENTOR_LATEST_QUERY_KEY, mentorHistoryQueryKey, readMentorJson } from "@/lib/mentorApi";
import { safeDate } from "@/lib/safeFormat";

// Ruby Command Center — 4-tab, user-facing surface.
//
// Tabs:
//   • Chat       — opens Ruby's floating live chat and shows the user's
//                  latest generated mentor briefing and recent mentor
//                  sessions (not their chat history).
//   • Market Read — plain-language read of the currently-selected market,
//                  reusing the same SelectedMarketPanel as the scanner.
//   • Commands   — user-safe trading command examples Ruby will accept,
//                  with plain-language gate explanations. No internal
//                  gate names, no /api routes, no JSON.
//   • Memory     — Ruby's performance memory: how she's been doing, what
//                  she's learning, her best/worst symbols and setups,
//                  insights and warnings. (Preserves every card from the
//                  previous performance dashboard so no feature is lost.)
//
// Live trading safety: no execution affordances on this page. Everything
// stays read-only / explanatory. The Commands tab only shows what a user
// CAN say to Ruby — actual dispatch still goes through Ruby's existing
// gated pipeline.

const STORAGE_OPEN_KEY = "arx.assistant.open.v2";

function openRubyLiveChat() {
  try {
    sessionStorage.setItem(STORAGE_OPEN_KEY, "1");
    // ArxAssistantLivePanel watches `storage` events to react across tabs;
    // dispatching one here makes the floating panel open immediately in
    // the same tab too.
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_OPEN_KEY }));
  } catch {
    /* sessionStorage unavailable — silent */
  }
}

interface CCResp {
  // The shape comes straight from /api/performance/ai-command-center; using
  // `any` here is intentional and matches the previous implementation. The
  // page only renders display values, never raw identifier names.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  commandCenter: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  autopilot: any;
  /** The account mode the server scoped this read to. LIVE_SHARED = the
   *  paper book was withheld (commandCenter/autopilot are null). */
  currentAccountMode?: string | null;
  liveAggregation?: string;
  modeNote?: string;
  /** Which book the figures were built from ("paper_orders"). */
  dataSource?: string;
}

interface EquityResp {
  /** null for a LIVE_SHARED session (the paper curve is withheld). */
  equityCurve?: {
    points?: Array<{ trade_id: number; cumulative: number }>;
    /** Closes whose P&L could not be sized: they have no point on the curve. */
    unsized_trades?: number;
    /** Server note on those closes (null when every close was sized). */
    pnl_note?: string | null;
  } | null;
  currentAccountMode?: string | null;
}

/** Read a JSON body, or throw so the tab says "could not be loaded" rather
 *  than treating a failed request as an empty memory. */
async function readJsonOrThrow<T>(r: Response, key: string): Promise<T> {
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const body = await r.json();
  if (!body || typeof body !== "object" || !(key in body)) throw new Error("Unexpected response");
  return body as T;
}

/** Newest mentor sessions fetched for the history groups (server caps at 100). */
const MENTOR_HISTORY_LIMIT = 10;

export default function AICommandCenterPage() {
  const { name } = useAssistantName();
  return (
    <div
      className="space-y-5 animate-in fade-in duration-300"
      data-testid="ai-command-center"
    >
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-ruby/15 text-ruby ring-1 ring-ruby/25">
            <Brain className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-bold leading-tight">{name} Command Center</h1>
            <p className="text-sm text-txt-secondary mt-1">
              Chat with {name}, read the market, run safe commands, and review
              what she’s learned about your trading.
            </p>
          </div>
        </div>
      </div>

      {/* Read-only live account-health strip — balance / equity / open P/L at a
          glance, sourced from the shared snapshot hook. Display only. */}
      <RubyAccountHealthStrip />

      {/* Tabs */}
      <Tabs defaultValue="chat" className="w-full">
        {/* Ruby-focused tabs only. Cross-page jumps (Scanner / Alerts /
            Calendar / Advanced) belong in the side menu so this page stays
            focused on Ruby. */}
        <TabsList
          className="flex w-full overflow-x-auto no-scrollbar justify-start gap-1 h-auto rounded-xl border border-border bg-card p-1"
          data-testid="ai-tab-strip"
        >
          <TabsTrigger value="chat" className="shrink-0 rounded-lg text-txt-secondary data-[state=active]:bg-ruby/15 data-[state=active]:text-ruby data-[state=active]:shadow-none" data-testid="tab-chat">
            <MessageCircle className="h-4 w-4 mr-1 sm:mr-2" />
            Chat
          </TabsTrigger>
          <TabsTrigger value="market-read" className="shrink-0 rounded-lg text-txt-secondary data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:shadow-none" data-testid="tab-market-read">
            <Sparkles className="h-4 w-4 mr-1 sm:mr-2" />
            Market Read
          </TabsTrigger>
          <TabsTrigger value="commands" className="shrink-0 rounded-lg text-txt-secondary data-[state=active]:bg-success/15 data-[state=active]:text-success data-[state=active]:shadow-none" data-testid="tab-commands">
            <ListChecks className="h-4 w-4 mr-1 sm:mr-2" />
            Commands
          </TabsTrigger>
          <TabsTrigger value="memory" className="shrink-0 rounded-lg text-txt-secondary data-[state=active]:bg-warning/15 data-[state=active]:text-warning data-[state=active]:shadow-none" data-testid="tab-memory">
            <Database className="h-4 w-4 mr-1 sm:mr-2" />
            Memory
          </TabsTrigger>
        </TabsList>

        {/* ───────── Chat ───────── */}
        <TabsContent value="chat" className="mt-4 space-y-4">
          <ChatTab />
        </TabsContent>

        {/* ───────── Market Read ───────── */}
        <TabsContent value="market-read" className="mt-4 space-y-4">
          <SelectedMarketPanel />
        </TabsContent>

        {/* ───────── Commands ───────── */}
        <TabsContent value="commands" className="mt-4 space-y-4">
          <CommandsTab onOpenChat={openRubyLiveChat} />
        </TabsContent>

        {/* ───────── Memory ───────── */}
        <TabsContent value="memory" className="mt-4 space-y-4">
          <MemoryTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/*                                 CHAT                                     */
/* ──────────────────────────────────────────────────────────────────────── */

function ChatTab() {
  const { name } = useAssistantName();
  const qc = useQueryClient();

  // Same cache entries as /ai-mentor: a non-2xx read throws, so a failed read
  // is an error here and there, never an empty "no session yet" answer.
  type LatestResponse = { session: MentorSession | null; actionItems: MentorActionItem[] };
  type HistoryResponse = { sessions: MentorSession[] };
  const latest = useQuery<LatestResponse>({
    queryKey: MENTOR_LATEST_QUERY_KEY,
    queryFn: async () => readMentorJson<LatestResponse>(await fetch("/api/mentor/sessions/latest"), "Loading the latest mentor session"),
  });
  const history = useQuery<HistoryResponse>({
    queryKey: mentorHistoryQueryKey(MENTOR_HISTORY_LIMIT),
    queryFn: async () => readMentorJson<HistoryResponse>(await fetch(`/api/mentor/sessions?limit=${MENTOR_HISTORY_LIMIT}`), "Loading mentor history"),
  });
  const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : "unknown error");

  const updateStatus = useMutation({
    mutationFn: async ({
      id,
      status,
    }: {
      id: number;
      status: MentorActionItem["status"];
    }) => {
      const r = await fetch(`/api/mentor/action-items/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mentor-latest"] }),
  });

  const session = latest.data?.session ?? null;
  const items = latest.data?.actionItems ?? [];

  return (
    <>
      {/* Open-Ruby CTA */}
      <Card className="rounded-2xl border-ruby/25 bg-card">
        <CardContent className="p-5">
          {/* No status pill: nothing on this page checks whether the
              assistant or chat backend is up, so none is claimed. */}
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-base font-semibold flex items-center gap-2">
              <MessageCircle className="h-4 w-4 text-ruby" />
              Talk to {name}
            </h3>
          </div>
          <p className="text-sm text-txt-secondary mt-1.5">
            Ask about the market, request a setup read, review a trade, or run
            an approved trading command.
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:flex">
            <Button
              onClick={openRubyLiveChat}
              data-testid="button-open-ruby-chat"
              className="bg-ruby hover:bg-ruby/90 text-white sm:flex-1"
            >
              <MessageCircle className="h-4 w-4 mr-2" />
              Open Chat
            </Button>
            <Button
              variant="outline"
              onClick={openRubyLiveChat}
              data-testid="button-open-ruby-chat-voice"
              className="sm:flex-1"
            >
              <Mic className="h-4 w-4 mr-2" />
              Voice
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Latest generated mentor briefing */}
      {latest.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : latest.isError ? (
        <Card className="rounded-2xl border-destructive/40 bg-card">
          <CardContent className="p-5 text-sm text-destructive" role="alert" data-testid="chat-mentor-latest-error">
            Could not load your latest mentor briefing, so whether one exists is unknown. {errorMessage(latest.error)}
          </CardContent>
        </Card>
      ) : session ? (
        <>
          <MentorWarningCard session={session} />
          <DailyMentorBriefingCard session={session} summaryShownElsewhere={isMentorWarningSession(session)} />
          <Card className="rounded-2xl border-border bg-card">
            <CardContent className="p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="flex items-center gap-2 text-base font-semibold">
                  <CheckCircle2 className="h-4 w-4 text-primary" />
                  Action Items
                </h3>
                <span className="text-xs font-medium text-primary">{items.length} item{items.length === 1 ? "" : "s"}</span>
              </div>
              <div className="mt-2">
                <MentorActionItems
                  items={items}
                  onChangeStatus={(id, status) =>
                    updateStatus.mutate({ id, status })
                  }
                />
              </div>
            </CardContent>
          </Card>
        </>
      ) : (
        <Card className="rounded-2xl border-border bg-card">
          <CardContent className="p-5 text-sm text-txt-secondary">
            No mentor briefing yet. Open chat above and ask {name} for a
            market read or a setup review.
          </CardContent>
        </Card>
      )}

      {/* Generated mentor sessions, grouped. These are mentor briefings and
          notes, not the user's chat history. */}
      <section>
        <h3 className="mb-2 flex items-center gap-2 text-base font-semibold" data-testid="chat-mentor-history-heading">
          <MessageCircle className="h-4 w-4 text-ruby" />
          Recent mentor sessions
        </h3>
        <p className="mb-2 text-xs text-txt-secondary">
          Briefings and notes {name}'s mentor generated for you. Your chat messages are not listed here.
        </p>
        {history.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : history.isError ? (
          <p className="text-xs text-destructive" role="alert" data-testid="chat-mentor-history-error">
            Could not load your recent mentor sessions. {errorMessage(history.error)}
          </p>
        ) : (
          <MentorHistory sessions={history.data?.sessions ?? []} pageLimit={MENTOR_HISTORY_LIMIT} />
        )}
      </section>

      {/* Guidance note */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-xs text-txt-secondary">
        <ShieldCheck className="h-3.5 w-3.5 text-success" />
        {name} only gives guidance — you stay in control of every trade.
      </div>
    </>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/*                                COMMANDS                                  */
/* ──────────────────────────────────────────────────────────────────────── */

type CommandExample = {
  example: string;
  what: string;
};

const TRADE_COMMANDS: CommandExample[] = [
  { example: "Buy EURUSD 0.01", what: "Place a small buy order on EURUSD." },
  { example: "Sell EURUSD 0.01", what: "Place a small sell order on EURUSD." },
  { example: "Buy this", what: "Buy the symbol you’re currently looking at." },
  { example: "Sell this", what: "Sell the symbol you’re currently looking at." },
];
const MANAGE_COMMANDS: CommandExample[] = [
  { example: "Close my EURUSD trade", what: "Close any open EURUSD position." },
  { example: "Close all trades", what: "Close every open position." },
  { example: "Close all profitable trades", what: "Close only trades currently in profit." },
  { example: "Move stop loss to break even", what: "Set stop loss to your entry price." },
  { example: "Set take profit to 1.0920", what: "Update take profit on the active position." },
];
const readCommands = (name: string): CommandExample[] => [
  { example: "Read EURUSD", what: "Plain-language read of trend, structure, and risk." },
  { example: "What’s the news today?", what: "Today’s high-impact economic events." },
  { example: "Review my last trade", what: `${name} walks through your most recent closed trade.` },
];

const blockedPrompts = (name: string): { prompt: string; reason: string }[] => [
  {
    prompt: "What should I trade?",
    reason:
      `${name} won’t pick trades for you. Ask for a market read, then decide.`,
  },
  {
    prompt: "Do you think I should buy?",
    reason:
      `${name} explains setups; she won’t tell you to enter without a clear command.`,
  },
  {
    prompt: "Find me a setup.",
    reason:
      `Open the Market Scanner for live opportunities. ${name} will read any symbol you pick.`,
  },
];

function CommandSection({
  title,
  rows,
  onTryExample,
}: {
  title: string;
  rows: CommandExample[];
  onTryExample: () => void;
}) {
  return (
    <Card className="rounded-2xl border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-success/15 text-success ring-1 ring-success/25">
            <ListChecks className="h-4 w-4" />
          </span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.map((r) => (
          <div
            key={r.example}
            className="flex items-start justify-between gap-3 rounded-xl border border-border bg-background/40 p-3"
          >
            <div className="min-w-0">
              <div className="text-sm font-medium">{r.example}</div>
              <div className="text-xs text-txt-secondary mt-0.5">
                {r.what}
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={onTryExample}
              className="shrink-0"
            >
              Try
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function CommandsTab({ onOpenChat }: { onOpenChat: () => void }) {
  const { name } = useAssistantName();
  return (
    <>
      <Card className="rounded-2xl border-primary/30 bg-primary/[0.05]">
        <CardContent className="p-4 text-sm text-txt-secondary">
          {name} only acts on clear, direct commands. She will never trade
          from vague questions or open-ended chat. Every trade still has to
          pass your account approval, kill-switch, and risk gates.
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <CommandSection
          title="Trade"
          rows={TRADE_COMMANDS}
          onTryExample={onOpenChat}
        />
        <CommandSection
          title="Manage"
          rows={MANAGE_COMMANDS}
          onTryExample={onOpenChat}
        />
        <CommandSection
          title="Read &amp; Review"
          rows={readCommands(name)}
          onTryExample={onOpenChat}
        />
      </div>

      <Card className="rounded-2xl border-warning/30 bg-warning/[0.04]">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-warning" />
            {name} will not act on these
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {blockedPrompts(name).map((b) => (
            <div
              key={b.prompt}
              className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/[0.05] p-3"
            >
              <AlertTriangle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-medium">“{b.prompt}”</div>
                <div className="text-xs text-warning/80 mt-0.5">
                  {b.reason}
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/*                                 MEMORY                                   */
/* ──────────────────────────────────────────────────────────────────────── */

export function MemoryTab() {
  const { name } = useAssistantName();
  const qc = useQueryClient();
  const cc = useQuery<CCResp>({
    queryKey: ["ai-cc"],
    queryFn: async () =>
      readJsonOrThrow<CCResp>(await fetch("/api/performance/ai-command-center"), "commandCenter"),
  });
  const eq = useQuery<EquityResp>({
    queryKey: ["ai-cc-equity"],
    queryFn: async () =>
      readJsonOrThrow<EquityResp>(await fetch("/api/performance/equity-curve?range=30d"), "equityCurve"),
  });
  const dq = useQuery<{
    decisionQuality?: { sample_size_label?: string };
  }>({
    queryKey: ["ai-cc-dq"],
    queryFn: async () =>
      (await fetch("/api/performance/decision-quality?range=30d")).json(),
  });
  const rebuild = useMutation({
    mutationFn: async () =>
      (await fetch("/api/performance/rebuild", { method: "POST" })).json(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ai-cc"] });
      qc.invalidateQueries({ queryKey: ["ai-cc-equity"] });
      qc.invalidateQueries({ queryKey: ["ai-cc-dq"] });
    },
  });

  // Auto-refresh the memory snapshot when the tab first mounts so the
  // user always sees the latest data without clicking "Rebuild".
  useEffect(() => {
    void cc.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (cc.isLoading) return <Skeleton className="h-96 w-full" />;
  if (cc.isError) {
    return (
      <Card className="rounded-2xl border-border bg-card">
        <CardContent className="p-5 text-sm text-danger" data-testid="memory-load-error">
          {name}&rsquo;s memory could not be loaded, so no win rate, P&amp;L,
          trade count or equity curve is shown. They are not zero.
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={() => void cc.refetch()} data-testid="button-retry-memory">
              <RefreshCcw className="h-4 w-4 mr-2" />
              Try again
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }
  // The server withheld the paper book for a live account (the same rule as
  // the Trading Calendar): show its note, not paper figures under a LIVE strip.
  if (cc.data?.currentAccountMode === "LIVE_SHARED") {
    return (
      <Card className="rounded-2xl border-border bg-card">
        <CardContent className="p-5 text-sm text-txt-secondary" data-testid="memory-mode-note">
          {cc.data.modeNote ??
            `This is a live account. ${name}'s memory is built from paper trades only and live trades are not totalled here, so no win rate, P&L or equity curve is shown. They are not zero.`}
        </CardContent>
      </Card>
    );
  }
  const c = cc.data?.commandCenter;
  const a = cc.data?.autopilot;
  if (!c) {
    return (
      <Card className="rounded-2xl border-border bg-card">
        <CardContent className="p-5 text-sm text-txt-secondary">
          No memory snapshot yet. Try a few paper trades and {name} will
          start building her record.
        </CardContent>
      </Card>
    );
  }
  const hasClosed = typeof c.totalClosedTrades === "number" && c.totalClosedTrades > 0;
  // Net P&L sums only closes the paper venue could size; when none could be,
  // the server's 0 is not a result.
  const netPnlMeasured = !(typeof c.unsizedClosedTrades === "number" && hasClosed && c.unsizedClosedTrades >= c.totalClosedTrades);

  return (
    <>
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => rebuild.mutate()}
          disabled={rebuild.isPending}
          data-testid="button-rebuild-memory"
        >
          <RefreshCcw
            className={`h-4 w-4 mr-2 ${rebuild.isPending ? "animate-spin" : ""}`}
          />
          Refresh memory
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card className="rounded-2xl border-border bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs">Paper Win Rate</CardTitle>
          </CardHeader>
          <CardContent>
            {/* No closed trade = no win rate measured, not 0%. */}
            <div className="text-xl font-bold" data-testid="memory-win-rate">
              {hasClosed ? `${c.winRate.toFixed(1)}%` : "—"}
            </div>
            <div className="text-[11px] text-txt-secondary mt-1">
              {hasClosed ? "All closed paper trades" : "No closed paper trades yet"}
            </div>
          </CardContent>
        </Card>
        <Card className="rounded-2xl border-border bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs">Net Paper P&amp;L</CardTitle>
          </CardHeader>
          <CardContent>
            {/* No figure when none of the closed trades could be sized: the
                server's 0 then sums nothing. */}
            <div
              className={`text-xl font-bold ${
                !hasClosed || !netPnlMeasured ? "text-txt-secondary" : c.netPnl >= 0 ? "text-success" : "text-danger"
              }`}
              data-testid="memory-net-pnl"
            >
              {!hasClosed ? "—" : netPnlMeasured ? c.netPnl.toFixed(2) : "Not measured"}
            </div>
            {/* The server's basis: how each close was booked and what is left
                out. An older server sends none; no unit is claimed then. */}
            <div className="text-[11px] text-txt-secondary mt-1" data-testid="memory-net-pnl-scope">
              {typeof c.netPnlBasis === "string" && c.netPnlBasis
                ? c.netPnlBasis
                : "All closed paper trades, as booked by the ARX paper simulator (not an MT5 demo or live account)"}
            </div>
          </CardContent>
        </Card>
        <Card className="rounded-2xl border-border bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs">Closed Paper Trades</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{c.totalClosedTrades}</div>
          </CardContent>
        </Card>
        <Card className="rounded-2xl border-border bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs">Improvement Score</CardTitle>
          </CardHeader>
          <CardContent>
            {/* Shown as a number only when the server says how it was
                measured. A server without improvementScoreBasis computed it
                from current edge scores ordered by id (not a trend), and
                read 0.00 when it computed nothing. */}
            {typeof c.learningStats.improvementScore === "number" &&
            typeof c.learningStats.improvementScoreBasis === "string" ? (
              <div className="text-xl font-bold" data-testid="improvement-score">
                {c.learningStats.improvementScore.toFixed(2)}
              </div>
            ) : (
              <>
                <div className="text-xl font-bold text-txt-secondary" data-testid="improvement-score">Not measured</div>
                <div className="text-xs text-txt-secondary">
                  {typeof c.learningStats.improvementScoreBasis === "string"
                    ? c.learningStats.improvementScoreBasis
                    : "Change over time is not measured: strategy edges keep only their current score, not a history."}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-4 w-4" /> Paper Equity Curve (last 30 days)
            </CardTitle>
            <div className="text-[11px] text-txt-secondary">
              Cumulative P&amp;L of paper trades closed in the last 30 days. The
              tiles above cover all closed paper trades.
            </div>
          </CardHeader>
          <CardContent>
            {eq.isLoading ? (
              <Skeleton className="h-48 w-full" />
            ) : eq.isError ? (
              <div className="text-danger text-sm" data-testid="memory-equity-error">
                The equity curve could not be loaded.
              </div>
            ) : eq.data?.equityCurve?.points?.length ? (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={eq.data.equityCurve.points}>
                  <XAxis dataKey="trade_id" hide />
                  <YAxis />
                  <Tooltip />
                  <Line
                    type="monotone"
                    dataKey="cumulative"
                    stroke="#10b981"
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (eq.data?.equityCurve?.unsized_trades ?? 0) > 0 ? null : (
              <div className="text-txt-secondary text-sm">
                No closed paper trades in this range yet.
              </div>
            )}
            {/* Closes the paper venue could not size have no point on the
                curve; the server says how many. */}
            {!eq.isLoading && !eq.isError && typeof eq.data?.equityCurve?.pnl_note === "string" && eq.data.equityCurve.pnl_note && (
              <div className="text-[11px] text-warning mt-2" data-testid="memory-equity-pnl-note">
                {eq.data.equityCurve.pnl_note}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-border bg-card">
          <CardHeader>
            <CardTitle>Best / Worst</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div>
              Best symbol: <Badge>{c.bestSymbol ?? "—"}</Badge>
            </div>
            <div>
              Worst symbol:{" "}
              <Badge variant="outline">{c.worstSymbol ?? "—"}</Badge>
            </div>
            <div>
              Best setup: <Badge>{c.bestSetup ?? "—"}</Badge>
            </div>
            <div>
              Weakest setup:{" "}
              <Badge variant="outline">{c.weakestSetup ?? "—"}</Badge>
            </div>
            {(c.bestSetup || c.weakestSetup) && (
              <div className="text-xs text-txt-secondary" data-testid="setup-ranking-basis">
                {typeof c.setupRankingBasis === "string"
                  ? c.setupRankingBasis
                  : "Setups are ranked by the summed P&L of the trades each signal supported; a trade supported by several signals counts toward each, so these sums overlap."}
              </div>
            )}
            <div>
              Strongest edge:{" "}
              <span className="text-xs">
                {c.strongestEdge
                  ? `${c.strongestEdge.signal} (${c.strongestEdge.edge_score.toFixed(1)})`
                  : "—"}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card className="rounded-2xl border-border bg-card">
          <CardHeader>
            <CardTitle>AI Decision Quality</CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-1">
            <div>
              Decisions: <strong>{c.aiDecisionStats.decisionsCreated}</strong>{" "}
              (BUY {c.aiDecisionStats.buyCount} · SELL{" "}
              {c.aiDecisionStats.sellCount} · HOLD{" "}
              {c.aiDecisionStats.holdCount})
            </div>
            {/* Not "Blocked": no safety-filter outcome is stored per
                decision, so a trade call with no order may have been
                refused, filtered by a setting, or never sent. */}
            <div data-testid="decision-calls-without-order">
              Trade calls with no paper order:{" "}
              {typeof c.aiDecisionStats.tradeCallsWithoutOrder === "number"
                ? `${c.aiDecisionStats.tradeCallsWithoutOrder}${typeof c.aiDecisionStats.tradeCalls === "number" ? ` of ${c.aiDecisionStats.tradeCalls}` : ""}`
                : "—"}{" "}
              · Decision→Trade:{" "}
              {c.aiDecisionStats.decisionToTradeRate.toFixed(1)}%
            </div>
            <div className="text-xs text-txt-secondary">
              Why a call has no order is not recorded, so this is not a count of safety-filter blocks.
            </div>
            <div>
              Decision→Win rate:{" "}
              <strong>
                {c.aiDecisionStats.decisionToWinRate.toFixed(1)}%
              </strong>
            </div>
            <div>
              Avg confidence: {c.aiDecisionStats.avgConfidence.toFixed(1)} ·
              Avg risk: {c.aiDecisionStats.avgRiskScore.toFixed(1)} · Avg
              edge: {c.aiDecisionStats.avgEdgeScore.toFixed(1)}
            </div>
            {dq.data?.decisionQuality && (
              <div className="text-xs text-txt-secondary">
                30d sample: {dq.data.decisionQuality.sample_size_label}
              </div>
            )}
          </CardContent>
        </Card>
        <Card className="rounded-2xl border-border bg-card">
          <CardHeader>
            <CardTitle>Learning Engine</CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-1">
            <div>Learning events: {c.learningStats.learningEvents}</div>
            <div>
              Strategy edges tracked: {c.learningStats.strategyEdgesUpdated}
            </div>
            <div>
              Mistake patterns tracked:{" "}
              {c.learningStats.mistakePatternsTracked}
            </div>
            <div>Confidence: {c.learningStats.learningConfidence}/100</div>
            <div>
              Most repeated mistake:{" "}
              <Badge variant="outline">{c.mostRepeatedMistake ?? "—"}</Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <Card className="rounded-2xl border-border bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lightbulb className="h-4 w-4 text-warning" /> Insights
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-1">
            {c.insights.map((i: string, idx: number) => (
              <div key={idx}>• {i}</div>
            ))}
          </CardContent>
        </Card>
        <Card className="rounded-2xl border-border bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Target className="h-4 w-4 text-success" /> Next Best
              Actions
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-1">
            {c.nextBestActions.map((i: string, idx: number) => (
              <div key={idx}>✓ {i}</div>
            ))}
          </CardContent>
        </Card>
        <Card className="rounded-2xl border-border bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-danger" /> Warnings
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-1">
            {c.warnings.length === 0 ? (
              <div className="text-txt-secondary">No warnings.</div>
            ) : (
              c.warnings.map((i: string, idx: number) => (
                <div key={idx}>⚠ {i}</div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <PaperAutopilotSummaryCard a={a} />
    </>
  );
}

/** What the paper autopilot's "not opened" count is, for a server that sends
 *  no safety_blocks_today_basis. "(UTC)" only when the summary reports that
 *  day basis, as the tiles do. */
const notOpenedTodayBasis = (utc: boolean) =>
  `Counts each symbol a paper autopilot cycle did not open a trade for today${utc ? " (UTC)" : ""}: the AI decided to hold, the daily paper loss limit was reached, the sniper filter skipped it, or paper execution refused it. Ordinary AI holds are included, so this is not a count of safety blocks.`;

/** The paper autopilot (autopilot_cycles, lib/paperAutopilot) — a different
 *  engine from the in-memory simulator autopilot that the Autopilot Control
 *  Center reports. Each surface names the engine it reports. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function PaperAutopilotSummaryCard({ a }: { a: any }) {
  // A missing summary is "could not be loaded", never a row of zeros. When the
  // server counted "today" from a read window (today_counts_capped) the counts
  // are lower bounds.
  const loaded = a != null && typeof a.cycles_today === "number";
  const capped = loaded && a.today_counts_capped === true;
  // A count the summary did not return is unknown ("—"), never 0.
  const n = (v: unknown) =>
    loaded && typeof v === "number" && Number.isFinite(v)
      ? `${v}${capped ? "+" : ""}`
      : "—";
  // "Today" is the server's UTC calendar day — not the reader's local day.
  // The tiles say "(UTC)" only when the summary reports that basis.
  const utc = loaded && a.today_basis === "UTC";
  const today = (label: string) => (utc ? `${label} today (UTC)` : `${label} today`);
  return (
    <Card className="rounded-2xl border-border bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-success" /> Paper autopilot
          — read only
        </CardTitle>
        <p
          className="text-xs text-txt-secondary"
          data-testid="paper-autopilot-scope"
        >
          Cycles of the paper autopilot (paper-trade cycles saved to your
          account). The simulator autopilot on the Autopilot Control Center
          is a separate engine and is not counted here.
        </p>
      </CardHeader>
      <CardContent className="text-sm grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div>
          <div className="text-txt-secondary text-xs">{today("Cycles")}</div>
          <div className="font-bold" data-testid="autopilot-cycles-today">{n(a?.cycles_today)}</div>
        </div>
        <div>
          <div className="text-txt-secondary text-xs">{today("Opened")}</div>
          <div className="font-bold">
            {n(a?.paper_trades_opened_today)}
          </div>
        </div>
        <div>
          <div className="text-txt-secondary text-xs">{today("Closed")}</div>
          <div className="font-bold">
            {n(a?.paper_trades_closed_today)}
          </div>
        </div>
        <div>
          {/* safety_blocks_today sums paper_trades_rejected, which counts
              every symbol a cycle did not open a trade for, ordinary AI
              holds included. It is not a count of safety blocks. */}
          <div className="text-txt-secondary text-xs">
            {today("Not opened")}
          </div>
          <div className="font-bold" data-testid="autopilot-not-opened-today">{n(a?.safety_blocks_today)}</div>
        </div>
        {loaded && (
          <div
            className="col-span-2 sm:col-span-4 text-xs text-txt-secondary"
            data-testid="autopilot-not-opened-basis"
          >
            {typeof a.safety_blocks_today_basis === "string"
              ? a.safety_blocks_today_basis
              : notOpenedTodayBasis(utc)}
          </div>
        )}
        {!loaded ? (
          <div
            className="col-span-2 sm:col-span-4 text-xs text-txt-secondary"
            data-testid="paper-autopilot-missing"
          >
            <span data-testid="autopilot-today-note">
              The paper autopilot summary could not be loaded, so today&apos;s
              cycles and trades are unknown.
            </span>
          </div>
        ) : (
          <>
            <div
              className="col-span-2 sm:col-span-4 text-xs text-txt-secondary"
              data-testid="paper-autopilot-day-basis"
            >
              {utc
                ? "Today = the UTC calendar day (from 00:00 UTC), not your local day."
                : "The day boundary \u201ctoday\u201d uses was not reported by the summary."}
            </div>
            {a.cycles_today === 0 && (
              <div className="col-span-2 sm:col-span-4 text-xs text-txt-secondary" data-testid="autopilot-today-note">
                No autopilot cycle has run today{utc ? " (UTC)" : ""}, so it has not opened, closed or passed on any trade today.
              </div>
            )}
          </>
        )}
        {capped && (
          <div
            className="col-span-2 sm:col-span-4 text-xs text-warning"
            data-testid="paper-autopilot-capped"
          >
            Counted from your latest {a?.cycles_read_limit ?? "few"} cycles
            only, and all of them ran today (UTC), so today&apos;s totals are
            at least these numbers.
          </div>
        )}
        {loaded && a.last_cycle && (
          <div
            className="col-span-2 sm:col-span-4 text-xs text-txt-secondary mt-2"
            data-testid="paper-autopilot-last-cycle"
          >
            {/* Latest cycle overall — not necessarily one of today's. */}
            Last cycle (started{" "}
            {safeDate(a.last_cycle.started_at, "datetime", "time not reported")}):{" "}
            {a.last_cycle.autopilot_cycle_id} —{" "}
            {a.last_cycle.status} · opened{" "}
            {a.last_cycle.paper_trades_opened} · not opened{" "}
            {a.last_cycle.paper_trades_rejected}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
