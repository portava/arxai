import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getGetJournalEntriesQueryKey } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

function fetchJournal() {
  return fetch("/api/journal").then((r) => r.json());
}

const EMOTION_TAGS = ["Calm", "FOMO", "Fear", "Greed", "Revenge", "Disciplined", "Uncertain"] as const;
const MISTAKE_TAGS = ["None", "Early Entry", "Late Entry", "Bad SL", "Overtraded", "Revenge Trade", "Ignored Signal", "Bad Risk:Reward"] as const;
const STRATEGIES = ["Trend Continuation", "Break of Structure", "Liquidity Sweep Reversal", "Volatility Expansion", "Pullback Continuation", "Mean Reversion", "Session Breakout", "Other"];

const EMOTION_COLORS: Record<string, string> = {
  Calm: "bg-success/20 text-success", FOMO: "bg-warning/20 text-warning", Fear: "bg-danger/20 text-danger",
  Greed: "bg-warning/20 text-warning", Revenge: "bg-danger/25 text-danger", Disciplined: "bg-primary/20 text-primary", Uncertain: "bg-secondary text-txt-secondary",
};

function EmotionChip({ tag }: { tag: string | null }) {
  if (!tag) return null;
  return <span className={cn("px-2 py-0.5 rounded-full text-xs font-semibold", EMOTION_COLORS[tag] ?? "bg-secondary text-txt-secondary")}>{tag}</span>;
}

interface JournalForm {
  symbol: string; direction: "BUY" | "SELL" | "WAIT"; strategy: string; entryIdea: string;
  actualOutcome: string; pnl: string; emotionTag: string; mistakeTag: string; lessonLearned: string;
}

const DEFAULT_FORM: JournalForm = {
  symbol: "", direction: "BUY", strategy: "Trend Continuation", entryIdea: "",
  actualOutcome: "", pnl: "", emotionTag: "", mistakeTag: "None", lessonLearned: "",
};

export default function JournalPage() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<JournalForm>(DEFAULT_FORM);
  const [filterEmotion, setFilterEmotion] = useState<string>("All");

  const { data: entries = [], isLoading } = useQuery({
    queryKey: getGetJournalEntriesQueryKey(),
    queryFn: fetchJournal,
  });

  const createMutation = useMutation({
    mutationFn: (body: object) => fetch("/api/journal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: getGetJournalEntriesQueryKey() }); setShowForm(false); setForm(DEFAULT_FORM); },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => fetch(`/api/journal/${id}`, { method: "DELETE" }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: getGetJournalEntriesQueryKey() }),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    createMutation.mutate({ ...form, pnl: form.pnl ? parseFloat(form.pnl) : undefined, emotionTag: form.emotionTag || undefined, mistakeTag: form.mistakeTag === "None" ? undefined : form.mistakeTag || undefined });
  }

  const filtered = filterEmotion === "All" ? entries : entries.filter((e: any) => e.emotionTag === filterEmotion);

  // Stats
  const totalPnl = entries.reduce((s: number, e: any) => s + (e.pnl ?? 0), 0);
  const wins = entries.filter((e: any) => (e.pnl ?? 0) > 0).length;
  const winRate = entries.length > 0 ? Math.round((wins / entries.length) * 100) : 0;
  const emotions: Record<string, number> = {};
  entries.forEach((e: any) => { if (e.emotionTag) emotions[e.emotionTag] = (emotions[e.emotionTag] ?? 0) + 1; });
  const topEmotion = Object.entries(emotions).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—";

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-5 p-4 md:p-6 pb-32 md:pb-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold leading-tight">Trade Journal</h1>
          <p className="text-sm text-txt-secondary">Log trades with emotion tags and mistake tracking to improve your psychology.</p>
        </div>
        <Button onClick={() => setShowForm(!showForm)} className="bg-primary text-white hover:bg-primary/90">
          {showForm ? "Cancel" : "+ New Entry"}
        </Button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Total Entries", value: entries.length, cls: "text-foreground" },
          { label: "Win Rate", value: `${winRate}%`, cls: winRate >= 50 ? "text-success" : "text-danger" },
          { label: "Total P&L", value: `$${totalPnl.toFixed(2)}`, cls: totalPnl >= 0 ? "text-success" : "text-danger" },
          { label: "Top Emotion", value: topEmotion, cls: topEmotion === "Disciplined" ? "text-success" : topEmotion === "FOMO" || topEmotion === "Revenge" ? "text-danger" : "text-warning" },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl border border-border bg-card p-4">
            <div className="mb-1 text-xs text-txt-muted">{s.label}</div>
            <div className={cn("text-xl font-bold", s.cls)}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* New entry form */}
      {showForm && (
        <div className="rounded-2xl border border-border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold text-foreground">New Journal Entry</h2>
          <div>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="text-xs text-txt-secondary mb-1 block">Symbol *</label>
                  <Input value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value.toUpperCase() })} placeholder="e.g. EURUSD" className="border-border bg-background/40 text-foreground" required />
                </div>
                <div>
                  <label className="text-xs text-txt-secondary mb-1 block">Direction *</label>
                  <Select value={form.direction} onValueChange={(v) => setForm({ ...form, direction: v as any })}>
                    <SelectTrigger className="border-border bg-background/40 text-foreground"><SelectValue /></SelectTrigger>
                    <SelectContent>{["BUY", "SELL", "WAIT"].map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-xs text-txt-secondary mb-1 block">Strategy *</label>
                  <Select value={form.strategy} onValueChange={(v) => setForm({ ...form, strategy: v })}>
                    <SelectTrigger className="border-border bg-background/40 text-foreground"><SelectValue /></SelectTrigger>
                    <SelectContent>{STRATEGIES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <label className="text-xs text-txt-secondary mb-1 block">Entry Idea / Thesis *</label>
                <Textarea value={form.entryIdea} onChange={(e) => setForm({ ...form, entryIdea: e.target.value })} placeholder="Why did you take this trade? What was the setup?" className="border-border bg-background/40 text-foreground min-h-[80px]" required />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="text-xs text-txt-secondary mb-1 block">Outcome</label>
                  <Input value={form.actualOutcome} onChange={(e) => setForm({ ...form, actualOutcome: e.target.value })} placeholder="Win / Loss / Breakeven" className="border-border bg-background/40 text-foreground" />
                </div>
                <div>
                  <label className="text-xs text-txt-secondary mb-1 block">P&L ($)</label>
                  <Input type="number" step="0.01" value={form.pnl} onChange={(e) => setForm({ ...form, pnl: e.target.value })} placeholder="e.g. 45.50 or -22.00" className="border-border bg-background/40 text-foreground" />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-txt-secondary mb-1 block">Emotion During Trade</label>
                  <Select value={form.emotionTag} onValueChange={(v) => setForm({ ...form, emotionTag: v })}>
                    <SelectTrigger className="border-border bg-background/40 text-foreground"><SelectValue placeholder="Select emotion..." /></SelectTrigger>
                    <SelectContent>{EMOTION_TAGS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-xs text-txt-secondary mb-1 block">Mistake Made</label>
                  <Select value={form.mistakeTag} onValueChange={(v) => setForm({ ...form, mistakeTag: v })}>
                    <SelectTrigger className="border-border bg-background/40 text-foreground"><SelectValue /></SelectTrigger>
                    <SelectContent>{MISTAKE_TAGS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <label className="text-xs text-txt-secondary mb-1 block">Lesson Learned</label>
                <Textarea value={form.lessonLearned} onChange={(e) => setForm({ ...form, lessonLearned: e.target.value })} placeholder="What would you do differently next time?" className="border-border bg-background/40 text-foreground" />
              </div>

              <Button type="submit" disabled={createMutation.isPending} className="w-full bg-primary text-white hover:bg-primary/90">
                {createMutation.isPending ? "Saving..." : "Save Journal Entry"}
              </Button>
            </form>
          </div>
        </div>
      )}

      {/* Filter */}
      <div className="flex gap-2 flex-wrap">
        <span className="text-txt-muted text-xs mt-1">Filter by emotion:</span>
        {["All", ...EMOTION_TAGS].map((e) => (
          <button key={e} onClick={() => setFilterEmotion(e)} className={cn("px-3 py-1 rounded-full text-xs font-medium transition-colors", filterEmotion === e ? "bg-primary text-white" : "bg-secondary text-txt-secondary hover:bg-secondary")}>
            {e}
          </button>
        ))}
      </div>

      {/* Entries */}
      {isLoading && <div className="text-txt-secondary text-sm py-8 text-center">Loading journal...</div>}

      {!isLoading && filtered.length === 0 && (
        <div className="text-center py-16 text-txt-muted">
          <div className="text-4xl mb-3">📓</div>
          <div className="font-semibold">No journal entries yet</div>
          <div className="text-sm mt-1">Start logging your trades to track your psychology and improve performance</div>
        </div>
      )}

      <div className="space-y-3">
        {filtered.map((entry: any) => (
          <div key={entry.id} className="rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/40">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-foreground text-sm">{entry.symbol}</span>
                  <Badge className={cn("text-xs font-bold", entry.direction === "BUY" ? "bg-success/80" : entry.direction === "SELL" ? "bg-danger/80" : "bg-secondary")}>
                    {entry.direction}
                  </Badge>
                  <Badge variant="secondary" className="text-xs">{entry.strategy}</Badge>
                  {entry.emotionTag && <EmotionChip tag={entry.emotionTag} />}
                  {entry.mistakeTag && entry.mistakeTag !== "None" && (
                    <Badge variant="outline" className="text-xs border-warning/50 text-warning">⚠ {entry.mistakeTag}</Badge>
                  )}
                  {entry.pnl !== null && entry.pnl !== undefined && (
                    <span className={cn("text-sm font-bold", entry.pnl >= 0 ? "text-success" : "text-danger")}>
                      {entry.pnl >= 0 ? "+" : ""}${entry.pnl?.toFixed(2)}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-txt-muted text-xs whitespace-nowrap">{new Date(entry.createdAt).toLocaleDateString()}</span>
                  <button onClick={() => deleteMutation.mutate(entry.id)} className="text-txt-muted hover:text-danger transition-colors text-xs">✕</button>
                </div>
              </div>

              <div className="mt-2 space-y-1">
                <div className="text-txt-secondary text-xs">{entry.entryIdea}</div>
                {entry.actualOutcome && <div className="text-txt-secondary text-xs"><span className="text-txt-muted">Outcome:</span> {entry.actualOutcome}</div>}
                {entry.lessonLearned && (
                  <div className="bg-primary/10 border border-primary/30 rounded p-2 mt-2">
                    <div className="text-xs text-primary font-semibold mb-0.5">Lesson Learned</div>
                    <div className="text-txt-secondary text-xs">{entry.lessonLearned}</div>
                  </div>
                )}
              </div>
          </div>
        ))}
      </div>
    </div>
  );
}
