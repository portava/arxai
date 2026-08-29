import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Download, Eye, FileJson, FileSpreadsheet, Filter, ShieldCheck } from "lucide-react";

interface NormalizedEvent {
  eventId: string;
  category: "ADMIN" | "TRADE" | "LIVE" | "SYSTEM";
  eventType: string;
  severity: string;
  actorUserId: number | null;
  actorRole: string | null;
  targetUserId: number | null;
  symbol: string | null;
  result: string | null;
  reason: string | null;
  createdAt: string;
  sourceTable: string;
}

interface CenterResponse {
  ok: boolean;
  count: number;
  categories: string[];
  events: NormalizedEvent[];
}

interface PoolView {
  id: number;
  adminId: number | null;
  adminEmail: string | null;
  adminRole: string;
  ipAddress: string | null;
  createdAt: string;
}

interface PoolViewsResponse {
  ok: boolean;
  count: number;
  limit: number;
  dedupe: boolean;
  from: string | null;
  to: string | null;
  views: PoolView[];
}

interface MeAlert {
  id: number;
  alertType: string;
  severity: string;
  title: string;
  message: string;
  status: string;
  createdAt: string;
}

interface AlertsResponse {
  alerts: MeAlert[];
  unread: number;
  isEmpty: boolean;
}

async function apiGet<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

function severityBadge(s: string) {
  const color =
    s === "CRITICAL" ? "destructive" :
    s === "HIGH" || s === "WARNING" ? "default" :
    "secondary";
  return <Badge variant={color as never}>{s}</Badge>;
}

function categoryBadge(c: string) {
  return <Badge variant="outline" data-testid={`badge-cat-${c.toLowerCase()}`}>{c}</Badge>;
}

export default function AuditCenterPage() {
  const [category, setCategory] = useState<string>("ALL");
  const [eventType, setEventType] = useState<string>("");
  const [symbol, setSymbol] = useState<string>("");
  const [severity, setSeverity] = useState<string>("ALL");
  const [poolFrom, setPoolFrom] = useState<string>("");
  const [poolTo, setPoolTo] = useState<string>("");
  const [poolDedupe, setPoolDedupe] = useState<boolean>(false);

  const queryString = useMemo(() => {
    const p = new URLSearchParams({ limit: "200" });
    if (category !== "ALL") p.set("category", category);
    if (eventType) p.set("eventType", eventType);
    if (symbol) p.set("symbol", symbol);
    if (severity !== "ALL") p.set("severity", severity);
    return p.toString();
  }, [category, eventType, symbol, severity]);

  const { data, isLoading, error, refetch } = useQuery<CenterResponse>({
    queryKey: ["audit-center", queryString],
    queryFn: () => apiGet<CenterResponse>(`/api/admin/audit/center?${queryString}`),
    refetchInterval: 30_000,
  });

  const poolQueryString = useMemo(() => {
    const p = new URLSearchParams({ limit: "50" });
    if (poolFrom) {
      const d = new Date(poolFrom);
      if (!isNaN(d.getTime())) p.set("from", d.toISOString());
    }
    if (poolTo) {
      const d = new Date(poolTo);
      if (!isNaN(d.getTime())) p.set("to", d.toISOString());
    }
    if (poolDedupe) p.set("dedupe", "1");
    return p.toString();
  }, [poolFrom, poolTo, poolDedupe]);

  const {
    data: poolData,
    isLoading: poolLoading,
    error: poolError,
    refetch: refetchPool,
  } = useQuery<PoolViewsResponse>({
    queryKey: ["audit-pool-views", poolQueryString],
    queryFn: () => apiGet<PoolViewsResponse>(`/api/admin/audit/pool-views?${poolQueryString}`),
    refetchInterval: 60_000,
  });

  // Surface any unreviewed Shared Bridge Pool security alerts inline. The
  // anomaly detector writes these into the admin's own alerts feed; this
  // banner just mirrors them at the top of the page so an operator who is
  // already here doesn't have to open the bell drawer.
  const { data: alertsData } = useQuery<AlertsResponse>({
    queryKey: ["audit-pool-alerts"],
    queryFn: () => apiGet<AlertsResponse>(`/api/me/alerts?status=unread`),
    refetchInterval: 60_000,
  });
  const poolAlerts = useMemo(
    () =>
      (alertsData?.alerts ?? []).filter(
        (a) =>
          a.status === "unread" &&
          (a.alertType.startsWith("pool_view_new_origin") ||
            a.alertType.startsWith("pool_view_burst")),
      ),
    [alertsData],
  );

  function downloadExport(format: "json" | "csv") {
    window.location.href = `/api/admin/audit/export?format=${format}&${queryString}`;
  }

  function downloadPoolExport(format: "json" | "csv") {
    window.location.href = `/api/admin/audit/pool-views/export?format=${format}&${poolQueryString}`;
  }

  return (
    <div className="mx-auto w-full max-w-[1280px] pb-32 md:pb-6 space-y-5" data-testid="page-audit-center">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShieldCheck className="w-6 h-6" />
            Audit Log Center
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Admin-only unified view across admin actions, trade lifecycle, live trading events,
            and system events. All output is masked through the bridge-evidence redaction
            chokepoint. Internal evidence — not a legal or regulatory certification.
          </p>
        </div>
      </div>

      {poolAlerts.length > 0 && (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 p-4 space-y-2"
          data-testid="banner-pool-alerts"
        >
          <div className="flex items-center gap-2 font-semibold text-destructive">
            <ShieldCheck className="w-4 h-4" />
            {poolAlerts.length === 1
              ? "Unreviewed Shared Bridge Pool security alert"
              : `${poolAlerts.length} unreviewed Shared Bridge Pool security alerts`}
          </div>
          <ul className="space-y-1 text-sm">
            {poolAlerts.slice(0, 5).map((a) => (
              <li key={a.id} className="flex items-start gap-2">
                <Badge variant={a.severity === "critical" ? "destructive" : "default"}>
                  {a.severity.toUpperCase()}
                </Badge>
                <span>
                  <span className="font-medium">{a.title}</span>
                  {a.message ? <span className="text-muted-foreground"> — {a.message}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Filter className="w-4 h-4" /> Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">Category</label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger data-testid="select-category"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All</SelectItem>
                  <SelectItem value="ADMIN">Admin actions</SelectItem>
                  <SelectItem value="TRADE">Trade lifecycle</SelectItem>
                  <SelectItem value="LIVE">Live trading</SelectItem>
                  <SelectItem value="SYSTEM">System events</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Severity</label>
              <Select value={severity} onValueChange={setSeverity}>
                <SelectTrigger data-testid="select-severity"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All</SelectItem>
                  <SelectItem value="INFO">INFO</SelectItem>
                  <SelectItem value="WARNING">WARNING</SelectItem>
                  <SelectItem value="HIGH">HIGH</SelectItem>
                  <SelectItem value="CRITICAL">CRITICAL</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Event type contains</label>
              <Input
                value={eventType}
                onChange={(e) => setEventType(e.target.value)}
                placeholder="e.g. ENGAGE_KILL_SWITCH"
                data-testid="input-event-type"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Symbol</label>
              <Input
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                placeholder="e.g. EURUSD"
                data-testid="input-symbol"
              />
            </div>
            <div className="flex items-end gap-2">
              <Button onClick={() => refetch()} variant="outline" data-testid="button-refresh">
                Refresh
              </Button>
            </div>
          </div>

          <div className="flex gap-2 mt-4">
            <Button onClick={() => downloadExport("json")} size="sm" data-testid="button-export-json">
              <FileJson className="w-4 h-4 mr-1" /> Export JSON
            </Button>
            <Button onClick={() => downloadExport("csv")} size="sm" variant="outline" data-testid="button-export-csv">
              <FileSpreadsheet className="w-4 h-4 mr-1" /> Export CSV
            </Button>
            <span className="ml-auto text-xs text-muted-foreground self-center">
              <Download className="inline w-3 h-3 mr-1" />
              Exports include exportId, adminId, filters, eventCount, SHA-256 checksum, and disclaimer.
            </span>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="card-pool-views">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Eye className="w-4 h-4" />
            Recent Shared Bridge Pool views
            {poolData ? (
              <span className="text-muted-foreground text-sm font-normal">
                ({poolData.count})
              </span>
            ) : null}
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Every time an admin opens the Shared Bridge Pool view, an
            <span className="font-mono"> ALLOCATION_POOL_VIEWED </span>
            row is appended to the admin audit log. This panel surfaces
            those rows for incident review — no SQL needed.
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3 mb-3">
            <div>
              <label className="text-xs text-muted-foreground">From</label>
              <Input
                type="datetime-local"
                value={poolFrom}
                onChange={(e) => setPoolFrom(e.target.value)}
                data-testid="input-pool-from"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">To</label>
              <Input
                type="datetime-local"
                value={poolTo}
                onChange={(e) => setPoolTo(e.target.value)}
                data-testid="input-pool-to"
              />
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={poolDedupe}
                  onChange={(e) => setPoolDedupe(e.target.checked)}
                  data-testid="checkbox-pool-dedupe"
                />
                Dedupe per admin (most recent only)
              </label>
            </div>
            <div className="flex items-end gap-2">
              <Button
                onClick={() => refetchPool()}
                variant="outline"
                size="sm"
                data-testid="button-pool-refresh"
              >
                Refresh
              </Button>
              {(poolFrom || poolTo || poolDedupe) && (
                <Button
                  onClick={() => { setPoolFrom(""); setPoolTo(""); setPoolDedupe(false); }}
                  variant="ghost"
                  size="sm"
                  data-testid="button-pool-clear"
                >
                  Clear
                </Button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 mb-3">
            <Button
              onClick={() => downloadPoolExport("json")}
              size="sm"
              data-testid="button-pool-export-json"
            >
              <FileJson className="w-4 h-4 mr-1" /> Export JSON
            </Button>
            <Button
              onClick={() => downloadPoolExport("csv")}
              size="sm"
              variant="outline"
              data-testid="button-pool-export-csv"
            >
              <FileSpreadsheet className="w-4 h-4 mr-1" /> Export CSV
            </Button>
            <span className="ml-auto text-xs text-muted-foreground self-center">
              <Download className="inline w-3 h-3 mr-1" />
              Honours the from/to/dedupe filters above. Includes exportId, adminId, filters,
              eventCount, SHA-256 checksum, and disclaimer.
            </span>
          </div>

          {poolLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
          {poolError && (
            <div className="text-sm text-destructive" data-testid="text-pool-error">
              Failed to load pool view history.
            </div>
          )}
          {poolData && (
            <div className="overflow-x-auto" data-testid="table-pool-views">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground uppercase">
                    <th className="py-2 pr-4">Time</th>
                    <th className="py-2 pr-4">Admin</th>
                    <th className="py-2 pr-4">Role</th>
                    <th className="py-2 pr-4">IP</th>
                  </tr>
                </thead>
                <tbody>
                  {poolData.views.map((v) => (
                    <tr
                      key={v.id}
                      className="border-b hover:bg-muted/30"
                      data-testid={`row-pool-view-${v.id}`}
                    >
                      <td className="py-2 pr-4 font-mono text-xs">
                        {new Date(v.createdAt).toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 text-xs">
                        <span>{v.adminEmail ?? "—"}</span>
                        {v.adminId !== null ? (
                          <span className="ml-1 text-muted-foreground">#{v.adminId}</span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-4 text-xs">
                        <Badge variant="outline">{v.adminRole}</Badge>
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs">
                        {v.ipAddress ?? "—"}
                      </td>
                    </tr>
                  ))}
                  {poolData.views.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-6 text-center text-muted-foreground text-sm">
                        No pool views recorded in this range.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Events {data ? <span className="text-muted-foreground text-sm font-normal">({data.count})</span> : null}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
          {error && <div className="text-sm text-destructive" data-testid="text-error">Failed to load audit events.</div>}
          {data && (
            <div className="overflow-x-auto" data-testid="table-events">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground uppercase">
                    <th className="py-2 pr-4">Time</th>
                    <th className="py-2 pr-4">Category</th>
                    <th className="py-2 pr-4">Event</th>
                    <th className="py-2 pr-4">Severity</th>
                    <th className="py-2 pr-4">Actor</th>
                    <th className="py-2 pr-4">Symbol</th>
                    <th className="py-2 pr-4">Result</th>
                    <th className="py-2 pr-4">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((e) => (
                    <tr key={e.eventId} className="border-b hover:bg-muted/30" data-testid={`row-event-${e.eventId}`}>
                      <td className="py-2 pr-4 font-mono text-xs">{new Date(e.createdAt).toLocaleString()}</td>
                      <td className="py-2 pr-4">{categoryBadge(e.category)}</td>
                      <td className="py-2 pr-4 font-mono text-xs">{e.eventType}</td>
                      <td className="py-2 pr-4">{severityBadge(e.severity)}</td>
                      <td className="py-2 pr-4 text-xs">
                        {e.actorRole ? <span className="text-muted-foreground">{e.actorRole}</span> : null}
                        {e.actorUserId !== null ? <span className="ml-1">#{e.actorUserId}</span> : null}
                      </td>
                      <td className="py-2 pr-4 text-xs">{e.symbol ?? "—"}</td>
                      <td className="py-2 pr-4 text-xs">{e.result ?? "—"}</td>
                      <td className="py-2 pr-4 text-xs max-w-md truncate" title={e.reason ?? ""}>
                        {e.reason ?? "—"}
                      </td>
                    </tr>
                  ))}
                  {data.events.length === 0 && (
                    <tr><td colSpan={8} className="py-6 text-center text-muted-foreground text-sm">No events match these filters.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
