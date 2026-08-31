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
  type MentorActionItem,
  type MentorSession,
} from "@/components/aiMentor";

// Ruby Command Center — 4-tab, user-facing surface.
//
// Tabs:
//   • Chat       — opens Ruby's floating live chat (voice + typing-indicator
//                  ready) and shows the user's recent mentor briefings as
//                  saved conversations.
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

// Opens the mounted assistant panel NOW via its real open event.
// (The old body forged a StorageEvent — and its comment claimed the panel
// "watches storage events"; it never did, so the button silently no-oped.
// See lib/assistantPanelBus.)
import { openAssistantPanel as openRubyLiveChat } from "@/lib/assistantPanelBus";

interface CCResp {
  // The shape comes straight from /api/performance/ai-command-center; using
  // `any` here is intentional and matches the previous implementation. The
  // page only renders display values, never raw identifier names.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  commandCenter: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  autopilot: any;
}

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

  const latest = useQuery<{
    session: MentorSession | null;
    actionItems: MentorActionItem[];
  }>({
    queryKey: ["mentor-latest"],
    queryFn: async () => (await fetch("/api/mentor/sessions/latest")).json(),
  });
  const history = useQuery<{ sessions: MentorSession[] }>({
    queryKey: ["mentor-history"],
    queryFn: async () => (await fetch("/api/mentor/sessions?limit=10")).json(),
  });

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
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-base font-semibold flex items-center gap-2">
              <MessageCircle className="h-4 w-4 text-ruby" />
              Talk to {name}
            </h3>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-success/40 bg-success/10 px-2.5 py-0.5 text-xs font-medium text-success">
              <span className="h-1.5 w-1.5 rounded-full bg-success" /> {name} is ready
            </span>
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

      {/* Latest mentor briefing — treated as Ruby's most recent saved chat */}
      {latest.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : session ? (
        <>
          <MentorWarningCard session={session} />
          <DailyMentorBriefingCard session={session} />
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

      {/* Saved conversations / history — grouped */}
      <section>
        <h3 className="mb-2 flex items-center gap-2 text-base font-semibold">
          <MessageCircle className="h-4 w-4 text-ruby" />
          Recent {name} Conversations
        </h3>
        {history.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <MentorHistory sessions={history.data?.sessions ?? []} />
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

function MemoryTab() {
  const { name } = useAssistantName();
  const qc = useQueryClient();
  const cc = useQuery<CCResp>({
    queryKey: ["ai-cc"],
    queryFn: async () =>
      (await fetch("/api/performance/ai-command-center")).json(),
  });
  const eq = useQuery<{
    equityCurve?: { points?: Array<{ trade_id: number; cumulative: number }> };
  }>({
    queryKey: ["ai-cc-equity"],
    queryFn: async () =>
      (await fetch("/api/performance/equity-curve?range=30d")).json(),
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
  const c = cc.data?.commandCenter;
  const a = cc.data?.autopilot;
  if (!c) {
    return (
      <Card className="rounded-2xl border-border bg-card">
        <CardContent className="p-5 text-sm text-txt-secondary">
          No memory snapshot yet. Try a few demo trades and {name} will
          start building her record.
        </CardContent>
      </Card>
    );
  }

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
            <CardTitle className="text-xs">Win Rate</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">{c.winRate.toFixed(1)}%</div>
          </CardContent>
        </Card>
        <Card className="rounded-2xl border-border bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs">Net P&amp;L</CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className={`text-xl font-bold ${
                c.netPnl >= 0 ? "text-success" : "text-danger"
              }`}
            >
              {c.netPnl.toFixed(2)}
            </div>
          </CardContent>
        </Card>
        <Card className="rounded-2xl border-border bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs">Closed Demo Trades</CardTitle>
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
            <div className="text-xl font-bold">
              {c.learningStats.improvementScore.toFixed(2)}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-4 w-4" /> Equity Curve (30d)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {eq.isLoading ? (
              <Skeleton className="h-48 w-full" />
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
            ) : (
              <div className="text-txt-secondary text-sm">
                No closed demo trades in this range yet.
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
            <div>
              Blocked: {c.aiDecisionStats.blockedCount} · Decision→Trade:{" "}
              {c.aiDecisionStats.decisionToTradeRate.toFixed(1)}%
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

      <Card className="rounded-2xl border-border bg-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-success" /> Autopilot
            — Read Only
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <div className="text-txt-secondary text-xs">Cycles today</div>
            <div className="font-bold">{a?.cycles_today ?? 0}</div>
          </div>
          <div>
            <div className="text-txt-secondary text-xs">Opened today</div>
            <div className="font-bold">
              {a?.paper_trades_opened_today ?? 0}
            </div>
          </div>
          <div>
            <div className="text-txt-secondary text-xs">Closed today</div>
            <div className="font-bold">
              {a?.paper_trades_closed_today ?? 0}
            </div>
          </div>
          <div>
            <div className="text-txt-secondary text-xs">
              Safety blocks today
            </div>
            <div className="font-bold">{a?.safety_blocks_today ?? 0}</div>
          </div>
          {a?.last_cycle && (
            <div className="col-span-2 sm:col-span-4 text-xs text-txt-secondary mt-2">
              Last cycle: {a.last_cycle.autopilot_cycle_id} —{" "}
              {a.last_cycle.status} · opened{" "}
              {a.last_cycle.paper_trades_opened} · rejected{" "}
              {a.last_cycle.paper_trades_rejected}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
