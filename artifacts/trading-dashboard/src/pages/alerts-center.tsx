import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { safeDate } from "@/lib/safeFormat";
import { Badge } from "@/components/ui/badge";
import { Bell, Check, X, Clock } from "lucide-react";

type Alert = {
  alertId: string; severity: string;
  symbol?: string; timeframe?: string;
  message: string; reason: string; recommendedAction: string;
  source: string; createdAt: string;
  acknowledgedAt?: string | null;
};

const SEV: Record<string, string> = {
  info: "bg-blue-500/20 text-blue-400 border-blue-500/40",
  warning: "bg-amber-500/20 text-amber-400 border-amber-500/40",
  critical: "bg-rose-500/20 text-rose-400 border-rose-500/40",
};

// Minutes in one bar of each scanner timeframe. A scanner alert describes the
// read at the moment it was raised; once one bar of its own timeframe has
// passed, that read has been superseded and nothing here re-checks it.
const TF_MINUTES: Record<string, number> = {
  M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440,
};
const DEFAULT_SUPERSEDE_MIN = 15;

function fmtAge(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)} days`;
}

/** Age of an alert and whether its own timeframe has moved on since. */
export function alertAge(a: Pick<Alert, "createdAt" | "timeframe">, now: number):
  { ageMs: number | null; superseded: boolean } {
  const t = Date.parse(a.createdAt);
  if (!Number.isFinite(t)) return { ageMs: null, superseded: true };
  const ageMs = Math.max(0, now - t);
  const barMin = (a.timeframe && TF_MINUTES[a.timeframe.toUpperCase()]) || DEFAULT_SUPERSEDE_MIN;
  return { ageMs, superseded: ageMs >= barMin * 60_000 };
}

const LIST_LIMIT = 100;

type ActionKind = "acknowledge" | "snooze" | "dismiss";
const ACTION_VERB: Record<ActionKind, string> = { acknowledge: "Acknowledge", snooze: "Snooze", dismiss: "Dismiss" };

/**
 * POSTs an alert action and reports whether the server accepted it. These
 * routes are admin-only on the server. In production the role comes from the
 * signed-in session only (the x-security-role header is a dev/QA channel the
 * server ignores there), so a refusal is a normal outcome for most users and
 * must be shown, not swallowed.
 */
async function postAction(kind: ActionKind, body: Record<string, unknown>): Promise<string | null> {
  const verb = ACTION_VERB[kind];
  let r: Response;
  try {
    r = await fetch(`/api/alerts/${kind}`, {
      method: "POST",
      headers: { "x-security-role": "ADMIN", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return `${verb} could not reach the server, so nothing changed. The alert is still open.`;
  }
  if (r.ok) return null;
  if (r.status === 401 || r.status === 403) {
    return `${verb} was refused by the server (HTTP ${r.status}): only an admin can change the shared alert list. The alert is still open.`;
  }
  if (r.status === 404) {
    return `${verb} failed: the server no longer has this alert (HTTP 404). It may have been removed or the server restarted.`;
  }
  return `${verb} failed on the server (HTTP ${r.status}), so nothing changed. The alert is still open.`;
}

export default function AlertsCenter() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [openCount, setOpenCount] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ alertId: string; message: string } | null>(null);
  const [showAll, setShowAll] = useState(false);

  async function load() {
    try {
      const x = await fetch(`/api/alerts/scanner?limit=${LIST_LIMIT}${showAll ? "" : "&unackedOnly=true"}`);
      if (!x.ok) throw new Error(`HTTP ${x.status}`);
      const r = (await x.json()) as { alerts?: unknown; count?: unknown };
      if (!Array.isArray(r.alerts)) throw new Error("response had no alert list");
      setAlerts(r.alerts as Alert[]);
      setOpenCount(typeof r.count === "number" && Number.isFinite(r.count) ? r.count : null);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "unknown error");
    } finally {
      setLoaded(true);
    }
  }

  async function act(kind: ActionKind, alertId: string, extra: Record<string, unknown> = {}) {
    const err = await postAction(kind, { alertId, ...extra });
    setActionError(err ? { alertId, message: err } : null);
    void load();
  }
  useEffect(() => { void load(); const id = setInterval(load, 5000); return () => clearInterval(id); }, [showAll]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Bell className="h-6 w-6 text-primary" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Alerts Center</h1>
          <p className="text-sm text-muted-foreground" data-testid="alerts-center-scope">
            Shared scanner notices: raised by the most recent market scans run on ARX, the same list for every user, not personal to you.
            Each one shows when it was raised; nothing re-checks it afterwards. Acknowledge, snooze and dismiss change the list for everyone.
          </p>
        </div>
        <Badge variant="outline">SHARED · ANALYSIS ONLY</Badge>
        <Badge data-testid="alerts-open-count" title="Open (not acknowledged) alerts in the server's list">
          {openCount == null ? "open count unknown" : openCount >= LIST_LIMIT ? `at least ${LIST_LIMIT} open` : `${openCount} open`}
        </Badge>
        <Button size="sm" variant="outline" onClick={() => setShowAll((s) => !s)}>
          {showAll ? "Show open only" : "Show all"}
        </Button>
      </div>

      {loadError && (
        <Card><CardContent className="p-4 text-sm text-rose-400" data-testid="alerts-load-error">
          The alert list could not be loaded ({loadError}).{" "}
          {loaded && alerts.length > 0 ? "The alerts below are from the last successful load and may be out of date." : "Whether any alerts exist is unknown."}
        </CardContent></Card>
      )}

      {loaded && !loadError && alerts.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="alerts-shown-count">
          {alerts.length >= LIST_LIMIT
            ? `Showing the newest ${alerts.length} ${showAll ? "open and acknowledged" : "open"} alerts; older ones are not listed.`
            : `Showing ${alerts.length} ${showAll ? "open and acknowledged" : "open"} alert${alerts.length === 1 ? "" : "s"}.`}
        </p>
      )}

      {alerts.length === 0
        ? (loadError || !loaded ? null : (
          <Card><CardContent className="p-6 text-sm text-muted-foreground" data-testid="alerts-empty">
            {showAll ? "No alerts" : "No open alerts"} in the server's list right now. This list is held in server memory only:
            it is cleared whenever the API server restarts, so earlier alerts may have existed and are no longer shown.
          </CardContent></Card>
        ))
        : <div className="space-y-2">
            {alerts.map((a) => {
              const { ageMs, superseded } = alertAge(a, Date.now());
              return (
              <Card key={a.alertId} className={a.acknowledgedAt || superseded ? "opacity-60" : ""} data-testid={`alert-${a.alertId}`}>
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge className={SEV[a.severity] ?? ""}>{a.severity}</Badge>
                    <Badge variant="outline">{a.source}</Badge>
                    {a.symbol && <Badge variant="outline">{a.symbol} {a.timeframe ?? ""}</Badge>}
                    <CardTitle className="text-sm flex-1">{a.message}</CardTitle>
                    <span className="text-xs text-muted-foreground" data-testid="alert-raised">
                      Raised {safeDate(a.createdAt, "time")}{ageMs != null ? ` · ${fmtAge(ageMs)} ago` : ""}
                    </span>
                  </div>
                </CardHeader>
                <CardContent className="text-xs space-y-2">
                  <p className="text-muted-foreground">{a.reason}</p>
                  {superseded ? (
                    <p className="text-amber-400" data-testid="alert-superseded">
                      {ageMs == null
                        ? "When this alert was raised is unknown, so it cannot be treated as current. Re-check this market in the scanner before acting on it."
                        : `Not re-checked for ${fmtAge(ageMs)}, longer than ${a.timeframe && TF_MINUTES[a.timeframe.toUpperCase()] ? `one ${a.timeframe} bar` : `${DEFAULT_SUPERSEDE_MIN} minutes`}, so it may no longer hold. Re-check this market in the scanner before acting on it.`}
                    </p>
                  ) : (
                    <p>Recommended: <span className="font-medium">{a.recommendedAction}</span></p>
                  )}
                  {!a.acknowledgedAt && (
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" className="h-7" onClick={() => act("acknowledge", a.alertId)}>
                        <Check className="h-3 w-3 mr-1" /> Acknowledge
                      </Button>
                      <Button size="sm" variant="outline" className="h-7" onClick={() => act("snooze", a.alertId, { minutes: 10 })}>
                        <Clock className="h-3 w-3 mr-1" /> Snooze 10m
                      </Button>
                      <Button size="sm" variant="outline" className="h-7" onClick={() => act("dismiss", a.alertId)}>
                        <X className="h-3 w-3 mr-1" /> Dismiss
                      </Button>
                    </div>
                  )}
                  {actionError?.alertId === a.alertId && (
                    <p className="text-rose-400" role="alert" data-testid="alert-action-error">{actionError.message}</p>
                  )}
                </CardContent>
              </Card>
              );
            })}
          </div>}
    </div>
  );
}
