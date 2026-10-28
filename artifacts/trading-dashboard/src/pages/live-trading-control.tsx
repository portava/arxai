import { useEffect, useState } from "react";

interface ReadinessReport {
  liveTradingEligible: boolean;
  currentMode: string;
  blockers: string[];
  warnings: string[];
  requiredActions: string[];
  safetyScore: number;
  paperStats: Record<string, unknown>;
  riskStatus: Record<string, unknown>;
  brokerStatus: Record<string, unknown>;
  permissionStatus: Record<string, unknown>;
  hardCodedLimits: Record<string, number | string>;
  ciGuardsAcknowledged: string[];
  lastUpdated: string;
}

interface LiveState {
  mode: string;
  armed: boolean;
  killSwitchActive: boolean;
  emergencyStopActive: boolean;
  killSwitchReason: string | null;
  liveTradesToday: number;
  liveTradesSession: number;
  consecutiveLiveLosses: number;
  dailyLossPct: number;
  weeklyLossPct: number;
}

interface AuditEvent {
  eventId: string;
  eventType: string;
  severity: string;
  mode: string;
  message: string;
  createdAt: string;
}

interface Approval {
  approvalId: string;
  status: string;
  symbol: string;
  direction: string;
  lotSize: number;
  riskPercent: number;
  confidenceScore: number;
  expiresAt: string;
  createdAt: string;
}

const ROLE = "ADMIN";

/** "loading" until the first answer; "failed" when the read was denied, errored or had no payload. */
type ReadState = "loading" | "ok" | "failed";

async function readField<T>(url: string, field: string, headers: Record<string, string>): Promise<T | null> {
  try {
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    const body: unknown = await r.json();
    const v = body && typeof body === "object" ? (body as Record<string, unknown>)[field] : undefined;
    return v == null ? null : (v as T);
  } catch { return null; }
}

export default function LiveTradingControl() {
  const [readiness, setReadiness] = useState<ReadinessReport | null>(null);
  const [state, setState] = useState<LiveState | null>(null);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [phrase, setPhrase] = useState("");
  const [killReason, setKillReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<string>("");
  const [reads, setReads] = useState<{ readiness: ReadState; state: ReadState; approvals: ReadState; audit: ReadState }>({
    readiness: "loading", state: "loading", approvals: "loading", audit: "loading",
  });

  async function load() {
    const headers = { "x-security-role": ROLE };
    const [r1, r2, r3, r4] = await Promise.all([
      readField<ReadinessReport>("/api/live-trading/readiness", "readiness", headers),
      readField<LiveState>("/api/live-trading/state", "state", headers),
      readField<AuditEvent[]>("/api/live-trading/audit?limit=20", "events", headers),
      readField<Approval[]>("/api/live-trading/approvals?limit=20", "approvals", headers),
    ]);
    const readinessOk = r1 != null && Array.isArray(r1.blockers) && Array.isArray(r1.requiredActions);
    setReadiness(readinessOk ? r1 : null);
    setState(r2);
    setAudit(Array.isArray(r3) ? r3 : []);
    setApprovals(Array.isArray(r4) ? r4 : []);
    setReads({
      readiness: readinessOk ? "ok" : "failed",
      state: r2 ? "ok" : "failed",
      audit: Array.isArray(r3) ? "ok" : "failed",
      approvals: Array.isArray(r4) ? "ok" : "failed",
    });
  }

  useEffect(() => {
    void load();
    // Pause polling while tab is hidden (saves 4 parallel fetches every 5s).
    const t = setInterval(() => { if (!document.hidden) void load(); }, 5000);
    return () => clearInterval(t);
  }, []);

  async function action(path: string, body: Record<string, unknown> = {}) {
    setBusy(true);
    try {
      const res = await fetch(`/api/live-trading/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-security-role": ROLE },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      setLastResult(`${path}: ${JSON.stringify(j.result ?? j)}`.slice(0, 300));
    } finally { setBusy(false); await load(); }
  }

  const banner = !state ? (reads.state === "failed" ? "unknown" : "loading") :
    state.killSwitchActive ? "locked" :
    state.armed ? "armed" :
    readiness?.liveTradingEligible ? "ready" : "locked";

  const bannerStyles = {
    locked: "bg-red-600 text-white",
    ready: "bg-yellow-500 text-black",
    armed: "bg-black border-2 border-red-500 text-red-400",
    loading: "bg-gray-600 text-white",
    unknown: "bg-gray-600 text-white",
  } as const;

  return (
    <div className="p-6 space-y-4 max-w-7xl mx-auto">
      <div className={`p-4 rounded-lg font-bold text-lg ${bannerStyles[banner]}`}>
        {banner === "locked" && (state?.killSwitchActive
          ? "🔒 LIVE TRADING LOCKED — kill switch active"
          : reads.readiness === "failed"
            ? "🔒 LIVE TRADING LOCKED — readiness could not be read"
            : "🔒 LIVE TRADING LOCKED — readiness blockers present")}
        {banner === "ready" && "⚠️ MICRO-LIVE READY — not armed."}
        {/* Arming here cannot place a real order: placeLiveOrderGuarded always rejects in this build. */}
        {banner === "armed" && "🚨 MICRO-LIVE ARMED — this control's broker placement layer is locked, so no real order can be placed from here"}
        {banner === "loading" && "Loading..."}
        {banner === "unknown" && "Live trading state could not be read — treat live trading as locked."}
      </div>

      <div className="bg-yellow-50 border-l-4 border-yellow-400 p-3 text-sm text-yellow-900">
        <strong>Live trading is paused.</strong> The live broker placement layer is intentionally locked
        in this build, so even an armed, approved trade card cannot reach a real broker from here.
        <div className="mt-1 text-[10px] font-mono opacity-60">Technical: BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED</div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-card border rounded-lg p-4">
          <h3 className="font-semibold text-sm text-muted-foreground">CURRENT MODE</h3>
          <p className="text-2xl font-bold mt-1">{state?.mode ?? "—"}</p>
          <p className="text-xs mt-1">Armed: {state
            ? <span className={state.armed ? "text-red-600 font-bold" : "text-emerald-600"}>{String(state.armed)}</span>
            : <span className="text-muted-foreground">{reads.state === "failed" ? "unknown (state not read)" : "…"}</span>}</p>
        </div>
        <div className="bg-card border rounded-lg p-4" data-testid="ltc-readiness">
          <h3 className="font-semibold text-sm text-muted-foreground">READINESS</h3>
          <p className="text-2xl font-bold mt-1">{readiness ? (readiness.liveTradingEligible ? "ELIGIBLE" : "NOT ELIGIBLE") : reads.readiness === "failed" ? "UNKNOWN" : "—"}</p>
          <p className="text-xs mt-1">{readiness ? `Safety score: ${readiness.safetyScore ?? "—"}/100` : reads.readiness === "failed" ? "Readiness could not be read." : "Safety score: —/100"}</p>
        </div>
        <div className="bg-card border rounded-lg p-4" data-testid="ltc-kill-switch">
          <h3 className="font-semibold text-sm text-muted-foreground">KILL SWITCH</h3>
          <p className={`text-2xl font-bold mt-1 ${!state ? "text-muted-foreground" : state.killSwitchActive ? "text-red-600" : "text-emerald-600"}`}>
            {!state ? (reads.state === "failed" ? "UNKNOWN" : "—") : state.killSwitchActive ? "ACTIVE" : "OFF"}
          </p>
          <p className="text-xs mt-1 truncate">{!state ? (reads.state === "failed" ? "Live trading state could not be read." : "") : state.killSwitchReason ?? "no reason logged"}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-card border rounded-lg p-4" data-testid="ltc-blockers">
          <h3 className="font-semibold mb-2">Blockers ({readiness ? readiness.blockers.length : "?"})</h3>
          {!readiness ? (
            <p className="text-sm text-muted-foreground">{reads.readiness === "failed" ? "Blockers unavailable — readiness could not be read." : "Loading…"}</p>
          ) : readiness.blockers.length ? (
            <ul className="text-sm space-y-1">
              {readiness.blockers.map((b, i) => <li key={i} className="text-red-600">• {b}</li>)}
            </ul>
          ) : <p className="text-sm text-emerald-600">No blockers.</p>}
        </div>
        <div className="bg-card border rounded-lg p-4" data-testid="ltc-required-actions">
          <h3 className="font-semibold mb-2">Required actions ({readiness ? readiness.requiredActions.length : "?"})</h3>
          {!readiness ? (
            <p className="text-sm text-muted-foreground">{reads.readiness === "failed" ? "Unavailable — readiness could not be read." : "Loading…"}</p>
          ) : readiness.requiredActions.length ? (
            <ul className="text-sm space-y-1">
              {readiness.requiredActions.map((a, i) => <li key={i}>→ {a}</li>)}
            </ul>
          ) : <p className="text-sm text-muted-foreground">None.</p>}
        </div>
      </div>

      <div className="bg-card border rounded-lg p-4 space-y-3">
        <h3 className="font-semibold">Arm / Disarm</h3>
        <input
          type="text" value={phrase} onChange={(e) => setPhrase(e.target.value)}
          placeholder='Type: I UNDERSTAND THIS CAN LOSE REAL MONEY'
          className="w-full px-3 py-2 border rounded text-sm font-mono"
        />
        <div className="flex gap-2 flex-wrap">
          <button disabled={busy} onClick={() => action("arm", { confirmationPhrase: phrase, mode: "MICRO_LIVE" })}
            className="px-4 py-2 bg-yellow-500 text-black rounded font-bold disabled:opacity-50">
            ARM MICRO-LIVE
          </button>
          <button disabled={busy} onClick={() => action("disarm", { reason: "manual" })}
            className="px-4 py-2 bg-emerald-600 text-white rounded font-bold disabled:opacity-50">
            DISARM (return to DEMO_ONLY)
          </button>
        </div>
      </div>

      <div className="bg-card border-2 border-red-500 rounded-lg p-4 space-y-3">
        <h3 className="font-semibold text-red-600">Emergency Kill Switch</h3>
        <input
          type="text" value={killReason} onChange={(e) => setKillReason(e.target.value)}
          placeholder="Reason for kill switch (min 4 chars)"
          className="w-full px-3 py-2 border rounded text-sm"
        />
        <div className="flex gap-2 flex-wrap">
          <button disabled={busy} onClick={() => action("kill-switch", { reason: killReason })}
            className="px-4 py-2 bg-red-600 text-white rounded font-bold disabled:opacity-50">
            🛑 ENGAGE KILL SWITCH
          </button>
          <button disabled={busy} onClick={() => action("reset-kill-switch", { reason: killReason || "post-investigation reset" })}
            className="px-4 py-2 bg-gray-700 text-white rounded font-bold disabled:opacity-50">
            Reset Kill Switch (ADMIN, requires readiness)
          </button>
        </div>
      </div>

      <div className="bg-card border rounded-lg p-4">
        <h3 className="font-semibold mb-2">Hard-coded Micro-Live Limits</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
          {readiness && Object.entries(readiness.hardCodedLimits).map(([k, v]) => (
            <div key={k} className="flex justify-between border-b py-1">
              <span className="text-muted-foreground">{k}</span>
              <span className="font-mono font-bold">{String(v)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-card border rounded-lg p-4" data-testid="ltc-approvals">
        <h3 className="font-semibold mb-2">Trade Approval Queue ({reads.approvals === "ok" ? approvals.length : "?"})</h3>
        {reads.approvals !== "ok" ? (
          <p className="text-sm text-muted-foreground">{reads.approvals === "failed" ? "The approval queue could not be read." : "Loading…"}</p>
        ) : approvals.length === 0 ? <p className="text-sm text-muted-foreground">No trade cards.</p> : (
          <table className="w-full text-xs">
            <thead><tr className="text-left border-b"><th>ID</th><th>Status</th><th>Symbol</th><th>Dir</th><th>Lot</th><th>Risk%</th><th>Conf</th></tr></thead>
            <tbody>
              {approvals.map(a => (
                <tr key={a.approvalId} className="border-b">
                  <td className="font-mono">{a.approvalId.slice(0, 12)}…</td>
                  <td><span className="px-2 py-0.5 rounded bg-gray-100">{a.status}</span></td>
                  <td>{a.symbol}</td><td>{a.direction}</td>
                  <td>{a.lotSize}</td><td>{a.riskPercent}%</td><td>{a.confidenceScore}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="bg-card border rounded-lg p-4">
        <h3 className="font-semibold mb-2">Audit History (latest 20)</h3>
        {reads.audit === "failed" && <p className="text-sm text-muted-foreground">The audit history could not be read.</p>}
        <div className="space-y-1 max-h-96 overflow-auto text-xs font-mono">
          {audit.map(e => (
            <div key={e.eventId} className="flex gap-2 border-b pb-1">
              <span className="text-muted-foreground">{new Date(e.createdAt).toISOString().slice(11, 19)}</span>
              <span className={`font-bold ${e.severity === "CRITICAL" ? "text-red-600" : e.severity === "HIGH" ? "text-orange-600" : e.severity === "WARNING" ? "text-yellow-600" : "text-emerald-600"}`}>
                [{e.severity}]
              </span>
              <span className="font-bold">{e.eventType}</span>
              <span className="text-muted-foreground truncate">{e.message}</span>
            </div>
          ))}
        </div>
      </div>

      {lastResult && (
        <div className="bg-gray-100 border rounded-lg p-3 text-xs font-mono break-all">
          <strong>Last action result:</strong> {lastResult}
        </div>
      )}
    </div>
  );
}
