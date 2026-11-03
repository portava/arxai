import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Trophy } from "lucide-react";

type Status = {
  config: { enabled: boolean; startingBalance: number; profitTarget: number; maxDailyDrawdownUsd: number; maxTotalDrawdownUsd: number; minTradingDays: number; maxLotSize: number; maxPositions: number; newsTradingAllowed: boolean; weekendHoldingAllowed: boolean; consistencyRulePctOfTotal: number };
  // null = not measured (e.g. no active paper account); never shown as $0.
  profitUsd: number | null; profitTargetProgress: number | null;
  dailyDrawdownRemainingUsd: number | null; totalDrawdownRemainingUsd: number | null;
  measured?: boolean; notMeasuredReason?: string | null;
  // What the figures are measured from: the paper account's last stored equity
  // mark, and its equity when the challenge started (turned on, or restarted).
  paperAccountId?: number | null; equityUsd?: number | null; equityAsOf?: string | null;
  challengeStartedAt?: string | null; startEquityUsd?: number | null; dailyDrawdownSince?: string | null;
  notes?: string[];
  passed: string[]; failed: string[]; notChecked?: Array<{ rule: string; reason: string }>;
  // TARGET_REACHED: profit target met, but some rules are not checked, so it
  // is not a confirmed pass.
  status: "OFF" | "NOT_MEASURED" | "ACTIVE" | "WARNING" | "FAILED" | "TARGET_REACHED" | "PASSED";
  /** False when no rule was checked (mode off, or nothing measured). Older servers omit it. */
  rulesEvaluated?: boolean;
  /** Rules not checked because they could not be measured (an older server: the paper equity could not be read). */
  notEvaluated?: string[];
  equityMeasured?: boolean;
};
type NumericKey = "startingBalance" | "profitTarget" | "maxDailyDrawdownUsd" | "maxTotalDrawdownUsd" | "minTradingDays" | "maxLotSize" | "maxPositions" | "consistencyRulePctOfTotal";
const STATUS_LABEL: Record<string, string> = { NOT_MEASURED: "NOT MEASURED", TARGET_REACHED: "TARGET REACHED" };
const STATUS_COLOR: Record<string, string> = { OFF: "bg-muted text-muted-foreground", NOT_MEASURED: "bg-amber-500/20 text-amber-400", TARGET_REACHED: "bg-blue-500/20 text-blue-400", ACTIVE: "bg-blue-500/20 text-blue-400", WARNING: "bg-amber-500/20 text-amber-400", FAILED: "bg-rose-500/20 text-rose-400", PASSED: "bg-emerald-500/20 text-emerald-400" };

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
  // POST /prop-firm/reset turns the mode on with the values already saved and
  // restarts the challenge (progress is measured again from the paper
  // account's equity now); no saved value is changed. The button says so.
  const enableSaved = () => run("Turn on with saved values", "/api/prop-firm/reset");
  const disable = () => run("Disable mode", "/api/prop-firm/configure", { enabled: false });
  // A cleared field is "no change", never 0 (Number("") is 0, which the server rejects).
  const setNum = (key: NumericKey, raw: string) => {
    const next = { ...edit };
    if (raw.trim() === "" || !Number.isFinite(Number(raw))) delete next[key];
    else next[key] = Number(raw);
    setEdit(next);
  };
  // Rules are listed only while the mode is on. With the mode on, a server
  // that checked no rule (rulesEvaluated false: nothing could be measured)
  // lists them as not checked, and no rule shows a tick or a cross.
  const rulesOff = s != null && (s.status === "OFF" || s.config.enabled === false);
  const nothingChecked = s?.rulesEvaluated === false;
  const unmeasured = s?.equityMeasured === false || s?.measured === false;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Trophy className="h-6 w-6 text-primary" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Prop Firm Risk Mode</h1>
          {/* Progress is read from the paper ledger, but saving writes the caps
              into user_risk_settings, which the venue-agnostic Risk Governor
              applies to paper, demo and live orders alike. */}
          <p className="text-sm text-muted-foreground" data-testid="prop-firm-scope">Practise a prop-firm challenge. Progress is measured on your paper account only. Saving also writes the daily loss, total drawdown, lot size and open-position caps into your own risk limits. The Risk Governor applies those limits to every order you place on every venue, including demo and live broker orders. Turning the mode off keeps those limits until you change them.</p>
          <p className="text-xs text-muted-foreground" data-testid="prop-firm-separate">
            This is separate from <a href="/prop-challenge" className="underline">Prop Challenge Practice</a>, which tracks its own challenges with their own balance, rules and status. A status on one page says nothing about the other.
          </p>
        </div>
        <Badge variant="outline" title="Profit, drawdown and rule progress are read from your paper account.">Progress: PAPER</Badge>
        <Badge variant="outline" className="border-amber-500/50 text-amber-500" title="Saved caps apply to paper, demo and live orders.">Limits: ALL VENUES</Badge>
        {s && <Badge className={STATUS_COLOR[s.status]} data-testid="prop-status-badge">{STATUS_LABEL[s.status] ?? s.status}</Badge>}
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

      {s && s.measured === false && (
        <p className="text-sm rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-300" data-testid="prop-not-measured">
          Not measured: {s.notMeasuredReason ?? "paper equity could not be read."} No challenge rule has been checked.
        </p>
      )}

      {s && s.measured && s.equityUsd != null && s.startEquityUsd != null && (
        <p className="text-xs text-muted-foreground" data-testid="prop-measured-from">
          Measured on paper account #{s.paperAccountId}: equity ${s.equityUsd} as of {when(s.equityAsOf)} (the account's last stored mark),
          against ${s.startEquityUsd} when the challenge started {when(s.challengeStartedAt)}.
          {s.dailyDrawdownSince && <> Today's drawdown counts paper P/L settled since {when(s.dailyDrawdownSince)} plus the current floating loss.</>}
        </p>
      )}
      {s && s.status === "TARGET_REACHED" && (
        <p className="text-sm rounded border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-blue-300" data-testid="prop-target-reached">
          Profit target reached. {s.notChecked?.length ?? 0} challenge rule{(s.notChecked?.length ?? 0) === 1 ? " is" : "s are"} not checked, so this is not a confirmed pass.
        </p>
      )}
      {s && (s.notes ?? []).map((n) => (
        <p key={n} className="text-xs rounded border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-amber-300" data-testid="prop-note">{n}</p>
      ))}

      {s && (
        <div className="grid gap-2 md:grid-cols-4">
          <Stat label="Enabled" value={s.config.enabled ? "YES" : "NO"} />
          <Stat label="Profit USD" value={unmeasured ? NOT_MEASURED : money(s.profitUsd)} />
          <Stat label="Target progress" value={unmeasured || s.profitTargetProgress == null ? NOT_MEASURED : `${s.profitTargetProgress}%`} />
          <Stat label="Daily DD left" value={s.measured === false ? NOT_MEASURED : money(s.dailyDrawdownRemainingUsd)} />
          <Stat label="Total DD left" value={unmeasured ? NOT_MEASURED : money(s.totalDrawdownRemainingUsd)} />
          {/* Passed CHECKS: DAILY_DD_TODAY / TOTAL_DD_CURRENT are the measured parts of a rule, not the whole rule. */}
          <Stat label="Passed checks" value={String(s.passed.length)} />
          <Stat label="Failed rules" value={String(s.failed.length)} />
          <Stat label="Not checked" value={String(s.notChecked?.length ?? s.notEvaluated?.length ?? 0)} />
          <Stat label="Account status" value={STATUS_LABEL[s.status] ?? s.status} />
        </div>
      )}

      {s && (
        <Card>
          <CardHeader><CardTitle className="text-base">Configure</CardTitle><CardDescription>Defaults reflect a typical $100k challenge. Saving or turning the mode on changes your risk limits for paper, demo and live orders. Progress is measured in dollars from your paper account's equity when the challenge starts (turning the mode on, or "Turn on with saved values", which restarts it); the challenge size is not applied to it.</CardDescription></CardHeader>
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
              <Button variant="outline" onClick={enableSaved} title="Turns the mode on with the values already saved and restarts the challenge: progress is measured again from your paper account's equity now. No saved value is changed.">Turn on with saved values</Button>
              <Button variant="ghost" onClick={disable}>Disable mode</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {s && (
        <Card>
          <CardHeader><CardTitle className="text-base">Rule status</CardTitle></CardHeader>
          <CardContent className="space-y-2" data-testid="prop-firm-rules">
            {rulesOff ? (
              <p className="text-sm text-muted-foreground">Rules are not checked while the mode is off.</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-1">
                  {!nothingChecked && s.passed.map((p) => <Badge key={p} className="bg-emerald-500/20 text-emerald-400">✓ {p}</Badge>)}
                  {!nothingChecked && s.failed.map((f) => <Badge key={f} variant="destructive">✗ {f}</Badge>)}
                  {(s.notEvaluated ?? []).filter((n) => !(s.notChecked ?? []).some((c) => c.rule === n)).map((n) => (
                    <Badge key={n} variant="outline">{n}: not checked (paper equity could not be read)</Badge>
                  ))}
                  {(s.notChecked ?? []).map((n) => (
                    <Badge key={n.rule} variant="outline" title={n.reason} data-testid={`prop-rule-not-checked-${n.rule}`}>– {n.rule} not checked</Badge>
                  ))}
                </div>
                {(s.notChecked ?? []).length > 0 && (
                  <ul className="text-xs text-muted-foreground list-disc pl-4 space-y-0.5" data-testid="prop-not-checked-reasons">
                    {(s.notChecked ?? []).map((n) => <li key={n.rule}><span className="font-mono">{n.rule}</span>: {n.reason}</li>)}
                  </ul>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

const NOT_MEASURED = "Not measured";
const money = (v: number | null) => (v == null ? NOT_MEASURED : `$${v}`);
const when = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleString() : "at an unknown time";
};

function Stat({ label, value }: { label: string; value: string }) {
  return <Card><CardContent className="p-2"><p className="text-[10px] text-muted-foreground uppercase">{label}</p><p className="text-sm font-mono font-semibold">{value}</p></CardContent></Card>;
}
