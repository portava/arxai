import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { GraduationCap, Star, AlertTriangle, ThumbsUp, ThumbsDown } from "lucide-react";

type Grade = {
  tradeGrade: string; overallScore: number;
  strengths: string[]; weaknesses: string[];
  mistakesDetected: string[]; improvementSuggestion: string;
  shouldHaveTakenTrade: boolean; dataSource: string;
};
type Sniper = {
  score: number; label: string;
  factors: Record<string, number>;
};

const GRADE_COLORS: Record<string, string> = {
  "A+": "bg-emerald-500/10 text-emerald-400 border-emerald-500/40",
  "A":  "bg-emerald-500/10 text-emerald-400 border-emerald-500/40",
  "B":  "bg-blue-500/10 text-blue-400 border-blue-500/40",
  "C":  "bg-amber-500/10 text-amber-400 border-amber-500/40",
  "D":  "bg-orange-500/10 text-orange-400 border-orange-500/40",
  "F":  "bg-rose-500/10 text-rose-400 border-rose-500/40",
};

export default function TradeGrader() {
  const [symbol, setSymbol] = useState("EURUSD");
  const [direction, setDirection] = useState<"BUY" | "SELL">("BUY");
  const [entry, setEntry] = useState("1.0850");
  const [sl, setSl] = useState("1.0820");
  const [tp, setTp] = useState("1.0910");
  const [lot, setLot] = useState("0.10");
  const [conf, setConf] = useState("70");
  const [grade, setGrade] = useState<Grade | null>(null);
  const [sniper, setSniper] = useState<Sniper | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function run() {
    setBusy(true); setErr(""); setGrade(null); setSniper(null);
    try {
      const body = {
        symbol, direction,
        entryPrice: Number(entry),
        stopLoss: Number(sl), takeProfit: Number(tp),
        lotSize: Number(lot), confidenceScore: Number(conf),
      };
      const headers = { "content-type": "application/json", "x-security-role": "ADMIN" };
      const [g, s] = await Promise.all([
        fetch("/api/ai/grade-trade", { method: "POST", headers, body: JSON.stringify(body) }).then((r) => r.json()),
        fetch("/api/ai/entry-sniper-score", {
          method: "POST", headers,
          body: JSON.stringify({ symbol, direction, entryPrice: Number(entry), stopLoss: Number(sl), takeProfit: Number(tp) }),
        }).then((r) => r.json()),
      ]);
      setGrade(g); setSniper(s);
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <GraduationCap className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Trade Grader</h1>
          <p className="text-sm text-muted-foreground">
            Score a trade idea against the AI brain. Simulator only — never sends to broker.
          </p>
        </div>
        <Badge variant="outline" className="ml-auto">SIMULATOR</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Trade idea</CardTitle>
          <CardDescription>Enter the parameters of a trade you are about to take.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <div><Label>Symbol</Label><Input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} /></div>
          <div><Label>Direction</Label>
            <div className="flex gap-2 mt-1">
              <Button size="sm" variant={direction === "BUY" ? "default" : "outline"} onClick={() => setDirection("BUY")}>BUY</Button>
              <Button size="sm" variant={direction === "SELL" ? "default" : "outline"} onClick={() => setDirection("SELL")}>SELL</Button>
            </div>
          </div>
          <div><Label>Entry</Label><Input value={entry} onChange={(e) => setEntry(e.target.value)} /></div>
          <div><Label>Stop Loss</Label><Input value={sl} onChange={(e) => setSl(e.target.value)} /></div>
          <div><Label>Take Profit</Label><Input value={tp} onChange={(e) => setTp(e.target.value)} /></div>
          <div><Label>Lot Size</Label><Input value={lot} onChange={(e) => setLot(e.target.value)} /></div>
          <div><Label>Your confidence (0–100)</Label><Input value={conf} onChange={(e) => setConf(e.target.value)} /></div>
          <div className="md:col-span-3">
            <Button disabled={busy} onClick={run}>{busy ? "Grading…" : "Grade this trade"}</Button>
          </div>
          {err && <p className="text-sm text-rose-400 md:col-span-3">{err}</p>}
        </CardContent>
      </Card>

      {grade && sniper && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card className={GRADE_COLORS[grade.tradeGrade] ?? ""}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Star className="h-5 w-5" /> Grade</CardTitle>
              <CardDescription>Score {grade.overallScore}/100 · should{grade.shouldHaveTakenTrade ? "" : " NOT"} take</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-6xl font-black text-center mb-3">{grade.tradeGrade}</div>
              <p className="text-sm">{grade.improvementSuggestion}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Entry Sniper Score</CardTitle>
              <CardDescription>{sniper.label}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-4xl font-bold mb-2">{sniper.score}<span className="text-base text-muted-foreground">/100</span></div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {Object.entries(sniper.factors).map(([k, v]) => (
                  <div key={k} className="flex justify-between border rounded px-2 py-1">
                    <span className="text-muted-foreground">{k}</span><span className="font-mono">{v}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card className="md:col-span-2">
            <CardHeader><CardTitle>Diagnostics</CardTitle></CardHeader>
            <CardContent className="grid md:grid-cols-3 gap-4 text-sm">
              <div>
                <h4 className="font-semibold mb-2 flex items-center gap-1"><ThumbsUp className="h-4 w-4 text-emerald-400" /> Strengths</h4>
                <ul className="space-y-1">{grade.strengths.length === 0 ? <li className="text-muted-foreground">none</li> : grade.strengths.map((s) => <li key={s}>· {s}</li>)}</ul>
              </div>
              <div>
                <h4 className="font-semibold mb-2 flex items-center gap-1"><ThumbsDown className="h-4 w-4 text-rose-400" /> Weaknesses</h4>
                <ul className="space-y-1">{grade.weaknesses.length === 0 ? <li className="text-muted-foreground">none</li> : grade.weaknesses.map((s) => <li key={s}>· {s}</li>)}</ul>
              </div>
              <div>
                <h4 className="font-semibold mb-2 flex items-center gap-1"><AlertTriangle className="h-4 w-4 text-amber-400" /> Mistakes detected</h4>
                <ul className="space-y-1">{grade.mistakesDetected.map((s) => <li key={s}>· {s}</li>)}</ul>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
