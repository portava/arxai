// Phase 5E — Per-user paper trades + journal + performance calendar.
// SAFETY: paper-only. All API calls go to /api/me/* and are scoped to the
// logged-in user. No live execution surface.
import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { ShieldAlert, Plus, X, Lock, Sparkles, GraduationCap, BookOpen, ListChecks, CheckCircle2, AlertTriangle, Ban } from "lucide-react";

type PaperTrade = {
  id: number; symbol: string; side: "buy" | "sell"; status: string; entryType: string;
  plannedEntryPrice: number | null; entryPrice: number | null; exitPrice: number | null;
  stopLoss: number | null; takeProfit: number | null; lotSize: number;
  riskAmount: number | null; rewardRiskRatio: number | null;
  pnl: number | null; pnlPercent: number | null;
  openedAt: string | null; closedAt: string | null; cancelledAt: string | null;
  strategyTag: string | null; setupGrade: string | null; reasonForEntry: string | null;
  notes: string | null; createdAt: string;
};
type Journal = {
  id: number; title: string; body: string; mood: string | null;
  disciplineScore: number | null; executionScore: number | null;
  paperTradeId: number | null; lessonLearned: string | null; createdAt: string;
};
type Day = {
  date: string; tradesCount: number; wins: number; losses: number;
  breakeven: number; totalPnl: number; winRate: number;
  bestTrade: number | null; worstTrade: number | null;
};
type Review = {
  id: number; paperTradeId: number; reviewStatus: string;
  setupGrade: string | null; entryGrade: string | null; exitGrade: string | null;
  riskGrade: string | null; disciplineGrade: string | null; overallGrade: string | null;
  overallScore: number | null; aiConfidence: number | null;
  strengths: string[]; weaknesses: string[]; mistakeTags: string[];
  improvementPlan: string[]; nextTradeFocus: string | null;
  riskNotes: string | null; entryNotes: string | null; exitNotes: string | null; disciplineNotes: string | null;
};
type Insights = {
  topSymbols: Array<{ symbol: string; count: number; winRate: number }>;
  byStrategy: Array<{ strategy: string; count: number; winRate: number; avgPnl: number }>;
  averages: { avgWin: number; avgLoss: number; expectancy: number };
  topMistakes: Array<{ tag: string; count: number }>;
  insights: Array<{ severity: "info" | "warning" | "critical"; title: string; detail: string }>;
  bestDay: { date: string; pnl: number } | null;
  worstDay: { date: string; pnl: number } | null;
  isEmpty: boolean; sampleSize: number;
};
type Coaching = {
  traderProfile: string; topStrengths: string[]; topWeaknesses: string[]; topMistakes: string[];
  recommendedFocus: string; riskRuleSuggestion: string; journalingPrompt: string;
  weeklyGoal: string; confidenceNote: string; sampleSize: number; isEmpty: boolean;
};
type Playbook = {
  id: number; title: string; description: string; strategyType: string;
  status: string; source: string;
  preferredSymbols: string[]; entryModel: string; exitModel: string; riskModel: string;
  avoidRules: string[]; confirmationRules: string[];
  confidenceScore: number | null; winRateSnapshot: number | null; sampleSize: number | null;
  notice?: string | null;
};
type PreCheck = {
  id: number; decision: "pass" | "warning" | "block"; score: number;
  passedRequiredCount: number; failedRequiredCount: number;
  failedRules: string[]; passedRules: string[]; improvementNote: string;
  checklistResult: Array<{ rule: string; severity: string; passed: boolean; ruleType: string }>;
};
// Phase 8 — Risk Governor types
type RiskSettings = {
  id: number; maxRiskPerTradePercent: number; maxDailyLossPercent: number;
  maxOpenTrades: number; maxTradesPerDay: number; maxConsecutiveLosses: number;
  minRewardRiskRatio: number; cooldownAfterLossMinutes: number;
  blockAfterDailyLossHit: boolean; blockAfterConsecutiveLosses: boolean;
  requireStopLoss: boolean; requireTakeProfit: boolean;
  requirePlaybook: boolean; requirePreTradeChecklist: boolean; requireJournalReason: boolean;
  allowOverrideInPaperMode: boolean;
  liveLocked: boolean; readOnlyMode: boolean; allowOrderExecution: boolean;
};
type RiskEvent = {
  id: number; eventType: string; severity: string; decision: string;
  reason: string; createdAt: string; overrideReason: string | null; overriddenAt: string | null;
  paperTradeId: number | null;
};
type RiskStatus = {
  settings: RiskSettings;
  today: { pnl: number; trades: number; openTrades: number; consecutiveLosses: number };
  week: { pnl: number };
  cooldown: { active: boolean; minutesRemaining: number };
  lastBlocked: { reason: string; createdAt: string; eventType: string } | null;
};

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method, credentials: "include",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `${method} ${path} failed`);
  return r.json();
}

function StatusBadge({ s }: { s: string }) {
  const map: Record<string, string> = {
    planned: "bg-muted", open: "bg-blue-600",
    closed: "bg-success/15", cancelled: "bg-muted", failed: "bg-red-700",
  };
  return <Badge className={map[s] ?? "bg-muted"}>{s}</Badge>;
}

export default function MyPaperTradesPage() {
  const { toast } = useToast();
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [journal, setJournal] = useState<Journal[]>([]);
  const [days, setDays] = useState<Day[]>([]);
  const [summary, setSummary] = useState<{ totalTrades: number; totalPnl: number; wins: number; losses: number; winRate: number; isEmpty: boolean } | null>(null);
  const [reviews, setReviews] = useState<Record<number, Review>>({});
  const [insights, setInsights] = useState<Insights | null>(null);
  const [coaching, setCoaching] = useState<Coaching | null>(null);
  const [reviewingId, setReviewingId] = useState<number | null>(null);
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [generatingPb, setGeneratingPb] = useState(false);
  const [activePbId, setActivePbId] = useState<number | null>(null);
  const [pcInput, setPcInput] = useState({ symbol: "", stopLoss: "", takeProfit: "", rewardRiskRatio: "", riskPercent: "", reasonForEntry: "" });
  const [pcResult, setPcResult] = useState<PreCheck | null>(null);
  // Phase 8 — Risk Governor state
  const [riskStatus, setRiskStatus] = useState<RiskStatus | null>(null);
  const [riskEvents, setRiskEvents] = useState<RiskEvent[]>([]);
  const [savingRisk, setSavingRisk] = useState(false);
  const [riskDraft, setRiskDraft] = useState<Partial<RiskSettings> | null>(null);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [showJournal, setShowJournal] = useState(false);
  const [closingId, setClosingId] = useState<number | null>(null);
  const [exitPrice, setExitPrice] = useState("");
  const [reasonForExit, setReasonForExit] = useState("");

  // create form
  const [f, setF] = useState({ symbol: "V75", side: "buy", plannedEntryPrice: "", stopLoss: "", takeProfit: "", lotSize: "0.01", riskAmount: "", strategyTag: "", reasonForEntry: "" });
  // journal form
  const [j, setJ] = useState({ title: "", body: "", paperTradeId: "", mood: "", disciplineScore: "", executionScore: "", lessonLearned: "" });

  async function load() {
    setLoading(true);
    try {
      const [t, jr, cal, sum, rv, ins, co, pb, rst, rev] = await Promise.all([
        api<{ trades: PaperTrade[] }>("GET", "/me/paper-trades"),
        api<{ entries: Journal[] }>("GET", "/me/trade-journal"),
        api<{ days: Day[] }>("GET", "/me/performance-calendar"),
        api<{ totalTrades: number; totalPnl: number; wins: number; losses: number; winRate: number; isEmpty: boolean }>("GET", "/me/performance-summary"),
        api<{ reviews: Review[] }>("GET", "/me/ai-trade-reviews"),
        api<Insights>("GET", "/me/performance-insights"),
        api<Coaching>("GET", "/me/coaching-plan"),
        api<{ playbooks: Playbook[] }>("GET", "/me/playbooks"),
        api<RiskStatus>("GET", "/me/risk/status").catch(() => null),
        api<{ events: RiskEvent[] }>("GET", "/me/risk/events").catch(() => ({ events: [] as RiskEvent[] })),
      ]);
      setTrades(t.trades); setJournal(jr.entries); setDays(cal.days); setSummary(sum);
      const rmap: Record<number, Review> = {};
      for (const r of rv.reviews) rmap[r.paperTradeId] = r;
      setReviews(rmap); setInsights(ins); setCoaching(co);
      if (rst) { setRiskStatus(rst); setRiskDraft(rst.settings); }
      setRiskEvents(rev.events);
      setPlaybooks(pb.playbooks);
      if (pb.playbooks[0]) setActivePbId((cur) => cur ?? pb.playbooks[0]!.id);
    } catch (e) {
      toast({ title: "Load failed", description: String(e), variant: "destructive" });
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function createTrade() {
    try {
      const body: Record<string, unknown> = { symbol: f.symbol, side: f.side, lotSize: Number(f.lotSize) };
      if (f.plannedEntryPrice) body.plannedEntryPrice = Number(f.plannedEntryPrice);
      if (f.stopLoss) body.stopLoss = Number(f.stopLoss);
      if (f.takeProfit) body.takeProfit = Number(f.takeProfit);
      if (f.riskAmount) body.riskAmount = Number(f.riskAmount);
      if (f.strategyTag) body.strategyTag = f.strategyTag;
      if (f.reasonForEntry) body.reasonForEntry = f.reasonForEntry;
      await api("POST", "/me/paper-trades", body);
      toast({ title: "Demo trade created", description: "Simulated entry — no broker order placed." });
      setShowNew(false); load();
    } catch (e) { toast({ title: "Failed", description: String(e), variant: "destructive" }); }
  }

  async function openTrade(id: number) {
    const t = trades.find((x) => x.id === id);
    const entry = t?.plannedEntryPrice ?? Number(prompt("Entry price?") ?? "");
    if (!entry || !Number.isFinite(entry)) return;
    try { await api("POST", `/me/paper-trades/${id}/open`, { entryPrice: entry });
      toast({ title: "Simulated entry", description: "Demo trade opened (no broker order)." });
      load();
    } catch (e) { toast({ title: "Failed", description: String(e), variant: "destructive" }); }
  }
  async function doCancel(id: number) {
    try { await api("POST", `/me/paper-trades/${id}/cancel`); load(); }
    catch (e) { toast({ title: "Failed", description: String(e), variant: "destructive" }); }
  }
  async function doClose() {
    if (!closingId) return;
    try {
      await api("POST", `/me/paper-trades/${closingId}/close`, { exitPrice: Number(exitPrice), reasonForExit: reasonForExit || undefined });
      toast({ title: "Simulated close", description: "Demo trade closed (no broker order)." });
      setClosingId(null); setExitPrice(""); setReasonForExit(""); load();
    } catch (e) { toast({ title: "Failed", description: String(e), variant: "destructive" }); }
  }
  async function generatePlaybook() {
    try {
      setGeneratingPb(true);
      const r = await api<Playbook>("POST", "/me/playbooks/generate-from-history");
      toast({ title: "Playbook drafted", description: r.notice ?? `Built from ${r.sampleSize} trade(s). Review and refine.` });
      load();
    } catch (e) { toast({ title: "Generate failed", description: String(e), variant: "destructive" }); }
    finally { setGeneratingPb(false); }
  }
  async function promoteToPlaybook(tradeId: number) {
    try {
      const r = await api<Playbook>("POST", `/me/paper-trades/${tradeId}/promote-to-playbook`);
      toast({ title: "Promoted to playbook", description: r.notice ?? "Draft created. Refine and activate." });
      load();
    } catch (e) { toast({ title: "Promote failed", description: String(e), variant: "destructive" }); }
  }
  async function archivePlaybook(id: number) {
    try { await api("POST", `/me/playbooks/${id}/archive`); toast({ title: "Archived" }); load(); }
    catch (e) { toast({ title: "Failed", description: String(e), variant: "destructive" }); }
  }
  async function activatePlaybook(id: number) {
    try { await api("POST", `/me/playbooks/${id}/activate`); toast({ title: "Activated" }); load(); }
    catch (e) { toast({ title: "Failed", description: String(e), variant: "destructive" }); }
  }
  async function runPreTradeCheck() {
    if (!activePbId || !pcInput.symbol) { toast({ title: "Select playbook & enter symbol", variant: "destructive" }); return; }
    try {
      const body: Record<string, unknown> = { symbol: pcInput.symbol, reasonForEntry: pcInput.reasonForEntry };
      if (pcInput.stopLoss) body.stopLoss = Number(pcInput.stopLoss);
      if (pcInput.takeProfit) body.takeProfit = Number(pcInput.takeProfit);
      if (pcInput.rewardRiskRatio) body.rewardRiskRatio = Number(pcInput.rewardRiskRatio);
      if (pcInput.riskPercent) body.riskPercent = Number(pcInput.riskPercent);
      const r = await api<PreCheck>("POST", `/me/playbooks/${activePbId}/pre-trade-check`, body);
      setPcResult(r);
    } catch (e) { toast({ title: "Check failed", description: String(e), variant: "destructive" }); }
  }
  async function reviewTrade(id: number) {
    try {
      setReviewingId(id);
      const r = await api<Review>("POST", `/me/paper-trades/${id}/review`);
      setReviews((m) => ({ ...m, [id]: r }));
      toast({ title: "AI Trade Review ready", description: `Overall grade: ${r.overallGrade} (${r.overallScore}/100). Educational guidance only.` });
    } catch (e) { toast({ title: "Review failed", description: String(e), variant: "destructive" }); }
    finally { setReviewingId(null); }
  }
  async function createJournal() {
    try {
      const body: Record<string, unknown> = { title: j.title, body: j.body };
      if (j.paperTradeId) body.paperTradeId = Number(j.paperTradeId);
      if (j.mood) body.mood = j.mood;
      if (j.disciplineScore) body.disciplineScore = Number(j.disciplineScore);
      if (j.executionScore) body.executionScore = Number(j.executionScore);
      if (j.lessonLearned) body.lessonLearned = j.lessonLearned;
      await api("POST", "/me/trade-journal", body);
      setShowJournal(false); setJ({ title: "", body: "", paperTradeId: "", mood: "", disciplineScore: "", executionScore: "", lessonLearned: "" });
      load();
    } catch (e) { toast({ title: "Failed", description: String(e), variant: "destructive" }); }
  }

  return (
    <div className="container mx-auto p-6 space-y-6 max-w-7xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">My Demo Trades</h1>
          <p className="text-sm text-muted-foreground">Track decisions safely. Simulated entries only — no broker orders are sent.</p>
        </div>
        <div className="flex gap-2">
          <Badge variant="outline" className="gap-1"><Lock className="h-3 w-3"/>Read-only MT5 bridge</Badge>
          <Button onClick={() => setShowNew(true)}><Plus className="h-4 w-4 mr-1"/>New demo trade</Button>
        </div>
      </div>

      <Alert>
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>Demo-only</AlertTitle>
        <AlertDescription>Live execution is locked. Every action here is a simulated entry/close used to journal your decisions and learn — nothing is sent to a broker.</AlertDescription>
      </Alert>

      <Tabs defaultValue="trades">
        <TabsList>
          <TabsTrigger value="trades">Trades ({trades.length})</TabsTrigger>
          <TabsTrigger value="journal">Journal ({journal.length})</TabsTrigger>
          <TabsTrigger value="calendar">Performance</TabsTrigger>
          <TabsTrigger value="insights"><Sparkles className="h-3 w-3 mr-1"/>Insights</TabsTrigger>
          <TabsTrigger value="coaching"><GraduationCap className="h-3 w-3 mr-1"/>Coaching</TabsTrigger>
          <TabsTrigger value="playbooks"><BookOpen className="h-3 w-3 mr-1"/>Playbooks ({playbooks.length})</TabsTrigger>
          <TabsTrigger value="precheck"><ListChecks className="h-3 w-3 mr-1"/>Pre-Trade Check</TabsTrigger>
          <TabsTrigger value="risk"><ShieldAlert className="h-3 w-3 mr-1"/>Risk Governor{riskStatus?.cooldown.active ? " · cooldown" : ""}</TabsTrigger>
        </TabsList>

        <TabsContent value="risk" className="space-y-3">
          <Alert>
            <Lock className="h-4 w-4"/>
            <AlertTitle>Risk Governor — demo-only safety net</AlertTitle>
            <AlertDescription>Live execution is permanently locked. These rules guard your <em>demo</em> decisions so you build discipline before any future bridge.</AlertDescription>
          </Alert>
          {riskStatus && (
            <div className="grid gap-3 md:grid-cols-4">
              <Card><CardHeader className="pb-1"><CardDescription>Today P&amp;L</CardDescription><CardTitle className={riskStatus.today.pnl >= 0 ? "text-success" : "text-red-500"}>{riskStatus.today.pnl.toFixed(2)}</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">{riskStatus.today.trades} trades · {riskStatus.today.openTrades} open</CardContent></Card>
              <Card><CardHeader className="pb-1"><CardDescription>Consecutive losses</CardDescription><CardTitle>{riskStatus.today.consecutiveLosses} / {riskStatus.settings.maxConsecutiveLosses}</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">{riskStatus.settings.blockAfterConsecutiveLosses ? "Block after cap" : "Warn only"}</CardContent></Card>
              <Card><CardHeader className="pb-1"><CardDescription>Cooldown</CardDescription><CardTitle className={riskStatus.cooldown.active ? "text-warning" : ""}>{riskStatus.cooldown.active ? `${riskStatus.cooldown.minutesRemaining}m` : "—"}</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">After loss: {riskStatus.settings.cooldownAfterLossMinutes}m</CardContent></Card>
              <Card><CardHeader className="pb-1"><CardDescription>Live contract</CardDescription><CardTitle className="text-sm flex items-center gap-1"><Lock className="h-3 w-3"/>locked</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">demo_only · no broker writes</CardContent></Card>
            </div>
          )}
          {riskDraft && (
            <Card>
              <CardHeader><CardTitle className="text-base">Your risk rules</CardTitle><CardDescription>Conservative defaults applied. Live safety fields are read-only.</CardDescription></CardHeader>
              <CardContent className="grid gap-3 md:grid-cols-3 text-sm">
                {[
                  ["maxRiskPerTradePercent","Max risk per trade %"],["maxDailyLossPercent","Max daily loss %"],["minRewardRiskRatio","Min reward:risk"],
                  ["maxOpenTrades","Max open trades"],["maxTradesPerDay","Max trades per day"],["maxConsecutiveLosses","Max consecutive losses"],
                  ["cooldownAfterLossMinutes","Cooldown after loss (min)"],
                ].map(([k,label]) => (
                  <div key={k}><Label className="text-xs">{label}</Label>
                    <Input type="number" value={String((riskDraft as Record<string, unknown>)[k] ?? "")}
                      onChange={(e) => setRiskDraft({ ...riskDraft, [k]: e.target.value === "" ? null : Number(e.target.value) })}/>
                  </div>
                ))}
                {([
                  ["requireStopLoss","Require stop loss"],["requireTakeProfit","Require take profit"],
                  ["requirePlaybook","Require playbook"],["requirePreTradeChecklist","Require pre-trade check"],
                  ["requireJournalReason","Require reason for entry"],
                  ["blockAfterDailyLossHit","Block after daily loss"],["blockAfterConsecutiveLosses","Block after consecutive losses"],
                  ["allowOverrideInPaperMode","Allow override (demo only)"],
                ] as Array<[keyof RiskSettings, string]>).map(([k,label]) => (
                  <label key={String(k)} className="flex items-center gap-2 mt-5">
                    <input type="checkbox" checked={!!(riskDraft as Record<string, unknown>)[k as string]}
                      onChange={(e) => setRiskDraft({ ...riskDraft, [k]: e.target.checked })}/>
                    <span>{label}</span>
                  </label>
                ))}
                <div className="md:col-span-3 flex gap-2 pt-2 border-t">
                  <Button disabled={savingRisk} onClick={async () => {
                    setSavingRisk(true);
                    try {
                      const u = await api<RiskSettings>("PATCH", "/me/risk-settings", riskDraft);
                      setRiskDraft(u); toast({ title: "Risk settings updated" });
                      const s = await api<RiskStatus>("GET", "/me/risk/status"); setRiskStatus(s);
                    } catch (e) { toast({ title: "Save failed", description: String(e), variant: "destructive" }); }
                    finally { setSavingRisk(false); }
                  }}>Save</Button>
                  <Button variant="outline" disabled={savingRisk} onClick={async () => {
                    const u = await api<RiskSettings>("POST", "/me/risk-settings/reset-defaults");
                    setRiskDraft(u); toast({ title: "Reset to conservative defaults" });
                  }}>Reset to defaults</Button>
                  <span className="text-xs text-muted-foreground self-center ml-auto">liveLocked, readOnlyMode, allowOrderExecution are enforced server-side and cannot be changed.</span>
                </div>
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader><CardTitle className="text-base">Recent risk events</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {riskEvents.length === 0 ? <p className="text-sm text-muted-foreground">No risk events yet — your governor is quiet.</p>
                : riskEvents.slice(0, 25).map((e) => (
                <div key={e.id} className="flex items-start gap-2 text-sm border-b pb-2">
                  {e.severity === "critical" ? <Ban className="h-4 w-4 text-red-500 mt-0.5"/>
                    : e.severity === "warning" ? <AlertTriangle className="h-4 w-4 text-warning mt-0.5"/>
                    : <CheckCircle2 className="h-4 w-4 text-success mt-0.5"/>}
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">{e.eventType}</Badge>
                      <Badge variant={e.decision === "block" ? "destructive" : e.decision === "warning" ? "secondary" : "default"} className="text-xs">{e.decision}</Badge>
                      <span className="text-xs text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</span>
                    </div>
                    <p className="mt-1">{e.reason}</p>
                    {e.overrideReason && <p className="text-xs text-warning">Overridden: {e.overrideReason}</p>}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="trades" className="space-y-3">
          {loading ? (
            <Card><CardContent className="p-6 text-sm text-muted-foreground">Loading…</CardContent></Card>
          ) : trades.length === 0 ? (
            <Card><CardContent className="p-10 text-center space-y-2">
              <p className="text-lg font-semibold">No demo trades yet</p>
              <p className="text-sm text-muted-foreground">Start a demo trade to track your decisions.</p>
              <Button onClick={() => setShowNew(true)} className="mt-2"><Plus className="h-4 w-4 mr-1"/>Create your first demo trade</Button>
            </CardContent></Card>
          ) : trades.map((t) => (
            <Card key={t.id}>
              <CardHeader className="pb-2 flex flex-row justify-between items-start">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <span>{t.symbol}</span><Badge variant={t.side === "buy" ? "default" : "destructive"}>{t.side.toUpperCase()}</Badge>
                    <StatusBadge s={t.status}/><Badge variant="outline" className="text-xs">Demo Trade</Badge>
                  </CardTitle>
                  <CardDescription>
                    {t.strategyTag ? `${t.strategyTag} · ` : ""}{t.entryType} · lot {t.lotSize}
                    {t.rewardRiskRatio ? ` · RR ${t.rewardRiskRatio}` : ""}
                  </CardDescription>
                </div>
                <div className="flex gap-2">
                  {t.status === "planned" && <Button size="sm" onClick={() => openTrade(t.id)}>Simulated Entry</Button>}
                  {t.status === "open" && <Button size="sm" onClick={() => { setClosingId(t.id); setExitPrice(String(t.takeProfit ?? "")); }}>Simulated Close</Button>}
                  {t.status === "closed" && <Button size="sm" variant="secondary" disabled={reviewingId === t.id} onClick={() => reviewTrade(t.id)}><Sparkles className="h-3 w-3 mr-1"/>{reviews[t.id] ? "Re-review" : "Review this trade"}</Button>}
                  {t.status === "closed" && <Button size="sm" variant="outline" onClick={() => promoteToPlaybook(t.id)}><BookOpen className="h-3 w-3 mr-1"/>Promote to Playbook</Button>}
                  {(t.status === "planned" || t.status === "open") && <Button size="sm" variant="ghost" onClick={() => doCancel(t.id)}><X className="h-4 w-4"/></Button>}
                </div>
              </CardHeader>
              <CardContent className="text-sm grid grid-cols-2 md:grid-cols-4 gap-2">
                <div><span className="text-muted-foreground">Entry:</span> {t.entryPrice ?? t.plannedEntryPrice ?? "—"}</div>
                <div><span className="text-muted-foreground">SL:</span> {t.stopLoss ?? "—"}</div>
                <div><span className="text-muted-foreground">TP:</span> {t.takeProfit ?? "—"}</div>
                <div><span className="text-muted-foreground">Risk:</span> {t.riskAmount ?? "—"}</div>
                {t.status === "closed" && (<>
                  <div><span className="text-muted-foreground">Exit:</span> {t.exitPrice}</div>
                  <div className={t.pnl != null && t.pnl >= 0 ? "text-success" : "text-red-500"}>
                    <span className="text-muted-foreground">PnL:</span> {t.pnl}
                  </div>
                </>)}
                {t.reasonForEntry && <div className="col-span-full text-muted-foreground italic">"{t.reasonForEntry}"</div>}
                {reviews[t.id] && (
                  <div className="col-span-full mt-2 border-t pt-2 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge className="bg-premium/15"><Sparkles className="h-3 w-3 mr-1"/>AI Trade Review</Badge>
                      <Badge variant="outline">Overall: {reviews[t.id].overallGrade} ({reviews[t.id].overallScore}/100)</Badge>
                      <Badge variant="outline">Setup: {reviews[t.id].setupGrade}</Badge>
                      <Badge variant="outline">Risk: {reviews[t.id].riskGrade}</Badge>
                      <Badge variant="outline">Entry: {reviews[t.id].entryGrade}</Badge>
                      <Badge variant="outline">Exit: {reviews[t.id].exitGrade}</Badge>
                      <Badge variant="outline">Discipline: {reviews[t.id].disciplineGrade}</Badge>
                      <Badge variant="outline" className="text-xs">Educational only</Badge>
                    </div>
                    {reviews[t.id].strengths.length > 0 && <div><span className="text-success font-medium">What went well:</span> <span className="text-muted-foreground">{reviews[t.id].strengths.join(" · ")}</span></div>}
                    {reviews[t.id].weaknesses.length > 0 && <div><span className="text-red-400 font-medium">What to fix:</span> <span className="text-muted-foreground">{reviews[t.id].weaknesses.join(" · ")}</span></div>}
                    {reviews[t.id].mistakeTags.length > 0 && <div className="flex gap-1 flex-wrap"><span className="text-muted-foreground">Mistake tags:</span>{reviews[t.id].mistakeTags.map((m) => <Badge key={m} variant="destructive" className="text-xs">{m}</Badge>)}</div>}
                    {reviews[t.id].improvementPlan.length > 0 && <ul className="list-disc list-inside text-muted-foreground">{reviews[t.id].improvementPlan.map((p, i) => <li key={i}>{p}</li>)}</ul>}
                    {reviews[t.id].nextTradeFocus && <div><span className="text-blue-400 font-medium">Next trade focus:</span> {reviews[t.id].nextTradeFocus}</div>}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="journal" className="space-y-3">
          <div className="flex justify-end"><Button onClick={() => setShowJournal(true)}><Plus className="h-4 w-4 mr-1"/>Add note</Button></div>
          {journal.length === 0 ? (
            <Card><CardContent className="p-10 text-center text-sm text-muted-foreground">
              <p className="text-lg font-semibold text-foreground mb-1">No journal entries yet</p>
              Start journaling a trade to capture lessons learned.
            </CardContent></Card>
          ) : journal.map((e) => (
            <Card key={e.id}>
              <CardHeader className="pb-2"><CardTitle className="text-base">{e.title}</CardTitle>
                <CardDescription>
                  {new Date(e.createdAt).toLocaleString()}
                  {e.paperTradeId ? ` · trade #${e.paperTradeId}` : ""}
                  {e.mood ? ` · mood: ${e.mood}` : ""}
                  {e.disciplineScore != null ? ` · discipline ${e.disciplineScore}` : ""}
                  {e.executionScore != null ? ` · execution ${e.executionScore}` : ""}
                </CardDescription>
              </CardHeader>
              <CardContent className="text-sm space-y-1">
                <p className="whitespace-pre-wrap">{e.body}</p>
                {e.lessonLearned && <p className="text-success italic">Lesson: {e.lessonLearned}</p>}
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="calendar" className="space-y-3">
          {summary && (
            <Card><CardContent className="p-4 grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
              <div><div className="text-muted-foreground">Trades</div><div className="text-xl font-semibold">{summary.totalTrades}</div></div>
              <div><div className="text-muted-foreground">P/L</div><div className={`text-xl font-semibold ${summary.totalPnl >= 0 ? "text-success" : "text-red-500"}`}>{summary.totalPnl}</div></div>
              <div><div className="text-muted-foreground">Wins</div><div className="text-xl font-semibold text-success">{summary.wins}</div></div>
              <div><div className="text-muted-foreground">Losses</div><div className="text-xl font-semibold text-red-500">{summary.losses}</div></div>
              <div><div className="text-muted-foreground">Win rate</div><div className="text-xl font-semibold">{summary.winRate}%</div></div>
            </CardContent></Card>
          )}
          {days.length === 0 ? (
            <Card><CardContent className="p-10 text-center text-sm text-muted-foreground">
              <p className="text-lg font-semibold text-foreground mb-1">Your performance calendar will populate after your first closed trade</p>
              No fake data. Close a demo trade to see your day appear here.
            </CardContent></Card>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
              {days.map((d) => {
                const tone = d.totalPnl > 0 ? "border-success/60 bg-success/5"
                  : d.totalPnl < 0 ? "border-red-500/60 bg-red-500/5" : "border-border/40";
                return (
                  <Card key={d.date} className={`border ${tone}`}>
                    <CardContent className="p-3">
                      <div className="text-xs text-muted-foreground">{d.date}</div>
                      <div className={`text-lg font-semibold ${d.totalPnl >= 0 ? "text-success" : "text-red-500"}`}>{d.totalPnl}</div>
                      <div className="text-xs">{d.wins}W / {d.losses}L · {d.tradesCount} trades</div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="insights" className="space-y-3">
          {!insights || insights.isEmpty ? (
            <Card><CardContent className="p-10 text-center text-sm text-muted-foreground">
              <p className="text-lg font-semibold text-foreground mb-1">No AI insights yet</p>
              Close a demo trade to unlock performance insights — no fake data.
            </CardContent></Card>
          ) : (
            <>
              <Card><CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Sparkles className="h-4 w-4"/>Performance Insights</CardTitle><CardDescription>Across {insights.sampleSize} trades · educational only</CardDescription></CardHeader>
                <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                  <div><div className="text-muted-foreground">Avg win</div><div className="text-success font-semibold">{insights.averages.avgWin}</div></div>
                  <div><div className="text-muted-foreground">Avg loss</div><div className="text-red-500 font-semibold">{insights.averages.avgLoss}</div></div>
                  <div><div className="text-muted-foreground">Expectancy</div><div className={`font-semibold ${insights.averages.expectancy >= 0 ? "text-success" : "text-red-500"}`}>{insights.averages.expectancy}</div></div>
                  <div><div className="text-muted-foreground">Best day</div><div>{insights.bestDay ? `${insights.bestDay.date} (${insights.bestDay.pnl})` : "—"}</div></div>
                </CardContent>
              </Card>
              {insights.insights.length > 0 && (
                <Card><CardHeader className="pb-2"><CardTitle className="text-base">Patterns detected</CardTitle></CardHeader>
                  <CardContent className="space-y-2">
                    {insights.insights.map((i, idx) => (
                      <Alert key={idx} variant={i.severity === "critical" ? "destructive" : "default"}>
                        <AlertTitle>{i.title} <Badge variant="outline" className="ml-2 text-xs">{i.severity}</Badge></AlertTitle>
                        <AlertDescription>{i.detail}</AlertDescription>
                      </Alert>
                    ))}
                  </CardContent>
                </Card>
              )}
              {insights.byStrategy.length > 0 && (
                <Card><CardHeader className="pb-2"><CardTitle className="text-base">By strategy</CardTitle></CardHeader>
                  <CardContent className="space-y-1 text-sm">{insights.byStrategy.map((s) => (
                    <div key={s.strategy} className="flex justify-between"><span>{s.strategy}</span><span className="text-muted-foreground">{s.count} trades · {s.winRate}% win · avg {s.avgPnl}</span></div>
                  ))}</CardContent>
                </Card>
              )}
              {insights.topMistakes.length > 0 && (
                <Card><CardHeader className="pb-2"><CardTitle className="text-base">Top mistake tags</CardTitle></CardHeader>
                  <CardContent className="flex gap-2 flex-wrap">{insights.topMistakes.map((m) => <Badge key={m.tag} variant="destructive">{m.tag} ×{m.count}</Badge>)}</CardContent>
                </Card>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="coaching" className="space-y-3">
          {!coaching || coaching.isEmpty ? (
            <Card><CardContent className="p-10 text-center text-sm text-muted-foreground">
              <p className="text-lg font-semibold text-foreground mb-1">Your coaching plan will improve as you journal more trades</p>
              Complete and journal at least one demo trade to unlock personalized coaching.
            </CardContent></Card>
          ) : (
            <>
              <Card><CardHeader><CardTitle className="text-base flex items-center gap-2"><GraduationCap className="h-4 w-4"/>{coaching.traderProfile}</CardTitle><CardDescription>Based on {coaching.sampleSize} of your trades · educational guidance only</CardDescription></CardHeader>
                <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                  <div><div className="text-success font-medium mb-1">Top strengths</div><ul className="list-disc list-inside text-muted-foreground">{coaching.topStrengths.length ? coaching.topStrengths.map((s) => <li key={s}>{s}</li>) : <li>Build a track record first</li>}</ul></div>
                  <div><div className="text-red-400 font-medium mb-1">Top weaknesses</div><ul className="list-disc list-inside text-muted-foreground">{coaching.topWeaknesses.length ? coaching.topWeaknesses.map((s) => <li key={s}>{s}</li>) : <li>None detected yet</li>}</ul></div>
                  <div><div className="text-warning font-medium mb-1">Top mistakes to fix</div><ul className="list-disc list-inside text-muted-foreground">{coaching.topMistakes.length ? coaching.topMistakes.map((s) => <li key={s}>{s}</li>) : <li>Clean record so far</li>}</ul></div>
                </CardContent>
              </Card>
              <Card><CardContent className="p-4 space-y-2 text-sm">
                <div><span className="text-muted-foreground">Recommended focus:</span> {coaching.recommendedFocus}</div>
                <div><span className="text-muted-foreground">Risk rule:</span> {coaching.riskRuleSuggestion}</div>
                <div><span className="text-muted-foreground">Journaling prompt:</span> {coaching.journalingPrompt}</div>
                <div><span className="text-muted-foreground">Weekly goal:</span> {coaching.weeklyGoal}</div>
                <div className="text-xs italic text-muted-foreground border-t pt-2">{coaching.confidenceNote}</div>
              </CardContent></Card>
            </>
          )}
        </TabsContent>

        <TabsContent value="playbooks" className="space-y-3">
          <div className="flex justify-between items-center">
            <h3 className="text-base font-semibold">Your trading playbooks</h3>
            <Button size="sm" onClick={generatePlaybook} disabled={generatingPb}><Sparkles className="h-3 w-3 mr-1"/>{generatingPb ? "Generating…" : "Generate from My History"}</Button>
          </div>
          {playbooks.length === 0 ? (
            <Card><CardContent className="p-10 text-center text-sm text-muted-foreground space-y-1">
              <p className="text-lg font-semibold text-foreground">No playbooks yet</p>
              <p>Create your first trading playbook, or close more demo trades to let ARX AI generate better strategy rules.</p>
            </CardContent></Card>
          ) : playbooks.map((p) => (
            <Card key={p.id}>
              <CardHeader className="pb-2 flex flex-row justify-between items-start">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">{p.title}
                    <Badge variant={p.status === "active" ? "default" : p.status === "archived" ? "secondary" : "outline"}>{p.status}</Badge>
                    <Badge variant="outline" className="text-xs">{p.source}</Badge>
                    {p.confidenceScore != null && <Badge variant="outline" className="text-xs">conf {Math.round(p.confidenceScore)}</Badge>}
                  </CardTitle>
                  <CardDescription>{p.description}</CardDescription>
                </div>
                <div className="flex gap-1">
                  {p.status !== "active" && <Button size="sm" variant="outline" onClick={() => activatePlaybook(p.id)}>Activate</Button>}
                  {p.status !== "archived" && <Button size="sm" variant="ghost" onClick={() => archivePlaybook(p.id)}>Archive</Button>}
                </div>
              </CardHeader>
              <CardContent className="text-sm space-y-1">
                {p.preferredSymbols.length > 0 && <div><span className="text-muted-foreground">Symbols:</span> {p.preferredSymbols.join(", ")}</div>}
                <div><span className="text-muted-foreground">Entry:</span> {p.entryModel || "—"}</div>
                <div><span className="text-muted-foreground">Exit:</span> {p.exitModel || "—"}</div>
                <div><span className="text-muted-foreground">Risk:</span> {p.riskModel || "—"}</div>
                {p.avoidRules.length > 0 && <div><span className="text-red-400">Avoid:</span> {p.avoidRules.join(" · ")}</div>}
                {p.notice && <Alert><AlertDescription className="text-xs">{p.notice}</AlertDescription></Alert>}
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="precheck" className="space-y-3">
          {playbooks.length === 0 ? (
            <Card><CardContent className="p-10 text-center text-sm text-muted-foreground">
              <p className="text-lg font-semibold text-foreground mb-1">No playbooks yet</p>
              Create or generate a playbook first to run pre-trade checks.
            </CardContent></Card>
          ) : (
            <>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><ListChecks className="h-4 w-4"/>Pre-Trade Checklist</CardTitle><CardDescription>Validate a setup against your playbook before opening a demo trade. Educational guidance only.</CardDescription></CardHeader>
                <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-muted-foreground">Playbook</label>
                    <select className="w-full bg-background border rounded p-2 text-sm" value={activePbId ?? ""} onChange={(e) => setActivePbId(Number(e.target.value))}>
                      {playbooks.map((p) => <option key={p.id} value={p.id}>{p.title} ({p.status})</option>)}
                    </select>
                  </div>
                  <Input placeholder="Symbol (e.g. V75)" value={pcInput.symbol} onChange={(e) => setPcInput({ ...pcInput, symbol: e.target.value })}/>
                  <Input placeholder="Stop loss" value={pcInput.stopLoss} onChange={(e) => setPcInput({ ...pcInput, stopLoss: e.target.value })}/>
                  <Input placeholder="Take profit" value={pcInput.takeProfit} onChange={(e) => setPcInput({ ...pcInput, takeProfit: e.target.value })}/>
                  <Input placeholder="Reward:risk" value={pcInput.rewardRiskRatio} onChange={(e) => setPcInput({ ...pcInput, rewardRiskRatio: e.target.value })}/>
                  <Input placeholder="Risk %" value={pcInput.riskPercent} onChange={(e) => setPcInput({ ...pcInput, riskPercent: e.target.value })}/>
                  <Textarea className="md:col-span-2" placeholder="Reason for entry (required)" value={pcInput.reasonForEntry} onChange={(e) => setPcInput({ ...pcInput, reasonForEntry: e.target.value })}/>
                  <Button className="md:col-span-2" onClick={runPreTradeCheck}>Run pre-trade check</Button>
                </CardContent>
              </Card>
              {pcResult && (
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2">
                    {pcResult.decision === "pass" && <><CheckCircle2 className="h-4 w-4 text-success"/><span className="text-success">PASS</span></>}
                    {pcResult.decision === "warning" && <><AlertTriangle className="h-4 w-4 text-warning"/><span className="text-warning">WARNING</span></>}
                    {pcResult.decision === "block" && <><Ban className="h-4 w-4 text-red-500"/><span className="text-red-500">BLOCK (advisory, demo-only)</span></>}
                    <Badge variant="outline">Score {pcResult.score}/100</Badge>
                    <Badge variant="outline" className="text-xs">{pcResult.passedRequiredCount}/{pcResult.passedRequiredCount + pcResult.failedRequiredCount} required passed</Badge>
                  </CardTitle></CardHeader>
                  <CardContent className="text-sm space-y-2">
                    <div className="text-muted-foreground italic">{pcResult.improvementNote}</div>
                    <div className="space-y-1">
                      {pcResult.checklistResult.map((c, i) => (
                        <div key={i} className="flex items-start gap-2">
                          {c.passed ? <CheckCircle2 className="h-4 w-4 text-success mt-0.5"/> : <Ban className="h-4 w-4 text-red-500 mt-0.5"/>}
                          <span className={c.passed ? "" : "text-red-400"}>{c.rule}</span>
                          <Badge variant="outline" className="text-xs ml-auto">{c.severity}</Badge>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>

      {showNew && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowNew(false)}>
          <Card className="w-full max-w-lg m-4" onClick={(e) => e.stopPropagation()}>
            <CardHeader><CardTitle>New Demo Trade</CardTitle><CardDescription>Simulated entry — no broker order will be sent.</CardDescription></CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div><Label>Symbol</Label><Input value={f.symbol} onChange={(e) => setF({ ...f, symbol: e.target.value })}/></div>
                <div><Label>Side</Label>
                  <select className="w-full h-10 bg-background border rounded px-2" value={f.side} onChange={(e) => setF({ ...f, side: e.target.value })}>
                    <option value="buy">buy</option><option value="sell">sell</option>
                  </select>
                </div>
                <div><Label>Lot size</Label><Input type="number" step="0.01" value={f.lotSize} onChange={(e) => setF({ ...f, lotSize: e.target.value })}/></div>
                <div><Label>Risk amount</Label><Input type="number" step="0.01" value={f.riskAmount} onChange={(e) => setF({ ...f, riskAmount: e.target.value })}/></div>
                <div><Label>Planned entry</Label><Input type="number" step="0.01" value={f.plannedEntryPrice} onChange={(e) => setF({ ...f, plannedEntryPrice: e.target.value })}/></div>
                <div><Label>Strategy tag</Label><Input value={f.strategyTag} onChange={(e) => setF({ ...f, strategyTag: e.target.value })}/></div>
                <div><Label>Stop loss</Label><Input type="number" step="0.01" value={f.stopLoss} onChange={(e) => setF({ ...f, stopLoss: e.target.value })}/></div>
                <div><Label>Take profit</Label><Input type="number" step="0.01" value={f.takeProfit} onChange={(e) => setF({ ...f, takeProfit: e.target.value })}/></div>
              </div>
              <div><Label>Reason for entry</Label><Textarea value={f.reasonForEntry} onChange={(e) => setF({ ...f, reasonForEntry: e.target.value })}/></div>
            </CardContent>
            <div className="flex justify-end gap-2 p-4 pt-0">
              <Button variant="ghost" onClick={() => setShowNew(false)}>Cancel</Button>
              <Button onClick={createTrade}>Create demo trade</Button>
            </div>
          </Card>
        </div>
      )}

      {closingId && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setClosingId(null)}>
          <Card className="w-full max-w-md m-4" onClick={(e) => e.stopPropagation()}>
            <CardHeader><CardTitle>Simulated Close</CardTitle><CardDescription>No broker order will be sent.</CardDescription></CardHeader>
            <CardContent className="space-y-3">
              <div><Label>Exit price</Label><Input type="number" step="0.01" value={exitPrice} onChange={(e) => setExitPrice(e.target.value)}/></div>
              <div><Label>Reason for exit</Label><Textarea value={reasonForExit} onChange={(e) => setReasonForExit(e.target.value)}/></div>
            </CardContent>
            <div className="flex justify-end gap-2 p-4 pt-0">
              <Button variant="ghost" onClick={() => setClosingId(null)}>Cancel</Button>
              <Button onClick={doClose}>Close demo trade</Button>
            </div>
          </Card>
        </div>
      )}

      {showJournal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowJournal(false)}>
          <Card className="w-full max-w-lg m-4" onClick={(e) => e.stopPropagation()}>
            <CardHeader><CardTitle>New Journal Entry</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div><Label>Title</Label><Input value={j.title} onChange={(e) => setJ({ ...j, title: e.target.value })}/></div>
              <div><Label>Body</Label><Textarea rows={5} value={j.body} onChange={(e) => setJ({ ...j, body: e.target.value })}/></div>
              <div className="grid grid-cols-3 gap-2">
                <div><Label>Linked trade #</Label><Input value={j.paperTradeId} onChange={(e) => setJ({ ...j, paperTradeId: e.target.value })}/></div>
                <div><Label>Mood</Label><Input value={j.mood} onChange={(e) => setJ({ ...j, mood: e.target.value })}/></div>
                <div><Label>Discipline</Label><Input type="number" value={j.disciplineScore} onChange={(e) => setJ({ ...j, disciplineScore: e.target.value })}/></div>
                <div><Label>Execution</Label><Input type="number" value={j.executionScore} onChange={(e) => setJ({ ...j, executionScore: e.target.value })}/></div>
                <div className="col-span-2"><Label>Lesson learned</Label><Input value={j.lessonLearned} onChange={(e) => setJ({ ...j, lessonLearned: e.target.value })}/></div>
              </div>
            </CardContent>
            <div className="flex justify-end gap-2 p-4 pt-0">
              <Button variant="ghost" onClick={() => setShowJournal(false)}>Cancel</Button>
              <Button onClick={createJournal}>Save note</Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
