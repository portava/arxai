import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Play, StepForward, Square, Rewind } from "lucide-react";

type Decision = {
  candleIndex: number; aiAction: string;
  entry?: number; stopLoss?: number; takeProfit?: number;
  confidenceScore: number; riskScore: number; reason: string;
  humanAction?: string;
};

const ACTION_COLORS: Record<string, string> = {
  BUY: "bg-success/10 text-success border-success/40",
  SELL: "bg-danger/10 text-danger border-danger/40",
  WAIT: "bg-warning/10 text-warning border-warning/40",
  REJECT: "bg-muted text-txt-secondary border-border/40",
};

export default function MarketReplay() {
  const [symbol, setSymbol] = useState("EURUSD");
  const [timeframe, setTimeframe] = useState("M15");
  const [replayId, setReplayId] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [steps, setSteps] = useState(0);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [finished, setFinished] = useState(false);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const headers = { "content-type": "application/json", "x-security-role": "ADMIN" };

  async function start() {
    setBusy(true); setErr(""); setDecisions([]); setFinished(false); setRemaining(null);
    try {
      const r = await fetch("/api/market-replay/start", {
        method: "POST", headers, body: JSON.stringify({ symbol, timeframe }),
      }).then((x) => x.json());
      if (r.error) {
        // Honest refusal from the engine — includes what it CAN replay.
        const available = Array.isArray(r.availableSymbols) ? ` Available: ${r.availableSymbols.join(", ")}.` : "";
        throw new Error(`${r.error}${available}`);
      }
      setReplayId(r.replayId);
      setTotal(r.candles?.length ?? 0);
      setSteps(r.steps ?? 0);
      setRemaining(r.steps ?? null);
    } catch (e) { setErr(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  async function step(humanAction?: string) {
    if (!replayId) return;
    setBusy(true);
    try {
      const r = await fetch("/api/market-replay/step", {
        method: "POST", headers, body: JSON.stringify({ replayId, humanAction }),
      }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      if (r.finished) { setFinished(true); setRemaining(0); return; }
      if (r.decision) setDecisions((d) => [r.decision, ...d]);
      if (typeof r.stepsRemaining === "number") setRemaining(r.stepsRemaining);
    } catch (e) { setErr(String((e as Error).message ?? e)); } finally { setBusy(false); }
  }

  async function stop() {
    if (!replayId) return;
    setBusy(true);
    try {
      await fetch("/api/market-replay/stop", { method: "POST", headers, body: JSON.stringify({ replayId }) });
      setReplayId(null);
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Play className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Market Replay</h1>
          <p className="text-sm text-muted-foreground">
            Step through simulated candles. Compare your decision vs the AI brain. Simulator
            candles only — these prices are generated, not market history.
          </p>
        </div>
        <Badge variant="outline" className="ml-auto">SIMULATOR</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Setup</CardTitle>
          <CardDescription>Pick a symbol and start a replay session.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <div><Label>Symbol</Label><Input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} disabled={!!replayId} /></div>
          <div><Label>Timeframe</Label><Input value={timeframe} onChange={(e) => setTimeframe(e.target.value)} disabled={!!replayId} /></div>
          <div className="flex items-end gap-2">
            {!replayId
              ? <Button onClick={start} disabled={busy}><Play className="h-4 w-4 mr-1" /> Start</Button>
              : <>
                  <Button onClick={() => step()} disabled={busy || finished}><StepForward className="h-4 w-4 mr-1" /> Step</Button>
                  <Button variant="outline" onClick={stop} disabled={busy}><Square className="h-4 w-4 mr-1" /> Stop</Button>
                </>}
          </div>
          {/* There is no strategy picker: the replay runs the AI brain's own
              analysis, which has no strategy selector. The old field was
              collected, stored on the session and never read. */}
          <p className="text-xs text-muted-foreground md:col-span-3">
            Each Step analyses the session&apos;s candles up to that bar — the first 20 bars are
            warm-up history. There is no strategy selector: replay runs the AI brain&apos;s own
            analysis. Only symbols the simulator generates can be replayed.
          </p>
          {err && <p className="text-sm text-danger md:col-span-3">{err}</p>}
          {replayId && <p className="text-xs text-muted-foreground md:col-span-3">
            Replay <span className="font-mono">{replayId}</span> · step {decisions.length} of {steps}
            {" "}({total} candles loaded{remaining != null ? `, ${remaining} left` : ""})
            {finished ? " · replay finished" : ""}
          </p>}
        </CardContent>
      </Card>

      {replayId && (
        <Card>
          <CardHeader>
            <CardTitle>Compare your call vs AI</CardTitle>
            <CardDescription>Click your call before stepping the next candle.</CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => step("BUY")} disabled={busy}>I would BUY</Button>
            <Button size="sm" variant="outline" onClick={() => step("SELL")} disabled={busy}>I would SELL</Button>
            <Button size="sm" variant="outline" onClick={() => step("WAIT")} disabled={busy}>I would WAIT</Button>
            <Button size="sm" variant="ghost" onClick={() => step()} disabled={busy}><Rewind className="h-4 w-4 mr-1" /> Step (no call)</Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Decision log</CardTitle></CardHeader>
        <CardContent>
          {decisions.length === 0
            ? <p className="text-sm text-muted-foreground">No decisions yet — start a replay and step.</p>
            : <ul className="space-y-2 text-sm">
                {decisions.map((d, i) => (
                  <li key={i} className="border rounded p-2 flex flex-wrap gap-2 items-center">
                    <span className="text-xs text-muted-foreground font-mono">#{d.candleIndex}</span>
                    <Badge className={ACTION_COLORS[d.aiAction] ?? ""}>AI: {d.aiAction}</Badge>
                    {d.humanAction && <Badge variant="outline">You: {d.humanAction}</Badge>}
                    <span className="text-xs">conf {d.confidenceScore} · risk {d.riskScore}</span>
                    <span className="text-xs text-muted-foreground flex-1">{d.reason}</span>
                  </li>
                ))}
              </ul>}
        </CardContent>
      </Card>
    </div>
  );
}
