import { useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageShell, SectionHeader } from "@/components/ss/PageShell";
import { StatusPill } from "@/components/ss/StatusPill";
import { LoadingState, BlockedState, ErrorState } from "@/components/ss/States";

interface PreflightSource { source: string; code: string; message: string }
interface Preflight {
  paperTestingAllowed: boolean;
  hardBlocks: PreflightSource[];
  warnings: PreflightSource[];
  oo: { status: string; canProceedToPaperTesting: boolean; canProceedToLiveTrading: false; score: number; grade: string; criticalFailureCount: number };
  hh: { status: string; paperTradingAllowed: boolean };
  nn: { secretsRedacted: boolean; rolesSeeded: boolean };
  kk: { brokerMode: string; marketDataMode: string };
  ll: { unacknowledgedCriticalCount: number };
  ff: { mode: string; autopilotAllowed: boolean };
  generatedAt: string;
}

export default function PaperTestingLaunch() {
  const [pre, setPre] = useState<Preflight | null>(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [msg, setMsg] = useState<string>("");
  const [err, setErr] = useState<string>("");

  async function load() {
    setLoading(true); setErr("");
    try {
      const r = await fetch("/api/paper-sessions/preflight", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const d = await r.json();
      setPre(d.preflight);
    } catch (e) { setErr(String(e)); } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function startSession() {
    setStarting(true); setMsg("");
    try {
      const r = await fetch("/api/paper-sessions/start", {
        method: "POST",
        headers: { "content-type": "application/json", "x-security-role": "OWNER" },
        body: JSON.stringify({ symbols: ["Volatility 75 Index"], timeframes: ["M5"] }),
      });
      const d = await r.json();
      setMsg(`${d.result?.status ?? "?"} — ${d.result?.session?.paper_session_id ?? ""} ${d.result?.reason ?? ""}`);
    } finally { setStarting(false); await load(); }
  }

  return (
    <PageShell
      title="Demo Testing Launch"
      description="Build PP — controlled demo-testing session manager. Live trading remains DISABLED."
      icon={<Activity className="h-6 w-6" />}
      actions={
        <>
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>{loading ? "Refreshing…" : "Re-run preflight"}</Button>
          <Button size="sm" onClick={() => void startSession()} disabled={!pre?.paperTestingAllowed || starting}>
            {starting ? "Starting…" : "Start paper session"}
          </Button>
        </>
      }
    >
      {err && <ErrorState description={err} onRetry={load} />}
      {loading && !pre && <LoadingState label="Running preflight…" />}
      {msg && <Card><CardContent className="pt-4 text-sm">{msg}</CardContent></Card>}

      {pre && !pre.paperTestingAllowed && pre.hardBlocks.length > 0 && (
        <BlockedState
          what="Demo session blocked"
          why={pre.hardBlocks.map(b => `[${b.source}] ${b.message}`).join(" · ")}
          blockingSystem={Array.from(new Set(pre.hardBlocks.map(b => b.source))).join(", ")}
          safeNextStep="Resolve the blocks below, then re-run preflight. Live trading remains disabled regardless."
          link={{ label: "Open Why-Blocked help", href: "/help" }}
        />
      )}

      {pre && (
        <div className="grid gap-3 md:grid-cols-2">
          <Card>
            <CardContent className="pt-4">
              <SectionHeader
                title="Preflight"
                actions={<StatusPill status={pre.paperTestingAllowed ? "SAFE_TO_PAPER_TEST" : "BLOCKED"} />}
              />
              <p className="text-xs text-muted-foreground">Generated {new Date(pre.generatedAt).toLocaleString()}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <SectionHeader title="OO Readiness" actions={<StatusPill status={pre.oo.canProceedToPaperTesting ? "ACTIVE" : "BLOCKED"} size="xs" label={pre.oo.status} />} />
              <dl className="text-sm grid grid-cols-2 gap-x-3 gap-y-1">
                <dt className="text-muted-foreground">Score</dt><dd className="tabular-nums">{pre.oo.score} ({pre.oo.grade})</dd>
                <dt className="text-muted-foreground">Demo allowed</dt><dd>{String(pre.oo.canProceedToPaperTesting)}</dd>
                <dt className="text-muted-foreground">Live allowed</dt><dd className="text-danger font-semibold">false</dd>
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <SectionHeader title="HH Risk Governor" actions={<StatusPill status={pre.hh.paperTradingAllowed ? "ACTIVE" : "BLOCKED"} size="xs" label={pre.hh.status} />} />
              <p className="text-sm">paper allowed: <b>{String(pre.hh.paperTradingAllowed)}</b></p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <SectionHeader title="NN Security" />
              <p className="text-sm">Roles seeded: <b>{String(pre.nn.rolesSeeded)}</b> · secrets redacted: <b>{String(pre.nn.secretsRedacted)}</b></p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <SectionHeader title="KK Broker / Data" actions={<StatusPill status="READ_ONLY" size="xs" />} />
              <p className="text-sm">Broker mode: <b>{pre.kk.brokerMode}</b> · Market data: <b>{pre.kk.marketDataMode}</b></p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <SectionHeader
                title="LL Critical Alerts"
                actions={<StatusPill status={pre.ll.unacknowledgedCriticalCount === 0 ? "ACTIVE" : "ACTION_REQUIRED"} size="xs" label={pre.ll.unacknowledgedCriticalCount === 0 ? "0 UNREAD" : `${pre.ll.unacknowledgedCriticalCount} UNREAD`} />}
              />
              <p className="text-sm">Unacknowledged: <b className="tabular-nums">{pre.ll.unacknowledgedCriticalCount}</b></p>
            </CardContent>
          </Card>
          <Card className="md:col-span-2">
            <CardContent className="pt-4">
              <SectionHeader
                title={`Hard blocks (${pre.hardBlocks.length})`}
                actions={pre.hardBlocks.length === 0 && <StatusPill status="SAFE_TO_PAPER_TEST" size="xs" />}
              />
              {pre.hardBlocks.length === 0
                ? <p className="text-sm text-success">None — safe to start.</p>
                : <ul className="list-disc pl-5 text-sm text-danger space-y-0.5">{pre.hardBlocks.map((b,i)=><li key={i}><span className="font-mono text-xs">[{b.source}]</span> {b.code} — {b.message}</li>)}</ul>}
            </CardContent>
          </Card>
          {pre.warnings.length > 0 && (
            <Card className="md:col-span-2">
              <CardContent className="pt-4">
                <SectionHeader title={`Warnings (${pre.warnings.length})`} />
                <ul className="list-disc pl-5 text-sm text-warning space-y-0.5">{pre.warnings.map((b,i)=><li key={i}><span className="font-mono text-xs">[{b.source}]</span> {b.code} — {b.message}</li>)}</ul>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </PageShell>
  );
}
