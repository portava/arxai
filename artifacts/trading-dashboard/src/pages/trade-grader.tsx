import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { GraduationCap, Star, AlertTriangle, ThumbsUp, ThumbsDown, Ban } from "lucide-react";

// The grader answers with either a verdict OR a refusal. `available: false`
// means nothing was scored — either the simulator does not know the symbol
// (unavailableMessage) or the read was withheld by the server's role gate
// (`withheld: true`). Both must render as a refusal, never as a grade.
type Grade = {
  tradeGrade: string | null; overallScore: number | null;
  strengths: string[]; weaknesses: string[];
  mistakesDetected: string[]; improvementSuggestion: string;
  shouldHaveTakenTrade: boolean | null; dataSource: string;
  available: boolean;
  unavailableMessage: string | null;
  withheld?: boolean;
};
type Sniper = {
  score: number | null; label: string | null;
  factors: Record<string, number>;
  available: boolean;
  unavailableMessage: string | null;
  withheld?: boolean;
};

const GRADE_COLORS: Record<string, string> = {
  "A+": "bg-success/10 text-success border-success/40",
  "A":  "bg-success/10 text-success border-success/40",
  "B":  "bg-primary/10 text-primary border-primary/40",
  "C":  "bg-warning/10 text-warning border-warning/40",
  "D":  "bg-warning/10 text-warning border-warning/40",
  "F":  "bg-danger/10 text-danger border-danger/40",
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
      // SECURITY/HONESTY: no client-supplied role header. The server resolves
      // authority from the signed session cookie and IGNORES `x-security-role`
      // in production (lib/security/middleware.ts). Sending ADMIN from the
      // browser only produced a false "grade" in dev while a real user in
      // production silently received the withheld payload and saw it rendered
      // as a verdict. The withheld state is now rendered as a refusal instead.
      const headers = { "content-type": "application/json" };
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

  // A verdict is only shown when BOTH reads actually produced one. Anything
  // else — unknown symbol, withheld by role, malformed payload — is a refusal.
  const graded =
    grade?.available === true &&
    sniper?.available === true &&
    grade.tradeGrade != null &&
    sniper.score != null;

  const refusalReason =
    grade?.unavailableMessage ??
    sniper?.unavailableMessage ??
    "The grader returned no scored result for this trade idea.";

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <GraduationCap className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Trade Grader</h1>
          <p className="text-sm text-muted-foreground">
            Scores a trade idea against <strong>simulated</strong> price action, not the live market.
            The simulator prices eight symbols from fixed 2024 base prices; it is a rules checker for
            your entry, stop and target — not a read on what the market is doing now. Never sends to broker.
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
          {err && <p className="text-sm text-danger md:col-span-3">{err}</p>}
        </CardContent>
      </Card>

      {grade && sniper && !graded && (
        <Card className="border-warning/40 bg-warning/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Ban className="h-5 w-5 text-warning" /> Not graded
            </CardTitle>
            <CardDescription>
              No grade was produced. Nothing below was scored — this is a refusal, not a verdict.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>{refusalReason}</p>
            {(grade.withheld || sniper.withheld) && (
              <p className="text-muted-foreground text-xs">
                Your account cannot see simulator-derived scores. This page does not grade trades
                for you yet; it will once a verified live feed is wired to your account.
              </p>
            )}
            {!grade.withheld && !sniper.withheld && (
              <p className="text-muted-foreground text-xs">
                Symbols this simulator can price: EURUSD, GBPUSD, USDJPY, XAUUSD, BTCUSDT, ETHUSDT,
                AAPL, TSLA.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {grade && sniper && graded && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card className={(grade.tradeGrade && GRADE_COLORS[grade.tradeGrade]) || ""}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Star className="h-5 w-5" /> Grade</CardTitle>
              <CardDescription>
                Score {grade.overallScore}/100
                {grade.shouldHaveTakenTrade != null && ` · should${grade.shouldHaveTakenTrade ? "" : " NOT"} take`}
              </CardDescription>
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
                <h4 className="font-semibold mb-2 flex items-center gap-1"><ThumbsUp className="h-4 w-4 text-success" /> Strengths</h4>
                <ul className="space-y-1">{grade.strengths.length === 0 ? <li className="text-muted-foreground">none</li> : grade.strengths.map((s) => <li key={s}>· {s}</li>)}</ul>
              </div>
              <div>
                <h4 className="font-semibold mb-2 flex items-center gap-1"><ThumbsDown className="h-4 w-4 text-danger" /> Weaknesses</h4>
                <ul className="space-y-1">{grade.weaknesses.length === 0 ? <li className="text-muted-foreground">none</li> : grade.weaknesses.map((s) => <li key={s}>· {s}</li>)}</ul>
              </div>
              <div>
                <h4 className="font-semibold mb-2 flex items-center gap-1"><AlertTriangle className="h-4 w-4 text-warning" /> Mistakes detected</h4>
                <ul className="space-y-1">{grade.mistakesDetected.map((s) => <li key={s}>· {s}</li>)}</ul>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
