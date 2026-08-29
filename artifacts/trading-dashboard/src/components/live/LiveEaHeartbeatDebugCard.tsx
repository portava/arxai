import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CheckCircle2, XCircle, AlertTriangle, Wifi, WifiOff, ShieldAlert, ChevronDown, ChevronUp } from "lucide-react";
import { useCurrentUser } from "@/hooks/useCurrentUser";

type Tri = boolean | null;

type BridgeDebug = {
  bridge: {
    id: number;
    mode: string;
    bridgeKind: "REAL_LIVE" | "REAL_DEMO" | "MOCK";
    accountType: string | null;
    accountNumber: string | number | null;
    brokerName: string | null;
    serverName: string | null;
    eaVersion: string | null;
    bridgeVersion: string | null;
    lastHeartbeatAt: string | null;
    heartbeatAgeSeconds: number | null;
    heartbeatFresh: boolean;
    readOnlyMode: boolean;
    eaInputs: {
      readOnlyMode: Tri;
      enableDemoExecution: Tri;
      enableLiveExecution: Tri;
      terminalConnected: Tri;
      algoTradingAllowed: Tri;
      maxLiveLot: number | null;
      reportedAt: string | null;
    };
  } | null;
  bridgeKind: "REAL_LIVE" | "REAL_DEMO" | "MOCK" | "NONE";
  counts: { live: number; demo: number; mock: number };
  message?: string;
};

function TriCell({ v, wantTrue = true }: { v: Tri; wantTrue?: boolean }) {
  if (v === null) {
    return (
      <span className="inline-flex items-center gap-1 text-warning">
        <AlertTriangle className="w-3.5 h-3.5" /> not reported
      </span>
    );
  }
  const ok = wantTrue ? v === true : v === false;
  return ok ? (
    <span className="inline-flex items-center gap-1 text-success">
      <CheckCircle2 className="w-3.5 h-3.5" /> {String(v)}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-danger">
      <XCircle className="w-3.5 h-3.5" /> {String(v)}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  // Mobile: stack label above value, value wraps. Desktop (sm+): inline.
  // This prevents long values like broker names ("Deriv (SVG) LLC") and
  // server names ("DerivSVG-Server") from being clipped off the right edge
  // on iPhone Safari.
  return (
    <div className="flex flex-col gap-0.5 py-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
      <span className="text-txt-secondary text-xs sm:text-sm">{label}</span>
      <span className="font-mono text-xs text-foreground break-all sm:text-right sm:break-normal sm:whitespace-normal">
        {children}
      </span>
    </div>
  );
}

/**
 * MT5 Bridge Status card.
 *
 * Two layers:
 *   - Regular users see a clean status summary: Bridge Connected, EA up to
 *     date, heartbeat fresh, live execution allowed. No raw bridge kinds,
 *     no internal field names, no MOCK/REAL_LIVE labels.
 *   - Admins (OWNER/ADMIN) can expand a diagnostics panel with the raw
 *     bridge identity + EA input fields for support.
 */
export function LiveEaHeartbeatDebugCard() {
  const { user } = useCurrentUser();
  const isAdmin = user?.role === "OWNER" || user?.role === "ADMIN";
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  const { data, isLoading, error } = useQuery<BridgeDebug>({
    queryKey: ["me-live-bridge-debug"],
    queryFn: async () => {
      const r = await fetch("/api/me/live/bridge-debug");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 5000,
  });

  if (isLoading) {
    return (
      <Card data-testid="live-ea-heartbeat-debug-card">
        <CardContent className="p-6 text-sm text-txt-secondary">Checking your MT5 bridge…</CardContent>
      </Card>
    );
  }
  if (error || !data) {
    return (
      <Card data-testid="live-ea-heartbeat-debug-card">
        <CardContent className="p-6 text-sm text-warning">
          MT5 bridge status is unavailable right now. We'll keep retrying.
        </CardContent>
      </Card>
    );
  }

  const b = data.bridge;
  const isMock = data.bridgeKind === "MOCK";
  const isNone = data.bridgeKind === "NONE";
  const isReal = data.bridgeKind === "REAL_LIVE" || data.bridgeKind === "REAL_DEMO";
  const eaVerOk = !!b?.eaVersion && /^\d+\.\d+/.test(b.eaVersion) && Number(b.eaVersion.split(".").slice(0, 2).join(".")) >= 1.27;

  // Compute a single, friendly summary the user can act on.
  // Order matters — most-blocking first.
  type Summary = { tone: "ok" | "warn" | "bad"; label: string; sub: string };
  const summary: Summary = (() => {
    if (isNone) return { tone: "bad", label: "Bridge not connected", sub: "Add your MT5 bridge from the MT5 Setup page to start." };
    if (isMock) return { tone: "bad", label: "Bridge not ready for live", sub: "Attach the latest MT5 Expert Advisor from a real MetaTrader 5 terminal so a real heartbeat is recorded." };
    if (!b) return { tone: "bad", label: "Bridge details unavailable", sub: "We couldn't read the bridge status. We'll keep retrying." };
    if (!b.heartbeatFresh) return { tone: "warn", label: "MT5 connection needs attention", sub: "We haven't heard from MetaTrader 5 in over 15 seconds. Make sure MT5 is open and the Expert Advisor is attached to a chart." };
    if (!eaVerOk) return { tone: "warn", label: "MT5 Expert Advisor needs updating", sub: "Install the latest Expert Advisor (v1.27 or newer) in MetaTrader 5." };
    if (b.eaInputs.readOnlyMode === true) return { tone: "warn", label: "MT5 EA is in read-only mode", sub: "In MetaTrader 5, open the EA's inputs and set ReadOnlyMode to false to allow order dispatch." };
    if (b.eaInputs.terminalConnected === false) return { tone: "warn", label: "MetaTrader 5 lost broker connection", sub: "MT5 is not connected to the broker. Check your internet and reconnect in MT5." };
    if (b.eaInputs.algoTradingAllowed === false) return { tone: "warn", label: "Algo trading is off in MT5", sub: "Click the AutoTrading button in MetaTrader 5 so the EA can place orders." };
    if (isReal && b.eaInputs.enableLiveExecution === true) return { tone: "ok", label: "Bridge connected · Live execution ready", sub: "MetaTrader 5 is connected, the EA is up to date, and live execution is allowed on the EA side." };
    if (isReal && b.eaInputs.enableLiveExecution !== true) return { tone: "ok", label: "Bridge connected · Live execution off in MT5", sub: "Connection is healthy. To allow live orders, set EnableLiveExecution to true in the EA's inputs." };
    return { tone: "ok", label: "Bridge connected", sub: "MetaTrader 5 connection is healthy." };
  })();

  const toneCls =
    summary.tone === "ok" ? "border-success/40 text-success bg-success/5"
      : summary.tone === "warn" ? "border-warning/40 text-warning bg-warning/5"
      : "border-danger/40 text-danger bg-danger/5";

  return (
    <Card data-testid="live-ea-heartbeat-debug-card">
      <CardHeader>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              {summary.tone === "ok" ? (
                <Wifi className="w-4 h-4 text-success" />
              ) : (
                <WifiOff className="w-4 h-4 text-txt-secondary" />
              )}
              MT5 Bridge Status
            </CardTitle>
            <CardDescription>
              Live view of your MetaTrader 5 connection.
            </CardDescription>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 text-sm">
        <div className={`rounded-md border p-3 ${toneCls}`} data-testid="bridge-summary">
          <div className="font-semibold text-sm">{summary.label}</div>
          <div className="text-xs opacity-90 mt-0.5">{summary.sub}</div>
        </div>

        {/* Admin-only diagnostics — collapsed by default. Regular users
            never see raw bridge identity, MOCK/REAL labels, or EA input
            field names. */}
        {isAdmin && (
          <div className="rounded-md border border-border bg-background/40">
            <Button
              type="button"
              variant="ghost"
              className="w-full justify-between text-xs text-txt-secondary hover:bg-muted/40"
              onClick={() => setShowDiagnostics((v) => !v)}
              data-testid="bridge-diagnostics-toggle"
            >
              <span className="inline-flex items-center gap-2">
                <ShieldAlert className="h-3.5 w-3.5 text-warning" />
                Admin diagnostics
                <Badge
                  variant="outline"
                  className={
                    isMock ? "border-danger/50 text-danger"
                    : isReal ? "border-success/50 text-success"
                    : "border-border/40 text-txt-secondary"
                  }
                  data-testid="live-ea-heartbeat-bridge-kind-badge"
                >
                  {data.bridgeKind}
                </Badge>
              </span>
              {showDiagnostics ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </Button>

            {showDiagnostics && (
              <div className="p-3 border-t border-border space-y-4">
                {isMock && (
                  <Alert className="border-danger/50 bg-danger/10" data-testid="live-ea-heartbeat-mock-warning">
                    <ShieldAlert className="h-4 w-4 text-danger" />
                    <AlertTitle>Bridge is MOCK — cannot satisfy live readiness</AlertTitle>
                    <AlertDescription>
                      The freshest bridge for this user is a MOCK placeholder (
                      <code className="font-mono">mode={b?.mode}</code>). Live readiness paths reject MOCK rows
                      regardless of <code>accountType</code>. Counts: {data.counts.live} LIVE / {data.counts.demo} DEMO /{" "}
                      {data.counts.mock} MOCK non-revoked.
                    </AlertDescription>
                  </Alert>
                )}

                {b && !eaVerOk && (
                  <Alert className="border-warning/50 bg-warning/10" data-testid="live-ea-old-version-warning">
                    <AlertTriangle className="h-4 w-4 text-warning" />
                    <AlertTitle>Old EA attached.</AlertTitle>
                    <AlertDescription>
                      EA reports v{b.eaVersion ?? "?"}. Live execution requires v1.27 or newer.
                    </AlertDescription>
                  </Alert>
                )}

                {b && (
                  <div className="grid md:grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <div className="text-xs uppercase tracking-wider text-txt-secondary">Bridge identity</div>
                      <Row label="bridge id">{b.id}</Row>
                      <Row label="mode (real vs MOCK)">{b.mode}</Row>
                      <Row label="accountType">{b.accountType ?? "—"}</Row>
                      <Row label="MT5 account">{b.accountNumber != null ? String(b.accountNumber) : "—"}</Row>
                      <Row label="broker">{b.brokerName ?? "—"}</Row>
                      <Row label="server">{b.serverName ?? "—"}</Row>
                      <Row label="EA version">{b.eaVersion ?? "—"}</Row>
                      <Row label="bridge version">{b.bridgeVersion ?? "—"}</Row>
                    </div>

                    <div className="space-y-1">
                      <div className="text-xs uppercase tracking-wider text-txt-secondary">Heartbeat + EA inputs (v1.27)</div>
                      <Row label="last heartbeat">
                        {b.lastHeartbeatAt ? new Date(b.lastHeartbeatAt).toLocaleString() : "never"}
                      </Row>
                      <Row label="heartbeat age">
                        {b.heartbeatAgeSeconds === null ? "—" : `${b.heartbeatAgeSeconds}s`}
                      </Row>
                      <Row label="heartbeat fresh (≤15s)">
                        <TriCell v={b.heartbeatFresh} />
                      </Row>
                      <Row label="ReadOnlyMode (want false)">
                        <TriCell v={b.eaInputs.readOnlyMode} wantTrue={false} />
                      </Row>
                      <Row label="EnableLiveExecution (want true)">
                        <TriCell v={b.eaInputs.enableLiveExecution} />
                      </Row>
                      <Row label="MaxLiveLot">
                        {b.eaInputs.maxLiveLot != null ? b.eaInputs.maxLiveLot : (
                          <span className="text-warning">not reported</span>
                        )}
                      </Row>
                      <Row label="terminalConnected (want true)">
                        <TriCell v={b.eaInputs.terminalConnected} />
                      </Row>
                      <Row label="algoTradingAllowed (want true)">
                        <TriCell v={b.eaInputs.algoTradingAllowed} />
                      </Row>
                      <Row label="EA inputs reportedAt">
                        {b.eaInputs.reportedAt ? new Date(b.eaInputs.reportedAt).toLocaleString() : "—"}
                      </Row>
                    </div>
                  </div>
                )}

                <div className="text-xs text-txt-muted">
                  Selection rule: freshest non-revoked LIVE-mode bridge → freshest DEMO bridge → freshest MOCK.
                  MOCK rows are refused at the live dispatch pipeline and the EA-facing live endpoints.
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
