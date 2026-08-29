import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ListChecks, RefreshCw } from "lucide-react";
import { humanizeReason } from "@/lib/friendlyLabels";

type Intent = {
  id: number; intentId: string; source: string; symbol: string; direction: string;
  lotSize: number; stopLoss: number | null; takeProfit: number | null;
  status: string; rejectionReason: string | null;
  confidenceScore: number | null; riskScore: number | null;
  mt5ConnectedAtSubmit: boolean; brokerExecuted: boolean;
  createdAt: string; auditEventId: number | null;
};

function statusColor(s: string) {
  if (s === "PENDING_MT5_CONNECTION") return "bg-warning/15 text-warning border-warning/30";
  if (s === "READY_FOR_BROKER_WHEN_CONNECTED") return "bg-primary/15 text-primary border-primary/30";
  if (s === "REJECTED_BY_RISK") return "bg-danger/15 text-danger border-danger/30";
  if (s === "EXECUTED_LATER") return "bg-success/15 text-success border-success/30";
  return "bg-muted text-foreground";
}

async function jget(url: string) {
  const r = await fetch(url, { credentials: "include" });
  return r.json();
}

export default function LiveIntentQueuePage() {
  const [intents, setIntents] = useState<Intent[]>([]);
  const [counts, setCounts] = useState<any>({});
  const [loading, setLoading] = useState(true);
  const [sourceFilter, setSourceFilter] = useState<string>("ALL");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");

  async function load() {
    setLoading(true);
    const r = await jget("/api/live-intent/queue");
    setIntents(r.intents ?? []);
    setCounts(r.counts ?? {});
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);

  const filtered = intents.filter(i =>
    (sourceFilter === "ALL" || i.source === sourceFilter) &&
    (statusFilter === "ALL" || i.status === statusFilter)
  );

  return (
    <div className="mx-auto w-full max-w-[1280px] pb-32 md:pb-6 space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><ListChecks className="w-6 h-6" /> Live Intent Queue</h1>
          <p className="text-sm text-muted-foreground">Live trade intents awaiting execution or review.</p>
        </div>
        <Button size="sm" variant="outline" onClick={load} disabled={loading}><RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh</Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        {[
          { k: "total", l: "Total" },
          { k: "pendingMt5", l: "Pending MT5" },
          { k: "ready", l: "Ready" },
          { k: "rejected", l: "Rejected" },
          { k: "executedLater", l: "Executed later" },
        ].map(s => (
          <Card key={s.k}><CardContent className="pt-3"><div className="text-[11px] text-muted-foreground">{s.l}</div><div className="text-2xl font-mono">{counts[s.k] ?? 0}</div></CardContent></Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Intents</CardTitle>
          <CardDescription>Newest first. {filtered.length} of {intents.length} shown.</CardDescription>
          <div className="flex flex-wrap gap-2 pt-2">
            <select className="text-xs bg-background border border-border rounded px-2 py-1" value={sourceFilter} onChange={e => setSourceFilter(e.target.value)} data-testid="source-filter">
              <option value="ALL">all sources</option>
              <option value="MANUAL">Manual</option>
              <option value="AI_ASSIST">AI Assist</option>
              <option value="AI_AUTO">AI Auto</option>
            </select>
            <select className="text-xs bg-background border border-border rounded px-2 py-1" value={statusFilter} onChange={e => setStatusFilter(e.target.value)} data-testid="status-filter">
              <option value="ALL">all statuses</option>
              <option value="PENDING_MT5_CONNECTION">Pending MT5</option>
              <option value="REJECTED_BY_RISK">Rejected by Risk</option>
              <option value="READY_FOR_BROKER_WHEN_CONNECTED">Ready when connected</option>
              <option value="EXECUTED_LATER">Executed later</option>
            </select>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto" data-testid="intent-table">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground border-b border-border">
                <th className="text-left p-2">When</th>
                <th className="text-left p-2">Source</th>
                <th className="text-left p-2">Symbol</th>
                <th className="text-left p-2">Side</th>
                <th className="text-right p-2">Lot</th>
                <th className="text-right p-2">SL/TP</th>
                <th className="text-right p-2">Conf/Risk</th>
                <th className="text-left p-2">MT5</th>
                <th className="text-left p-2">Status</th>
                <th className="text-left p-2">Reason</th>
                <th className="text-left p-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={11} className="text-center p-6 text-muted-foreground">No intents match filters. Submit one from Live Manual / Live AI Assist / Live AI Auto.</td></tr>
              )}
              {filtered.map(i => (
                <tr key={i.id} className="border-b border-border/30">
                  <td className="p-2 font-mono text-[10px]">{new Date(i.createdAt).toLocaleString()}</td>
                  <td className="p-2"><Badge variant="outline" className="text-[10px]">{i.source}</Badge></td>
                  <td className="p-2 font-mono">{i.symbol}</td>
                  <td className="p-2"><Badge className="text-[10px]">{i.direction}</Badge></td>
                  <td className="p-2 text-right font-mono">{i.lotSize}</td>
                  <td className="p-2 text-right font-mono text-[10px]">{i.stopLoss ?? "—"} / {i.takeProfit ?? "—"}</td>
                  <td className="p-2 text-right font-mono text-[10px]">{i.confidenceScore ?? "—"} / {i.riskScore ?? "—"}</td>
                  <td className="p-2 text-[10px]">{i.mt5ConnectedAtSubmit ? "yes" : "no"}</td>
                  <td className="p-2"><Badge className={`text-[10px] border ${statusColor(i.status)}`}>{i.status}</Badge></td>
                  <td className="p-2 text-[10px] text-muted-foreground max-w-[260px] truncate" title={i.rejectionReason ? humanizeReason(i.rejectionReason) : ""}>{i.rejectionReason ? humanizeReason(i.rejectionReason) : "—"}</td>
                  <td className="p-2">
                    <Button size="sm" variant="outline" disabled className="text-[10px] h-6" title="Connect MT5 bridge to enable broker execution.">Convert to Broker Order Later</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
