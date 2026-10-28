import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Trophy } from "lucide-react";

type Status = {
  config: { enabled: boolean; startingBalance: number; profitTarget: number; maxDailyDrawdownUsd: number; maxTotalDrawdownUsd: number; minTradingDays: number; maxLotSize: number; maxPositions: number; newsTradingAllowed: boolean; weekendHoldingAllowed: boolean; consistencyRulePctOfTotal: number };
  profitUsd: number; profitTargetProgress: number;
  dailyDrawdownRemainingUsd: number; totalDrawdownRemainingUsd: number;
  passed: string[]; failed: string[]; status: "OFF" | "ACTIVE" | "WARNING" | "FAILED" | "PASSED";
  /** False while the mode is off: no rule was checked. Older servers omit it. */
  rulesEvaluated?: boolean;
  /** Rules not checked because the paper equity could not be read. */
  notEvaluated?: string[];
  equityMeasured?: boolean;
};
type NumericKey = "startingBalance" | "profitTarget" | "maxDailyDrawdownUsd" | "maxTotalDrawdownUsd" | "minTradingDays" | "maxLotSize" | "maxPositions" | "consistencyRulePctOfTotal";
const STATUS_COLOR: Record<string, string> = { OFF: "bg-muted text-muted-foreground", ACTIVE: "bg-blue-500/20 text-blue-400", WARNING: "bg-amber-500/20 text-amber-400", FAILED: "bg-rose-500/20 text-rose-400", PASSED: "bg-emerald-500/20 text-emerald-400" };

// A failed request throws with the server's reason (or the HTTP status), so a
// failed save or read is never silent and an error body is never read as data.
async function api(path: string, init?: RequestInit): Promise<unknown> {
  const r = await fetch(path, { credentials: "include", headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, ...init });
  let body: unknown = null;
  try { body = await r.json(); } catch { body = null; }
  if (!r.ok) {
    const reason = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : null;
    throw new Error(reason ? `${reason} (HTTP ${r.status})` : `HTTP ${r.status}`);
  }
  return body;
}
function isStatus(v: unknown): v is Status {
  return !!v && typeof v === "object" && !!(v as Status).config && typeof (v as Status).config === "object"
    && Array.isArray((v as Status).passed) && Array.isArray((v as Status).failed);
}
const timeOf = (ms: number) => new Date(ms).toLocaleTimeString();

export default function PropFirmMode() {
  const [s, setS] = useState<Status | null>(null);
  const [edit, setEdit] = useState<Partial<Status["config"]>>({});
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<{ at: number; message: string } | null>(null);
  const [actionResult, setActionResult] = useState<{ ok: boolean; text: string } | null>(null);
  async function load() {
    try {
      const st = await api("/api/prop-firm/status");
      if (!isStatus(st)) throw new Error("unexpected response");
      setS(st); setLoadedAt(Date.now()); setLoadError(null);
    } catch (e) {
      setLoadError({ at: Date.now(), message: (e as Error).message });
    }
  }
  useEffect(() => { void load(); const id = setInterval(load, 4000); return () => clearInterval(id); }, []);

  async function run(what: string, path: string, body?: unknown) {
    try {
      await api(path, { method: "POST", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      setActionResult({ ok: true, text: `${what}: done.` });
    } catch (e) {
      setActionResult({ ok: false, text: `${what} failed: ${(e as Error).message}. The values shown are what the server last reported.` });
    }
    void load();
  }
  const save = () => run("Save & enable", "/api/prop-firm/configure", { enabled: true, ...edit });
  // POST /prop-firm/reset turns the mode on with the values already saved; it
  // does not reset any value, so the button says what it does.
  const enableSaved = () => run("Turn on with saved values", "/api/prop-firm/reset");
  const disable = () => run("Disable mode", "/api/prop-firm/configure", { enabled: false });
  // A cleared field is "no change", never 0 (Number("") is 0, which the server rejects).
  const setNum = (key: NumericKey, raw: string) => {
    const next = { ...edit };
    if (raw.trim() === "" || !Number.isFinite(Number(raw))) delete next[key];
    else next[key] = Number(raw);
    setEdit(next);
  };
  const rulesOff = s != null && (s.rulesEvaluated === false || s.status === "OFF");
  const unmeasured = s?.equityMeasured === false;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Trophy className="h-6 w-6 text-primary" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Prop Firm Challenge Mode</h1>
          {/* Progress is read from the paper ledger, but saving writes the caps
              into user_risk_settings, which the venue-agnostic Risk Governor
              applies to paper, demo and live orders alike. */}
          <p className="text-sm text-muted-foreground" data-testid="prop-firm-scope">Practise a prop-firm challenge. Progress is measured on your paper account only. Saving also writes the daily loss, total drawdown, lot size and open-position caps into your own risk limits. The Risk Governor applies those limits to every order you place on every venue, including demo and live broker orders. Turning the mode off keeps those limits until you change them.</p>
        </div>
        <Badge variant="outline" title="Profit, drawdown and rule progress are read from your paper account.">Progress: PAPER</Badge>
        <Badge variant="outline" className="border-amber-500/50 text-amber-500" title="Saved caps apply to paper, demo and live orders.">Limits: ALL VENUES</Badge>
        {s && <Badge className={STATUS_COLOR[s.status]}>{s.status}</Badge>}
      </div>

      {!s && loadError && (
        <Card className="border-destructive/40" data-testid="prop-firm-load-error">
          <CardContent className="py-4 space-y-2">
            <p className="text-sm">Prop firm status could not be loaded ({loadError.message}). No values are shown because none were read.</p>
            <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
          </CardContent>
        </Card>
      )}
      {s && loadError && (
        <p className="text-xs text-destructive" data-testid="prop-firm-stale">
          Status could not be refreshed at {timeOf(loadError.at)} ({loadError.message}). These values are not current: they were last loaded{loadedAt ? ` at ${timeOf(loadedAt)}` : " earlier"}.
        </p>
      )}
      {actionResult && (
        <p className={`text-xs ${actionResult.ok ? "text-muted-foreground" : "text-destructive"}`} data-testid="prop-firm-action-result">{actionResult.text}</p>
      )}

      {s && (
        <div className="grid gap-2 md:grid-cols-4">
          <Stat label="Enabled" value={s.config.enabled ? "YES" : "NO"} />
          <Stat label="Profit USD" value={unmeasured ? "Not measured" : `$${s.profitUsd}`} />
          <Stat label="Target progress" value={unmeasured ? "Not measured" : `${s.profitTargetProgress}%`} />
          <Stat label="Daily DD left" value={`$${s.dailyDrawdownRemainingUsd}`} />
          <Stat label="Total DD left" value={unmeasured ? "Not measured" : `$${s.totalDrawdownRemainingUsd}`} />
          <Stat label="Passed rules" value={String(s.passed.length)} />
          <Stat label="Failed rules" value={String(s.failed.length)} />
          <Stat label="Account status" value={s.status} />
        </div>
      )}

      {s && (
        <Card>
          <CardHeader><CardTitle className="text-base">Configure</CardTitle><CardDescription>Defaults reflect a typical $100k challenge. Saving or turning the mode on changes your risk limits for paper, demo and live orders.</CardDescription></CardHeader>
          <CardContent className="grid gap-2 md:grid-cols-3">
            <Input type="number" placeholder={`Starting balance (${s.config.startingBalance})`} onChange={(e) => setNum("startingBalance", e.target.value)} />
            <Input type="number" placeholder={`Profit target (${s.config.profitTarget})`} onChange={(e) => setNum("profitTarget", e.target.value)} />
            <Input type="number" placeholder={`Max daily DD (${s.config.maxDailyDrawdownUsd})`} onChange={(e) => setNum("maxDailyDrawdownUsd", e.target.value)} />
            <Input type="number" placeholder={`Max total DD (${s.config.maxTotalDrawdownUsd})`} onChange={(e) => setNum("maxTotalDrawdownUsd", e.target.value)} />
            <Input type="number" placeholder={`Min trading days (${s.config.minTradingDays})`} onChange={(e) => setNum("minTradingDays", e.target.value)} />
            <Input type="number" placeholder={`Max lot size (${s.config.maxLotSize})`} onChange={(e) => setNum("maxLotSize", e.target.value)} />
            <Input type="number" placeholder={`Max positions (${s.config.maxPositions})`} onChange={(e) => setNum("maxPositions", e.target.value)} />
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" defaultChecked={s.config.newsTradingAllowed} onChange={(e) => setEdit({ ...edit, newsTradingAllowed: e.target.checked })} />News trading allowed</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" defaultChecked={s.config.weekendHoldingAllowed} onChange={(e) => setEdit({ ...edit, weekendHoldingAllowed: e.target.checked })} />Weekend holding</label>
            <Input type="number" placeholder={`Consistency rule % (${s.config.consistencyRulePctOfTotal})`} onChange={(e) => setNum("consistencyRulePctOfTotal", e.target.value)} />
            <div className="md:col-span-3 flex gap-2">
              <Button onClick={save}>Save & enable</Button>
              <Button variant="outline" onClick={enableSaved} title="Turns the mode on with the values already saved. It does not reset any value.">Turn on with saved values</Button>
              <Button variant="ghost" onClick={disable}>Disable mode</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {s && (
        <Card>
          <CardHeader><CardTitle className="text-base">Rule status</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap gap-1" data-testid="prop-firm-rules">
            {rulesOff ? (
              <p className="text-sm text-muted-foreground">Rules are not checked while the mode is off.</p>
            ) : (
              <>
                {s.passed.map((p) => <Badge key={p} className="bg-emerald-500/20 text-emerald-400">✓ {p}</Badge>)}
                {s.failed.map((f) => <Badge key={f} variant="destructive">✗ {f}</Badge>)}
                {(s.notEvaluated ?? []).map((n) => <Badge key={n} variant="outline">{n}: not checked (paper equity could not be read)</Badge>)}
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <Card><CardContent className="p-2"><p className="text-[10px] text-muted-foreground uppercase">{label}</p><p className="text-sm font-mono font-semibold">{value}</p></CardContent></Card>;
}
