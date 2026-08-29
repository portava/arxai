import { useEffect, useState } from "react";

interface Session {
  paper_session_id: string;
  status: string;
  symbols: string[];
  timeframes: string[];
  started_at: string | null;
  paperTradesOpened: number;
  paperTradesClosed: number;
  netPnl: number;
  winRate: number;
  sessionRules: { maxPaperTrades: number; maxSessionLoss: number; maxSessionMinutes: number; allowPaperAutopilot: boolean };
  activeWarnings: Array<{ source: string; code: string; message: string }>;
  nextBestActions: string[];
}

export default function ActivePaperSession() {
  const [s, setS] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const r = await fetch("/api/paper-sessions/active");
    const d = await r.json();
    setS(d.active ?? null);
  }
  useEffect(() => { void load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, []);

  async function action(path: string, reason: string) {
    if (!s) return;
    setBusy(true);
    try {
      await fetch(`/api/paper-sessions/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-security-role": "OWNER" },
        body: JSON.stringify({ paperSessionId: s.paper_session_id, reason }),
      });
    } finally { setBusy(false); await load(); }
  }

  if (!s) return (
    <div className="p-6 space-y-2">
      <h1 className="text-2xl font-bold">Active Demo Session</h1>
      <p className="text-sm text-muted-foreground">No active session. Start one from <a className="underline" href="/demo-testing-launch">Demo Testing Launch</a>.</p>
    </div>
  );

  const elapsedMin = s.started_at ? Math.round((Date.now() - Date.parse(s.started_at))/60_000) : 0;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Active Demo Session</h1>
          <p className="text-sm text-muted-foreground">{s.paper_session_id}</p>
        </div>
        <div className="flex gap-2">
          <span className="px-2 py-1 rounded bg-success/10 text-success text-xs">{s.status}</span>
          <span className="px-2 py-1 rounded bg-primary/10 text-primary text-xs">PAPER_ONLY</span>
          <span className="px-2 py-1 rounded bg-danger/10 text-danger text-xs">LIVE DISABLED</span>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Elapsed" value={`${elapsedMin}m / ${s.sessionRules.maxSessionMinutes}m`} />
        <Stat label="Trades opened" value={`${s.paperTradesOpened} / ${s.sessionRules.maxPaperTrades}`} />
        <Stat label="Trades closed" value={String(s.paperTradesClosed)} />
        <Stat label="Net P&L (¢)" value={String(s.netPnl)} />
        <Stat label="Win rate" value={`${s.winRate}%`} />
        <Stat label="Symbols" value={s.symbols.join(", ")} />
        <Stat label="Timeframes" value={s.timeframes.join(", ")} />
        <Stat label="Autopilot" value={s.sessionRules.allowPaperAutopilot ? "Allowed" : "Disabled"} />
      </div>

      <div className="flex gap-2">
        {s.status === "ACTIVE" && (
          <button onClick={() => void action("pause", "manual pause")} disabled={busy} className="px-4 py-2 rounded bg-warning text-white">Pause</button>
        )}
        {s.status === "PAUSED" && (
          <button onClick={() => void action("resume", "manual resume")} disabled={busy} className="px-4 py-2 rounded bg-success text-white">Resume</button>
        )}
        {(s.status === "ACTIVE" || s.status === "PAUSED") && (
          <button onClick={() => void action("end", "manual end")} disabled={busy} className="px-4 py-2 rounded bg-danger text-white">End session</button>
        )}
      </div>

      {s.activeWarnings.length > 0 && (
        <div className="rounded border p-4">
          <div className="font-semibold">Active warnings ({s.activeWarnings.length})</div>
          <ul className="list-disc pl-5 text-sm text-warning">{s.activeWarnings.map((w,i)=><li key={i}>[{w.source}] {w.code} — {w.message}</li>)}</ul>
        </div>
      )}

      {s.nextBestActions.length > 0 && (
        <div className="rounded border p-4">
          <div className="font-semibold">Next best actions</div>
          <ul className="list-disc pl-5 text-sm">{s.nextBestActions.map((a,i)=><li key={i}>{a}</li>)}</ul>
        </div>
      )}

      <p className="text-xs text-muted-foreground">No live trading controls on this page. Live execution remains hard-disabled.</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}
