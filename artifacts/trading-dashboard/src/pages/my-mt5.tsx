// Phase 3D — Per-user MT5 connection panel + trading sessions panel.
// Uses direct fetch (no codegen) for minimal-scope per-user endpoints.
// Token is shown ONCE on create/regenerate and never persisted in state
// after the user dismisses the dialog.
import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { Copy, Lock, Plus, RefreshCw, Send, ShieldAlert, Trash2, X } from "lucide-react";

type Mt5Conn = {
  id: number;
  connectionName: string | null;
  status: string;
  broker: string | null;
  server: string | null;
  account: string | null;
  accountCurrency: string | null;
  balance: number | null;
  equity: number | null;
  margin: number | null;
  freeMargin: number | null;
  marginLevelPercent: number | null;
  leverage: number | null;
  accountType: string | null;
  accountSnapshotFresh: boolean;
  lastHeartbeatAt: string | null;
  heartbeatAgeSeconds: number | null;
  tokenLast4: string | null;
  tokenCreatedAt: string | null;
  tokenRevokedAt: string | null;
  readOnlyMode: boolean;
  allowOrderExecution: boolean;
  liveLocked: boolean;
};
type Session = {
  id: number;
  title: string;
  mode: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  startingBalance: number | null;
  endingBalance: number | null;
  pnl: number | null;
  winCount: number;
  lossCount: number;
  notes: string | null;
  linkedMt5ConnectionId: number | null;
};

const BASE = `${import.meta.env.BASE_URL ?? "/"}api`;
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

const STATUS_COLOR: Record<string, string> = {
  connected: "bg-success/15 text-success border-success/40",
  waiting: "bg-warning/15 text-warning border-warning/40",
  stale: "bg-warning/15 text-warning border-warning/40",
  disconnected: "bg-secondary/15 text-txt-secondary border-border",
  revoked: "bg-danger/15 text-danger border-danger/40",
};

// Phase 4E — Per-connection safe commands panel.
type Mt5CommandRow = {
  id: number;
  mt5ConnectionId: number | null;
  action: string;
  status: string;
  safetyMode: string;
  detail: string | null;
  errorMessage: string | null;
  resultPayload: unknown;
  createdAt: string | null;
  deliveredAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
};
const CMD_STATUS_COLOR: Record<string, string> = {
  PENDING: "bg-warning/15 text-warning border-warning/40",
  DELIVERED: "bg-primary/15 text-primary border-primary/40",
  completed: "bg-success/15 text-success border-success/40",
  failed: "bg-danger/15 text-danger border-danger/40",
  cancelled: "bg-secondary/15 text-txt-secondary border-border",
};
function CommandsPanel({ conn }: { conn: Mt5Conn }) {
  const { toast } = useToast();
  const [cmds, setCmds] = useState<Mt5CommandRow[]>([]);
  const [busy, setBusy] = useState(false);
  const heartbeatOk = conn.heartbeatAgeSeconds != null && conn.heartbeatAgeSeconds < 90;
  const revoked = !!conn.tokenRevokedAt;
  async function load() {
    try {
      const r = await api<{ commands: Mt5CommandRow[] }>(`/me/mt5-connections/${conn.id}/commands`);
      setCmds(r.commands);
    } catch (e) { /* swallow polling errors */ void e; }
  }
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [conn.id]);
  async function send(action: string) {
    if (revoked) { toast({ title: "Token revoked", description: "Regenerate a token to send commands.", variant: "destructive" }); return; }
    setBusy(true);
    try {
      await api(`/me/mt5-connections/${conn.id}/commands`, { method: "POST", body: JSON.stringify({ action }) });
      await load();
    } catch (e) { toast({ title: "Send failed", description: String(e), variant: "destructive" }); }
    finally { setBusy(false); }
  }
  async function cancel(id: number) {
    try { await api(`/me/mt5-commands/${id}/cancel`, { method: "POST", body: "{}" }); await load(); }
    catch (e) { toast({ title: "Cancel failed", description: String(e), variant: "destructive" }); }
  }
  return (
    <div className="border-t pt-3 mt-3 space-y-2">
      <div className="text-sm font-medium">Safe commands (demo / read-only)</div>
      {!heartbeatOk && !revoked && (
        <div className="text-xs text-warning">Waiting for MT5 heartbeat before commands can be delivered.</div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy || revoked} onClick={() => send("PING")}>
          <Send className="h-3 w-3 mr-1" />Send safe test command
        </Button>
        <Button size="sm" variant="outline" disabled={busy || revoked} onClick={() => send("ACCOUNT_SNAPSHOT_REQUEST")}>
          Request account snapshot
        </Button>
        <Button size="sm" variant="outline" disabled={busy || revoked} onClick={() => send("POSITIONS_SNAPSHOT_REQUEST")}>
          Request positions snapshot
        </Button>
      </div>
      {cmds.length === 0 ? (
        <div className="text-xs text-muted-foreground">No commands yet for this connection.</div>
      ) : (
        <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
          {cmds.slice(0, 20).map((c) => (
            <div key={c.id} className="flex items-center justify-between text-xs border rounded px-2 py-1">
              <div className="flex items-center gap-2 min-w-0">
                <Badge variant="outline" className={CMD_STATUS_COLOR[c.status] ?? ""}>{c.status}</Badge>
                <span className="font-mono">#{c.id}</span>
                <span className="font-medium">{c.action}</span>
                <span className="text-muted-foreground">[{c.safetyMode}]</span>
                {c.detail && <span className="text-muted-foreground truncate">— {c.detail}</span>}
                {c.errorMessage && <span className="text-danger truncate">err: {c.errorMessage}</span>}
              </div>
              {c.status === "PENDING" && (
                <Button size="sm" variant="ghost" onClick={() => cancel(c.id)} title="Cancel"><X className="h-3 w-3" /></Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function MyMt5Page() {
  const { toast } = useToast();
  const [conns, setConns] = useState<Mt5Conn[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [creatingConn, setCreatingConn] = useState(false);
  const [newConnName, setNewConnName] = useState("");
  const [revealedToken, setRevealedToken] = useState<{ raw: string; connId: number } | null>(null);
  const [creatingSession, setCreatingSession] = useState(false);
  const [newSessTitle, setNewSessTitle] = useState("");
  const [newSessMode, setNewSessMode] = useState("paper");
  const [newSessBalance, setNewSessBalance] = useState("");
  const [newSessLink, setNewSessLink] = useState<string>("");

  async function refresh() {
    setLoading(true);
    try {
      const [c, s] = await Promise.all([
        api<{ connections: Mt5Conn[] }>("/me/mt5-connections"),
        api<{ sessions: Session[] }>("/me/trading-sessions"),
      ]);
      setConns(c.connections);
      setSessions(s.sessions);
    } catch (e) {
      toast({ title: "Failed to load", description: String(e), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t); }, []);

  async function createConnection() {
    if (!newConnName.trim()) return;
    try {
      const r = await api<Mt5Conn & { rawToken: string }>("/me/mt5-connections", {
        method: "POST", body: JSON.stringify({ connectionName: newConnName.trim() }),
      });
      setRevealedToken({ raw: r.rawToken, connId: r.id });
      setCreatingConn(false);
      setNewConnName("");
      await refresh();
    } catch (e) {
      toast({ title: "Create failed", description: String(e), variant: "destructive" });
    }
  }
  async function regenerate(id: number) {
    if (!confirm("Regenerate the bridge token? The old token will stop working immediately.")) return;
    try {
      const r = await api<Mt5Conn & { rawToken: string }>(`/me/mt5-connections/${id}/regenerate-token`, { method: "POST" });
      setRevealedToken({ raw: r.rawToken, connId: r.id });
      await refresh();
    } catch (e) {
      toast({ title: "Regenerate failed", description: String(e), variant: "destructive" });
    }
  }
  async function revoke(id: number) {
    if (!confirm("Revoke this connection? The token will stop accepting heartbeats.")) return;
    try { await api(`/me/mt5-connections/${id}/revoke`, { method: "POST" }); await refresh(); }
    catch (e) { toast({ title: "Revoke failed", description: String(e), variant: "destructive" }); }
  }
  async function deleteConn(id: number) {
    if (!confirm("Delete this connection? (Soft-delete: revoked and hidden.)")) return;
    try { await api(`/me/mt5-connections/${id}`, { method: "DELETE" }); await refresh(); }
    catch (e) { toast({ title: "Delete failed", description: String(e), variant: "destructive" }); }
  }
  async function createSession() {
    if (!newSessTitle.trim()) return;
    try {
      const body: Record<string, unknown> = { title: newSessTitle.trim(), mode: newSessMode };
      if (newSessBalance) body.startingBalance = Number(newSessBalance);
      if (newSessLink) body.linkedMt5ConnectionId = Number(newSessLink);
      await api("/me/trading-sessions", { method: "POST", body: JSON.stringify(body) });
      setCreatingSession(false); setNewSessTitle(""); setNewSessBalance(""); setNewSessLink("");
      await refresh();
    } catch (e) {
      toast({ title: "Create session failed", description: String(e), variant: "destructive" });
    }
  }
  async function closeSession(id: number) {
    if (!confirm("Close this session?")) return;
    try { await api(`/me/trading-sessions/${id}/close`, { method: "POST", body: "{}" }); await refresh(); }
    catch (e) { toast({ title: "Close failed", description: String(e), variant: "destructive" }); }
  }

  const activeConns = conns.filter((c) => c.status !== "revoked");
  const baseOrigin = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <div className="container mx-auto py-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">My MT5 & Trading Sessions</h1>
        <p className="text-muted-foreground">Personal connections and sessions. Only you can see this data.</p>
      </div>

      <Alert>
        <Lock className="h-4 w-4" />
        <AlertTitle>Read-only mode is active</AlertTitle>
        <AlertDescription>
          live_locked = true · read_only_mode = true · allow_order_execution = false. No real orders will be placed
          even if MT5 is connected.
        </AlertDescription>
      </Alert>

      {/* MT5 connections */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>MT5 Connections</CardTitle>
            <CardDescription>Each connection has its own bridge token. Token is shown once.</CardDescription>
          </div>
          <Button onClick={() => setCreatingConn(true)}><Plus className="h-4 w-4 mr-1" /> Create MT5 connection</Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading && <div className="text-sm text-muted-foreground">Loading…</div>}
          {!loading && activeConns.length === 0 && (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <ShieldAlert className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
              <p className="font-medium">No MT5 connection yet</p>
              <p className="text-sm text-muted-foreground">Create one to get a personal bridge token for your EA.</p>
            </div>
          )}
          {activeConns.map((c) => (
            <div key={c.id} className="border rounded-lg p-4 space-y-2">
              <div className="flex items-center justify-between">
                <div className="font-medium">{c.connectionName || `Connection #${c.id}`}</div>
                <Badge variant="outline" className={STATUS_COLOR[c.status] ?? ""}>{c.status}</Badge>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                <div><span className="text-muted-foreground">Broker:</span> {c.broker ?? "—"}</div>
                <div><span className="text-muted-foreground">Account:</span> {c.account ?? "—"}</div>
                <div><span className="text-muted-foreground">Type:</span> {c.accountType ?? "—"}</div>
                <div><span className="text-muted-foreground">Server:</span> {c.server ?? "—"}</div>
                <div><span className="text-muted-foreground">Balance:</span> {c.balance != null ? `${Number(c.balance).toFixed(2)} ${c.accountCurrency ?? ""}`.trim() : "—"}</div>
                <div><span className="text-muted-foreground">Equity:</span> {c.equity != null ? `${Number(c.equity).toFixed(2)} ${c.accountCurrency ?? ""}`.trim() : "—"}</div>
                <div><span className="text-muted-foreground">Free margin:</span> {c.freeMargin != null ? `${Number(c.freeMargin).toFixed(2)} ${c.accountCurrency ?? ""}`.trim() : "—"}</div>
                <div><span className="text-muted-foreground">Margin used:</span> {c.margin != null ? `${Number(c.margin).toFixed(2)} ${c.accountCurrency ?? ""}`.trim() : "—"}</div>
                <div><span className="text-muted-foreground">Margin level:</span> {c.marginLevelPercent != null ? `${c.marginLevelPercent.toFixed(1)}%` : "—"}</div>
                <div><span className="text-muted-foreground">Snapshot:</span> {c.accountSnapshotFresh ? <span className="text-success">fresh</span> : <span className="text-warning">stale</span>}</div>
                <div><span className="text-muted-foreground">Last heartbeat:</span> {c.heartbeatAgeSeconds != null ? `${c.heartbeatAgeSeconds}s ago` : "never"}</div>
                <div><span className="text-muted-foreground">Token …{c.tokenLast4 ?? "?"}</span></div>
              </div>
              <div className="text-xs text-muted-foreground">ServerBaseUrl for EA: <code>{baseOrigin}/api</code> · Endpoint: <code>POST /api/mt5/heartbeat</code> · Header: <code>X-MT5-Bridge-Token: &lt;your token&gt;</code></div>
              <div className="flex gap-2 pt-1">
                <Button size="sm" variant="outline" onClick={() => regenerate(c.id)}><RefreshCw className="h-3 w-3 mr-1" />Regenerate token</Button>
                <Button size="sm" variant="outline" onClick={() => revoke(c.id)}>Revoke</Button>
                <Button size="sm" variant="ghost" onClick={() => deleteConn(c.id)}><Trash2 className="h-3 w-3" /></Button>
              </div>
              <CommandsPanel conn={c} />
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Sessions */}
      {/* (CommandsPanel rendered above per connection.) */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Trading Sessions</CardTitle>
            <CardDescription>Your personal demo sessions.</CardDescription>
          </div>
          <Button onClick={() => setCreatingSession(true)}><Plus className="h-4 w-4 mr-1" /> Start a demo session</Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {!loading && sessions.length === 0 && (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <p className="font-medium">No trading sessions yet</p>
              <p className="text-sm text-muted-foreground">Start a demo session to track your practice runs.</p>
              <p className="text-sm text-muted-foreground mt-1">Connect MT5 when you're ready.</p>
            </div>
          )}
          {sessions.map((s) => (
            <div key={s.id} className="border rounded-lg p-4 flex items-center justify-between">
              <div>
                <div className="font-medium">{s.title}</div>
                <div className="text-xs text-muted-foreground">
                  {(s.mode === "paper" ? "demo" : s.mode)} · {s.status} · started {s.startedAt ? new Date(s.startedAt).toLocaleString() : "—"}
                  {s.endedAt && ` · ended ${new Date(s.endedAt).toLocaleString()}`}
                  {s.linkedMt5ConnectionId != null && ` · linked to MT5 #${s.linkedMt5ConnectionId}`}
                </div>
                <div className="text-xs text-muted-foreground">PnL: {s.pnl ?? 0} · W/L: {s.winCount}/{s.lossCount}</div>
              </div>
              {s.status !== "closed" && (
                <Button size="sm" variant="outline" onClick={() => closeSession(s.id)}>Close session</Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Create connection dialog */}
      <Dialog open={creatingConn} onOpenChange={setCreatingConn}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create MT5 connection</DialogTitle>
            <DialogDescription>You will receive a bridge token. Save it — it's shown only once.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="cn">Connection name</Label>
            <Input id="cn" value={newConnName} onChange={(e) => setNewConnName(e.target.value)} placeholder="e.g. Demo MT5 — Laptop" />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreatingConn(false)}>Cancel</Button>
            <Button onClick={createConnection} disabled={!newConnName.trim()}>Generate bridge token</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Token reveal dialog (shown ONCE) */}
      <Dialog open={!!revealedToken} onOpenChange={(o) => !o && setRevealedToken(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Bridge token — shown once</DialogTitle>
            <DialogDescription>
              Copy and paste this token into your MT5 EA's <code>BridgeToken</code> input. It will not be shown again.
            </DialogDescription>
          </DialogHeader>
          {revealedToken && (
            <div className="space-y-3">
              <div className="font-mono text-sm bg-muted p-3 rounded break-all">{revealedToken.raw}</div>
              <Button onClick={() => { navigator.clipboard.writeText(revealedToken.raw); toast({ title: "Copied" }); }}>
                <Copy className="h-3 w-3 mr-1" /> Copy token
              </Button>
              <Alert>
                <AlertDescription>
                  EA setup: <code>BridgeToken</code> = above value · <code>ServerBaseUrl</code> = <code>{baseOrigin}/api</code>
                </AlertDescription>
              </Alert>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setRevealedToken(null)}>I've saved it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create session dialog */}
      <Dialog open={creatingSession} onOpenChange={setCreatingSession}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start a demo session</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div><Label>Title</Label><Input value={newSessTitle} onChange={(e) => setNewSessTitle(e.target.value)} placeholder="Morning warm-up" /></div>
            <div><Label>Mode</Label>
              <select className="w-full border rounded px-2 py-1 bg-background" value={newSessMode} onChange={(e) => setNewSessMode(e.target.value)}>
                <option value="paper">demo</option>
                <option value="demo">demo</option>
                <option value="live_locked">live_locked</option>
              </select>
            </div>
            <div><Label>Starting balance (optional)</Label><Input type="number" value={newSessBalance} onChange={(e) => setNewSessBalance(e.target.value)} /></div>
            {activeConns.length > 0 && (
              <div><Label>Link to MT5 connection (optional)</Label>
                <select className="w-full border rounded px-2 py-1 bg-background" value={newSessLink} onChange={(e) => setNewSessLink(e.target.value)}>
                  <option value="">— none —</option>
                  {activeConns.map((c) => <option key={c.id} value={c.id}>{c.connectionName || `#${c.id}`}</option>)}
                </select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreatingSession(false)}>Cancel</Button>
            <Button onClick={createSession} disabled={!newSessTitle.trim()}>Start session</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
