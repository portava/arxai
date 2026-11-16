// Admin — Live Gates Diagnostic Panel
//
// Renders GET /api/admin/live-gates/diagnostic as a single
// gate-by-gate table. Plain-English label + status badge + detail +
// raw code (admin-only). Never displays tokens, password hashes, or
// full broker account numbers — the endpoint already masks them.
import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Activity, RefreshCw, CheckCircle2, AlertCircle, Info as InfoIcon } from "lucide-react";

type Gate = {
  id: string;
  label: string;
  status: "pass" | "fail" | "info";
  detail: string;
  rawCode?: string;
};

type Resp = {
  ok: boolean;
  platformBridgeMode: string;
  platformHeadline: string;
  nextPlatformStep: string;
  gates: Gate[];
};

const STATUS_BADGE: Record<Gate["status"], string> = {
  pass: "bg-emerald-500/20 text-emerald-300",
  fail: "bg-rose-500/20 text-rose-300",
  info: "bg-slate-500/20 text-slate-300",
};

export function LiveGatesDiagnosticPanel() {
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/admin/live-gates/diagnostic", { credentials: "include" });
      const j = await r.json();
      if (j.ok) setData(j);
      else setErr(j.error ?? "load failed");
    } catch {
      setErr("network error");
    } finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);

  return (
    <Card data-testid="card-live-gates-diagnostic">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="w-4 h-4 text-sky-400" />
          Live Gates Diagnostic
          <Badge variant="outline" className="ml-2 text-[10px]">admin-only</Badge>
        </CardTitle>
        <CardDescription>
          One row per gate in the live execution pipeline. Plain-English
          status + raw code. No tokens, no secrets, no full account numbers.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {err && <div className="text-xs text-rose-400">{err}</div>}
        <div className="flex items-center justify-between">
          <div className="text-xs">
            <div><span className="text-muted-foreground">Mode:</span> <span className="font-mono">{data?.platformBridgeMode ?? "—"}</span></div>
            <div className="text-muted-foreground">{data?.platformHeadline}</div>
            {data?.nextPlatformStep && (
              <div className="text-muted-foreground text-[11px] pt-1">Next: {data.nextPlatformStep}</div>
            )}
          </div>
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={busy} data-testid="btn-diag-refresh">
            <RefreshCw className="w-3 h-3 mr-1" /> Refresh
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 pr-3">Gate</th>
                <th className="py-1 pr-3">Status</th>
                <th className="py-1 pr-3">Detail</th>
                <th className="py-1 pr-3">Code</th>
              </tr>
            </thead>
            <tbody>
              {(data?.gates ?? []).map((g) => (
                <tr key={g.id} className="border-t border-border/40" data-testid={`row-gate-${g.id}`}>
                  <td className="py-2 pr-3">{g.label}</td>
                  <td className="py-2 pr-3">
                    <Badge className={STATUS_BADGE[g.status]}>
                      {g.status === "pass"
                        ? <><CheckCircle2 className="w-3 h-3 mr-1" />pass</>
                        : g.status === "fail"
                        ? <><AlertCircle className="w-3 h-3 mr-1" />fail</>
                        : <><InfoIcon className="w-3 h-3 mr-1" />info</>}
                    </Badge>
                  </td>
                  <td className="py-2 pr-3 text-muted-foreground">{g.detail}</td>
                  <td className="py-2 pr-3 font-mono text-[11px]">{g.rawCode ?? "—"}</td>
                </tr>
              ))}
              {(!data || data.gates.length === 0) && (
                <tr><td colSpan={4} className="py-3 text-center text-muted-foreground">No gates loaded.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
