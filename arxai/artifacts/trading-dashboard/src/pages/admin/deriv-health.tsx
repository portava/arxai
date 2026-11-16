// Deriv Provider Health Page — Admin/Owner only.
// Public prices and private account authorization are separate capabilities.

import { useCallback, useEffect, useRef, useState } from "react";

type Health = {
  ok?: boolean;
  error?: string;
  health?: "healthy" | "degraded" | "failed" | "unconfigured" | "warming";
  mode?: "new" | "legacy" | "none" | "public";
  configured?: boolean;
  connected?: boolean;
  hasRecentTick?: boolean;
  authorized?: boolean;
  source?: string;
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
  perSymbol?: Array<{
    symbol: string;
    derivId: string;
    lastTickAt: string | null;
    lastTickAgeMs: number | null;
    hasRecentTick: boolean;
    feedReadinessState: string;
  }>;
};

function tickAge(at: string | null | undefined, now: number): number | null {
  if (!at) return null;
  const age = now - Date.parse(at);
  return Number.isFinite(age) && age >= 0 ? age : null;
}

function ageLabel(age: number | null): string {
  return age === null ? "No verified timestamp" : `${Math.floor(age / 1000)}s ago`;
}

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
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const checkingRef = useRef(false);
  const loadingRef = useRef(false);

  const load = useCallback(async (check = false) => {
    if (!check && checkingRef.current) return;
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    const version = ++generation.current;
    checkingRef.current = check;
    loadingRef.current = true;
    setChecking(check);
    setLoading(true);
    setErr(null);
    let timedOut = false;
    let deadline: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => {
        timedOut = true;
        active.abort();
        reject(new Error("Status request timed out"));
      }, 12_000);
    });
    try {
      const read = async () => {
        if (check) {
          const response = await fetch("/api/admin/deriv-status/check", {
            method: "POST", credentials: "include", signal: active.signal,
          });
          if (!response.ok) throw new Error("Connection check failed. Refresh to try again.");
        }
        const response = await fetch("/api/admin/deriv-status", { credentials: "include", signal: active.signal });
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403
          ? "Sign in with an Admin or Owner account to view Deriv status."
          : "Deriv status is unavailable. Refresh to try again.");
        const result = await response.json() as Health;
        if (!result || result.ok !== true || !result.credentials) throw new Error("Deriv returned an incomplete status. Refresh to try again.");
        return result;
      };
      const result = await Promise.race([read(), expired]);
      if (version !== generation.current || active.signal.aborted) return;
      setData(result);
      setNow(Date.now());
    } catch {
      if (version !== generation.current || (active.signal.aborted && !timedOut)) return;
      // Never leave an old green connection card visible after a failed read.
      setData(null);
      setErr("Cannot verify Deriv status. Check your connection and Admin access, then refresh.");
    } finally {
      clearTimeout(deadline!);
      if (version === generation.current && (!active.signal.aborted || timedOut)) {
        checkingRef.current = false;
        loadingRef.current = false;
        setChecking(false);
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = setInterval(() => { if (document.visibilityState !== "hidden" && !loadingRef.current) void load(); }, 10_000);
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    const visible = () => {
      if (document.visibilityState === "visible") {
        setNow(Date.now());
        if (!loadingRef.current) void load();
      }
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      generation.current++;
      controller.current?.abort();
      checkingRef.current = false;
      loadingRef.current = false;
      clearInterval(poll);
      clearInterval(clock);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [load]);

  const publicData = data?.mode === "public";
  const lastAge = tickAge(data?.lastTickAt, now);
  const fresh = !!data?.connected && data.hasRecentTick === true && lastAge !== null && lastAge <= 30_000;

  const healthColor = (h: string) =>
    h === "healthy" ? "text-success border-success/40 bg-success/10" :
    h === "degraded" ? "text-warning border-warning/40 bg-warning/10" :
    h === "failed" ? "text-danger border-danger/40 bg-danger/10" :
    "text-txt-secondary border-border bg-card";

  return (
    <div className="mx-auto max-w-2xl p-4 pb-16 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-foreground">Deriv Provider Health</h1>
          <p className="text-xs text-txt-muted mt-0.5">Synthetic index market data via Deriv API</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => void load()} disabled={checking} className="text-xs px-3 py-1.5 rounded border border-border bg-secondary text-txt-secondary hover:bg-secondary/80 transition disabled:opacity-50">
            {loading && !checking ? "Refreshing…" : "Refresh"}
          </button>
          <button onClick={() => void load(true)} disabled={checking}
            className="text-xs px-3 py-1.5 rounded border border-primary/50 bg-primary/20 text-primary hover:bg-primary/40 transition disabled:opacity-50">
            {checking ? "Checking…" : "Test Connection"}
          </button>
        </div>
      </div>

      {err && <div role="alert" className="rounded-lg border border-danger/40 bg-danger/20 p-3 text-xs text-danger">{err}</div>}

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
          <div className={`rounded-xl border p-4 ${healthColor(data.health === "healthy" && !fresh ? "degraded" : data.health ?? "unconfigured")}`}>
            <div className="font-semibold text-sm mb-1">{fresh ? "Live market prices" : "Live prices not verified"}</div>
            <p className="text-xs opacity-80">{publicData
              ? "Public market data only. This connection does not authorize an account or enable trading."
              : data.message ?? ""}</p>
          </div>

          {/* Status grid */}
          <div className="rounded-xl border border-border bg-background/40 p-4">
            <h2 className="text-xs font-semibold text-txt-secondary uppercase tracking-wide mb-3">Status</h2>
            <Row label="API Mode" value={publicData ? "Public market data" : data.mode === "new" ? "New PAT API" : data.mode === "legacy" ? "Legacy WebSocket" : "Not configured"} />
            <Row label="Connected" value={data.connected ? "Yes" : "No"} ok={!!data.connected} />
            <Row label="Subscribed symbols" value={`${data.subscribedSymbols?.length ?? 0} / ${data.knownSymbols ?? 0}`} />
            <Row label="Reconnect count" value={String(data.reconnectCount ?? 0)} />
            <Row label="Connected at" value={data.connectedAt ? new Date(data.connectedAt).toLocaleTimeString() : "—"} />
            <Row label="Last venue tick" value={ageLabel(lastAge)} ok={fresh} />
            <Row label="Account authorization" value={publicData ? "Not available on this public connection" : data.authorized ? "Authorized; trading checks still apply" : "Not verified"} />
          </div>

          {!!data.perSymbol?.length && (
            <div className="rounded-xl border border-border bg-background/40 p-4">
              <h2 className="text-xs font-semibold text-txt-secondary uppercase tracking-wide mb-3">Market price freshness</h2>
              <p className="text-xs text-txt-muted mb-2">Each market needs its own recent price. Fresh prices do not confirm account spreads or permission to trade.</p>
              {data.perSymbol.map(symbol => {
                const age = tickAge(symbol.lastTickAt, now);
                const live = !!data.connected && symbol.hasRecentTick && age !== null && age <= 30_000;
                return <Row key={symbol.symbol} label={symbol.symbol} value={`${live ? "Live" : "Not live"} · ${ageLabel(age)}`} ok={live} />;
              })}
            </div>
          )}

          {/* Credentials */}
          <div className="rounded-xl border border-border bg-background/40 p-4">
            <h2 className="text-xs font-semibold text-txt-secondary uppercase tracking-wide mb-3">{publicData ? "Public data access" : "Credentials (masked)"}</h2>
            {publicData ? <p className="text-xs text-txt-secondary">No app ID, API token or account login is required for this market-data connection.</p> : <>
            <Row label="App ID" value={data.credentials.appId?.masked ?? "—"} ok={!!data.credentials.appId?.present} />
            <Row label="API Token" value={data.credentials.token?.masked ?? "—"} ok={!!data.credentials.token?.present} />
            <Row label="Account ID" value={data.credentials.accountId?.present ? "Present" : "Not set"} ok={!!data.credentials.accountId?.present} />
            </>}
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
            </div>
          )}
        </>
      )}
    </div>
  );
}
