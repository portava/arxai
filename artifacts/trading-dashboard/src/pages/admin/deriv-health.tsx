// Deriv Provider Health Page — Admin/Owner only.
// Shows connection mode, credentials (masked), OTP result, and setup instructions.

import { useEffect, useState } from "react";

type Health = {
  ok?: boolean;
  error?: string;
  health?: "healthy" | "degraded" | "failed" | "unconfigured";
  mode?: "new" | "legacy" | "none";
  configured?: boolean;
  connected?: boolean;
  credentials?: {
    appId?:     { present?: boolean; masked?: string };
    token?:     { present?: boolean; masked?: string };
    accountId?: { present?: boolean };
  };
  otpLastResult?: string | null;
  errorMessage?: string | null;
  lastTickAt?: string | null;
  connectedAt?: string | null;
  reconnectCount?: number;
  subscribedSymbols?: string[];
  knownSymbols?: number;
  activeSymbols?: number;
  message?: string;
  blockers?: string[];
  setupInstructions?: string[];
};

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span className={`inline-block w-2 h-2 rounded-full mr-2 ${ok ? "bg-success" : "bg-danger"}`} />
  );
}

function Row({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-border text-xs">
      <span className="text-txt-secondary">{label}</span>
      <span className={`font-mono ${ok === true ? "text-success" : ok === false ? "text-danger" : "text-foreground"}`}>
        {ok !== undefined && <StatusDot ok={ok} />}{value}
      </span>
    </div>
  );
}

export default function DerivHealthPage() {
  const [data, setData] = useState<Health | null>(null);
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    fetch("/api/admin/deriv-status", { credentials: "include" })
      .then(r => r.json())
      .then(setData)
      .catch(e => setErr(e.message));
  };

  useEffect(() => { load(); }, []);

  const triggerCheck = async () => {
    setChecking(true);
    await fetch("/api/admin/deriv-status/check", { method: "POST", credentials: "include" });
    load();
    setChecking(false);
  };

  const healthColor = (h: string) =>
    h === "healthy" ? "text-success border-success/40 bg-success/10" :
    h === "degraded" ? "text-warning border-warning/40 bg-warning/10" :
    h === "failed" ? "text-danger border-danger/40 bg-danger/10" :
    "text-txt-secondary border-border bg-card";

  return (
    <div className="mx-auto max-w-2xl pb-16 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-foreground">Deriv Provider Health</h1>
          <p className="text-xs text-txt-muted mt-0.5">Synthetic index market data via Deriv API</p>
        </div>
        <div className="flex gap-2">
          <button onClick={load} className="text-xs px-3 py-1.5 rounded border border-border bg-secondary text-txt-secondary hover:bg-secondary/80 transition">
            Refresh
          </button>
          <button onClick={triggerCheck} disabled={checking}
            className="text-xs px-3 py-1.5 rounded border border-primary/50 bg-primary/20 text-primary hover:bg-primary/40 transition disabled:opacity-50">
            {checking ? "Checking…" : "Test Connection"}
          </button>
        </div>
      </div>

      {err && <div className="rounded-lg border border-danger/40 bg-danger/20 p-3 text-xs text-danger">{err}</div>}

      {data?.error && !data.credentials && (
        <div className="rounded-xl border border-warning/40 bg-warning/20 p-4 text-xs text-warning space-y-1">
          <div className="font-semibold">Cannot load Deriv status</div>
          <div className="font-mono opacity-80">{data.error}</div>
          <div className="opacity-70">You may need Admin or Owner role to view this page.</div>
        </div>
      )}

      {data && data.credentials && (
        <>
          {/* Health banner */}
          <div className={`rounded-xl border p-4 ${healthColor(data.health ?? "unconfigured")}`}>
            <div className="font-semibold text-sm mb-1 capitalize">{data.health ?? "unknown"} — {data.mode ?? "none"} mode</div>
            <p className="text-xs opacity-80">{data.message ?? ""}</p>
          </div>

          {/* Status grid */}
          <div className="rounded-xl border border-border bg-background/40 p-4">
            <h2 className="text-xs font-semibold text-txt-secondary uppercase tracking-wide mb-3">Status</h2>
            <Row label="API Mode" value={data.mode === "new" ? "New PAT API" : data.mode === "legacy" ? "Legacy WebSocket" : "Not configured"} />
            <Row label="Connected" value={data.connected ? "Yes" : "No"} ok={!!data.connected} />
            <Row label="Subscribed symbols" value={`${data.activeSymbols ?? 0} / ${data.knownSymbols ?? 0}`} />
            <Row label="Reconnect count" value={String(data.reconnectCount ?? 0)} />
            <Row label="Connected at" value={data.connectedAt ? new Date(data.connectedAt).toLocaleTimeString() : "—"} />
            <Row label="Last tick" value={data.lastTickAt ? new Date(data.lastTickAt).toLocaleTimeString() : "—"} />
          </div>

          {/* Credentials */}
          <div className="rounded-xl border border-border bg-background/40 p-4">
            <h2 className="text-xs font-semibold text-txt-secondary uppercase tracking-wide mb-3">Credentials (masked)</h2>
            <Row label="App ID" value={data.credentials.appId?.masked ?? "—"} ok={!!data.credentials.appId?.present} />
            <Row label="API Token" value={data.credentials.token?.masked ?? "—"} ok={!!data.credentials.token?.present} />
            <Row label="Account ID" value={data.credentials.accountId?.present ? "Present" : "Not set"} ok={!!data.credentials.accountId?.present} />
          </div>

          {/* OTP / error */}
          {(data.otpLastResult || data.errorMessage) && (
            <div className="rounded-xl border border-warning/30 bg-warning/10 p-4">
              <h2 className="text-xs font-semibold text-warning uppercase tracking-wide mb-2">Last Error</h2>
              <p className="text-xs text-warning font-mono">{data.otpLastResult || data.errorMessage}</p>
            </div>
          )}

          {/* Subscribed symbols */}
          {(data.subscribedSymbols?.length ?? 0) > 0 && (
            <div className="rounded-xl border border-border bg-background/40 p-4">
              <h2 className="text-xs font-semibold text-txt-secondary uppercase tracking-wide mb-2">Subscribed Symbols</h2>
              <div className="flex flex-wrap gap-1.5">
                {data.subscribedSymbols!.map(s => (
                  <span key={s} className="text-[10px] font-mono bg-secondary text-txt-secondary px-2 py-0.5 rounded">{s}</span>
                ))}
              </div>
            </div>
          )}

          {/* Blockers */}
          {(data.blockers?.length ?? 0) > 0 && (
            <div className="rounded-xl border border-danger/40 bg-danger/10 p-4 space-y-2">
              <h2 className="text-xs font-semibold text-danger uppercase tracking-wide">Blockers</h2>
              {data.blockers!.map((b, i) => (
                <div key={i} className="text-xs text-danger flex gap-2"><span>⚠</span>{b}</div>
              ))}
            </div>
          )}

          {/* Setup instructions */}
          {(data.setupInstructions?.length ?? 0) > 0 && data.setupInstructions && (
            <div className="rounded-xl border border-border bg-card p-4 space-y-2">
              <h2 className="text-xs font-semibold text-txt-secondary uppercase tracking-wide">Setup Instructions</h2>
              {data.setupInstructions.map((s, i) => (
                <div key={i} className="text-xs text-txt-secondary">{s}</div>
              ))}
              <div className="mt-2 pt-2 border-t border-border">
                <p className="text-xs text-txt-muted">Required Replit Secrets:</p>
                <div className="font-mono text-[11px] text-txt-secondary mt-1 space-y-0.5">
                  <div>DERIV_APP_ID = your alphanumeric app ID</div>
                  <div>DERIV_API_TOKEN = pat_xxxx... (your PAT)</div>
                  <div>DERIV_API_MODE = new (or leave unset for auto)</div>
                  <div>DERIV_ACCOUNT_ID = optional account ID</div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
