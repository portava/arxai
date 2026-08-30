import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Brain, TrendingUp, TrendingDown, Heart, Upload,
  BarChart3, Clock, Target, AlertTriangle, CheckCircle,
  ChevronDown, ChevronUp, RefreshCw, Smile,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { PageShell } from "@/components/ss/PageShell";
import { useAssistantName } from "@/lib/assistant-name";

// ── API helpers ────────────────────────────────────────────────────────────────
const apiFetch = (url: string) =>
  fetch(url, { credentials: "include" }).then((r) => r.json());

const apiPost = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

// ── Mood states ───────────────────────────────────────────────────────────────
const MOODS = [
  { value: "CALM",       label: "Calm",       emoji: "😌", risk: "low"     },
  { value: "FOCUSED",    label: "Focused",    emoji: "🎯", risk: "low"     },
  { value: "CONFIDENT",  label: "Confident",  emoji: "💪", risk: "low"     },
  { value: "OBSERVING",  label: "Observing",  emoji: "👀", risk: "low"     },
  { value: "UNCERTAIN",  label: "Uncertain",  emoji: "🤔", risk: "caution" },
  { value: "TIRED",      label: "Tired",      emoji: "😴", risk: "caution" },
  { value: "FRUSTRATED", label: "Frustrated", emoji: "😤", risk: "high"    },
  { value: "RUSHED",     label: "Rushed",     emoji: "⏰", risk: "high"    },
  { value: "REVENGE",    label: "Revenge",    emoji: "🔥", risk: "high"    },
  { value: "FOMO",       label: "FOMO",       emoji: "😰", risk: "high"    },
] as const;

const TABS = [
  { id: "dna",     label: "Strategy DNA",  icon: Brain    },
  { id: "mood",    label: "Mood Check-In", icon: Heart    },
  { id: "history", label: "Trade History", icon: BarChart3 },
] as const;

type Tab = typeof TABS[number]["id"];

// ── Stat chip ─────────────────────────────────────────────────────────────────
function StatChip({ label, value, sub }: { label: string; value: string | number | null; sub?: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className="text-lg font-semibold font-mono">{value ?? "—"}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

// ── DNA tab ───────────────────────────────────────────────────────────────────
function DnaTab() {
  const { name } = useAssistantName();
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["me", "trade-history", "summary"],
    queryFn:  () => apiFetch("/api/me/trade-history/summary"),
  });

  if (isLoading) return <div className="text-sm text-muted-foreground p-4">Loading your trading profile…</div>;

  const s = data;

  if (!s?.hasTrades) {
    return (
      <Alert>
        <Brain className="h-4 w-4" />
        <AlertTitle>No trading history yet</AlertTitle>
        <AlertDescription>
          Import your MT5 history from the Trade History tab to build your Strategy DNA profile.
          {name} will learn your best symbols, sessions, and common mistakes.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold">Strategy DNA</h2>
          <p className="text-xs text-muted-foreground">
            Built from {s.count} trades across {(s.sources as string[])?.join(", ")}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatChip label="Win Rate"      value={s.winRate !== null ? `${s.winRate}%` : null} />
        <StatChip label="Total P/L"     value={s.totalNetPnl !== null ? `$${s.totalNetPnl}` : null} />
        <StatChip label="Avg Win"       value={s.avgWin  !== null ? `$${s.avgWin}` : null} />
        <StatChip label="Avg Loss"      value={s.avgLoss !== null ? `$${s.avgLoss}` : null} />
      </div>

      {s.topSymbols && (s.topSymbols as Array<{ symbol: string; winRate: number; count: number }>).length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1.5">
              <TrendingUp className="h-4 w-4 text-success" /> Top Symbols
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(s.topSymbols as Array<{ symbol: string; winRate: number; count: number }>).slice(0, 5).map((sym) => (
              <div key={sym.symbol} className="flex items-center justify-between text-sm">
                <span className="font-medium font-mono">{sym.symbol}</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{sym.count} trades</span>
                  <Badge
                    variant={sym.winRate >= 55 ? "default" : sym.winRate >= 45 ? "secondary" : "destructive"}
                    className="text-xs"
                  >
                    {sym.winRate.toFixed(0)}%
                  </Badge>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {s.sessions && Object.keys(s.sessions).length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1.5">
              <Clock className="h-4 w-4 text-primary" /> Sessions
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-2">
            {Object.entries(s.sessions as Record<string, { count: number; netPnl: number }>).map(([ses, d]) => (
              <div key={ses} className="rounded border p-2 text-xs">
                <div className="font-medium capitalize mb-0.5">{ses}</div>
                <div className="text-muted-foreground">{d.count} trades</div>
                <div className={d.netPnl >= 0 ? "text-success" : "text-danger"}>
                  {d.netPnl >= 0 ? "+" : ""}${d.netPnl.toFixed(2)}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Mood tab ──────────────────────────────────────────────────────────────────
function MoodTab() {
  const { name } = useAssistantName();
  const qc = useQueryClient();
  const [selectedMood, setSelectedMood] = useState<string>("");
  const [note, setNote] = useState("");
  const [result, setResult] = useState<{ warning?: string; message?: string; isHighRisk?: boolean; emoji?: string; label?: string } | null>(null);

  const { data: patterns } = useQuery({
    queryKey: ["me", "mood", "patterns"],
    queryFn:  () => apiFetch("/api/me/mood/patterns"),
  });

  const { data: recent } = useQuery({
    queryKey: ["me", "mood", "recent"],
    queryFn:  () => apiFetch("/api/me/mood/recent?limit=5"),
  });

  const checkInMut = useMutation({
    mutationFn: (mood: string) =>
      apiPost("/api/me/mood/check-in", { mood, note: note || undefined, trigger: "manual" }),
    onSuccess: (data) => {
      setResult(data);
      setNote("");
      qc.invalidateQueries({ queryKey: ["me", "mood"] });
    },
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">How are you feeling right now?</CardTitle>
          {/* HONESTY: this used to say the check-in "helps {name} protect you
              from emotional trading". Nothing consumes a check-in at trade
              time — meMood.ts is explicit that it "Never blocks trade
              execution" — so no protection happens. It records and warns. */}
          <CardDescription>
            A check-in is recorded and warns you now; it does not block or change any trade.
            Over time it shows {name} which states you trade in and how those trades ended.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {MOODS.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => setSelectedMood(m.value)}
                className={`
                  rounded-lg border p-2.5 text-center text-xs transition cursor-pointer
                  ${selectedMood === m.value
                    ? m.risk === "high"    ? "border-danger bg-danger/10"
                    : m.risk === "caution" ? "border-warning bg-warning/10"
                    :                        "border-primary bg-primary/10"
                    : "border-border hover:border-muted-foreground/50"}
                `}
              >
                <div className="text-xl mb-0.5">{m.emoji}</div>
                <div className="font-medium">{m.label}</div>
                <div className={`text-[10px] mt-0.5 ${
                  m.risk === "high" ? "text-danger" : m.risk === "caution" ? "text-warning" : "text-success"
                }`}>
                  {m.risk === "high" ? "High risk" : m.risk === "caution" ? "Caution" : "Safe"}
                </div>
              </button>
            ))}
          </div>

          <Textarea
            placeholder="Optional note (what's on your mind?)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="text-sm resize-none"
            rows={2}
          />

          <Button
            className="w-full"
            disabled={!selectedMood || checkInMut.isPending}
            onClick={() => checkInMut.mutate(selectedMood)}
          >
            {checkInMut.isPending ? "Recording…" : "Submit Check-In"}
          </Button>

          {result && (
            <Alert variant={result.isHighRisk ? "destructive" : "default"}>
              {result.isHighRisk ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle className="h-4 w-4" />}
              <AlertTitle>{result.emoji} {result.label} — Check-in recorded</AlertTitle>
              <AlertDescription>{result.warning ?? result.message}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {patterns?.hasData && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Your Mood Patterns ({patterns.daysBack}d)</CardTitle>
            <CardDescription className="text-xs">
              How often you check in in each state — a count, not an outcome. Trade results
              per state are below.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <StatChip label="Check-ins" value={patterns.totalCheckIns} />
              <StatChip
                label="High-risk state"
                value={`${patterns.highRiskPct}%`}
                sub="of sessions"
              />
            </div>
            {patterns.insight && (
              <p className="text-xs text-muted-foreground bg-muted/40 rounded p-2">{patterns.insight}</p>
            )}
            <div className="space-y-1">
              {(patterns.moodBreakdown as Array<{ mood: string; emoji: string; label: string; count: number; pct: number; riskLevel: string }>)
                .slice(0, 5).map((m) => (
                <div key={m.mood} className="flex items-center gap-2 text-xs">
                  <span>{m.emoji}</span>
                  <span className="flex-1">{m.label}</span>
                  <div className="w-24 bg-muted rounded-full h-1.5">
                    <div
                      className={`h-1.5 rounded-full ${m.riskLevel === "high" ? "bg-danger" : m.riskLevel === "caution" ? "bg-warning" : "bg-success"}`}
                      style={{ width: `${m.pct}%` }}
                    />
                  </div>
                  <span className="w-8 text-right text-muted-foreground">{m.pct}%</span>
                </div>
              ))}
            </div>

            {/* What each state actually cost — real closed-trade outcomes joined
                to the check-in you made before opening. Refuses visibly when no
                trade can be attributed rather than implying a correlation. */}
            <div className="border-t border-border pt-3 space-y-1.5">
              <p className="text-xs font-medium">Trade results by state</p>
              {patterns.outcomeCorrelation?.available ? (
                <>
                  {(patterns.outcomeCorrelation.byMood as Array<{
                    mood: string; label: string; emoji: string; trades: number; winRatePct: number; netPnl: number;
                  }>).map((m) => (
                    <div key={m.mood} className="flex items-center gap-2 text-xs">
                      <span>{m.emoji}</span>
                      <span className="flex-1">{m.label}</span>
                      <span className="text-muted-foreground">{m.trades} trades · {m.winRatePct}% win</span>
                      <span className={`w-16 text-right font-mono ${m.netPnl < 0 ? "text-danger" : "text-success"}`}>
                        {m.netPnl > 0 ? "+" : ""}{m.netPnl}
                      </span>
                    </div>
                  ))}
                  <p className="text-[10px] text-muted-foreground">
                    {patterns.outcomeCorrelation.attributedTrades} closed trades opened within{" "}
                    {patterns.outcomeCorrelation.windowHours}h of a check-in
                    {patterns.outcomeCorrelation.unattributedTrades > 0 &&
                      ` · ${patterns.outcomeCorrelation.unattributedTrades} closed trades had no check-in near them and are not counted`}
                  </p>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {patterns.outcomeCorrelation?.note ??
                    "Not computed — no closed trade could be tied to a check-in."}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {recent?.checkIns?.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Recent Check-ins</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {recent.checkIns.map((c: { id: number; emoji: string; label: string; riskLevel: string; note?: string; checkedInAt: string }) => (
              <div key={c.id} className="flex items-start gap-2 text-xs">
                <span className="text-base">{c.emoji}</span>
                <div className="flex-1 min-w-0">
                  <span className={`font-medium ${c.riskLevel === "high" ? "text-danger" : c.riskLevel === "caution" ? "text-warning" : ""}`}>
                    {c.label}
                  </span>
                  {c.note && <p className="text-muted-foreground truncate">{c.note}</p>}
                </div>
                <span className="text-muted-foreground shrink-0">
                  {new Date(c.checkedInAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Trade History tab ─────────────────────────────────────────────────────────
function TradeHistoryTab() {
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState<string>("MT5_CSV");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{
    ok: boolean; tradesImported?: number; tradesRejected?: number;
    dataQuality?: { status: string; score: number }; error?: string; warnings?: string[];
  } | null>(null);

  const { data: importsData, refetch } = useQuery({
    queryKey: ["me", "trade-history", "imports"],
    queryFn:  () => apiFetch("/api/me/trade-history/imports"),
  });

  const { data: summaryData } = useQuery({
    queryKey: ["me", "trade-history", "summary"],
    queryFn:  () => apiFetch("/api/me/trade-history/summary"),
  });

  async function handleImport() {
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    try {
      const text = await file.text();
      const r = await apiPost("/api/me/trade-history/import", {
        source,
        rawText: text,
        fileName: file.name,
      });
      setImportResult(r);
      if (r.ok) void refetch();
    } catch (e) {
      setImportResult({ ok: false, error: String(e) });
    } finally {
      setImporting(false);
    }
  }

  const qualityColor = (s: string) =>
    s === "GOOD" ? "text-success" : s === "ACCEPTABLE" ? "text-warning" : "text-danger";

  return (
    <div className="space-y-4">
      {summaryData?.hasTrades && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatChip label="Total Trades" value={summaryData.count} />
          <StatChip label="Win Rate"     value={`${summaryData.winRate}%`} />
          <StatChip label="Total P/L"    value={`$${summaryData.totalNetPnl}`} />
          <StatChip label="Sources"      value={(summaryData.sources as string[])?.length} sub="connected" />
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Upload className="h-4 w-4" /> Import MT5 History
          </CardTitle>
          <CardDescription>
            Export your MT5 history as CSV or HTML (History tab → right-click → Save As).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Select value={source} onValueChange={setSource}>
            <SelectTrigger>
              <SelectValue placeholder="Select format" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="MT5_CSV">MT5 CSV Export</SelectItem>
              <SelectItem value="MT5_HTML">MT5 HTML Report</SelectItem>
              <SelectItem value="MT5_EXCEL">MT5 Excel Export</SelectItem>
            </SelectContent>
          </Select>

          <div className="border-2 border-dashed rounded-lg p-4 text-center">
            <input
              type="file"
              accept=".csv,.html,.htm,.xlsx,.xls"
              className="hidden"
              id="trade-history-file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <label htmlFor="trade-history-file" className="cursor-pointer">
              {file ? (
                <div className="text-sm">
                  <p className="font-medium">{file.name}</p>
                  <p className="text-muted-foreground text-xs mt-0.5">{(file.size / 1024).toFixed(1)} KB</p>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">
                  <Upload className="h-8 w-8 mx-auto mb-2 opacity-40" />
                  <p>Click to select your MT5 export file</p>
                  <p className="text-xs mt-0.5">CSV, HTML, or Excel</p>
                </div>
              )}
            </label>
          </div>

          <Button
            className="w-full"
            disabled={!file || importing}
            onClick={handleImport}
          >
            {importing ? "Importing…" : "Import Trade History"}
          </Button>

          {importResult && (
            <Alert variant={importResult.ok ? "default" : "destructive"}>
              {importResult.ok ? <CheckCircle className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
              <AlertTitle>{importResult.ok ? "Import complete" : "Import failed"}</AlertTitle>
              <AlertDescription className="space-y-1">
                {importResult.ok ? (
                  <>
                    <p>{importResult.tradesImported} trades imported, {importResult.tradesRejected} skipped.</p>
                    {importResult.dataQuality && (
                      <p>
                        Data quality:{" "}
                        <span className={qualityColor(importResult.dataQuality.status)}>
                          {importResult.dataQuality.status} ({importResult.dataQuality.score}/100)
                        </span>
                      </p>
                    )}
                    {importResult.warnings?.map((w, i) => (
                      <p key={i} className="text-xs text-warning">⚠ {w}</p>
                    ))}
                  </>
                ) : (
                  <p>{importResult.error ?? "Unknown error"}</p>
                )}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {importsData?.imports?.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Import History</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {(importsData.imports as Array<{
              importId: string; source: string; status: string;
              tradesImported: number; createdAt: string;
              dataQuality: { status: string; score: number };
            }>).map((imp) => (
              <div key={imp.importId} className="flex items-center justify-between text-xs py-1.5 border-b last:border-0">
                <div>
                  <span className="font-medium">{imp.source.replace("MT5_", "MT5 ")}</span>
                  <span className="text-muted-foreground ml-2">{imp.tradesImported} trades</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={qualityColor(imp.dataQuality?.status ?? "")}>
                    {imp.dataQuality?.score ?? "—"}/100
                  </span>
                  <Badge variant={imp.status === "COMPLETE" ? "default" : "secondary"} className="text-xs">
                    {imp.status}
                  </Badge>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function TradingIntelligencePage() {
  const [activeTab, setActiveTab] = useState<Tab>("dna");

  return (
    <PageShell
      title="Trading Intelligence"
      description="Your personal trading profile, mood check-in, and history analysis."
      icon={<Brain className="h-6 w-6" />}
      readOnly
    >
      {/* Mobile dropdown */}
      <div className="sm:hidden">
        <Select value={activeTab} onValueChange={(v) => setActiveTab(v as Tab)}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TABS.map((t) => (
              <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Desktop tabs */}
      <div className="hidden sm:flex gap-1 border-b pb-0">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              className={`
                flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition
                ${active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}
              `}
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="pt-2">
        {activeTab === "dna"     && <DnaTab />}
        {activeTab === "mood"    && <MoodTab />}
        {activeTab === "history" && <TradeHistoryTab />}
      </div>
    </PageShell>
  );
}
