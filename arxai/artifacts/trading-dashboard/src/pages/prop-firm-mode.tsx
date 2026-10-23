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
  passed: string[]; failed: string[]; status: "ACTIVE" | "WARNING" | "FAILED" | "PASSED";
};
const STATUS_COLOR: Record<string, string> = { ACTIVE: "bg-blue-500/20 text-blue-400", WARNING: "bg-amber-500/20 text-amber-400", FAILED: "bg-rose-500/20 text-rose-400", PASSED: "bg-emerald-500/20 text-emerald-400" };

async function api(path: string, init?: RequestInit) {
  const r = await fetch(path, { headers: { "x-security-role": "ADMIN", "content-type": "application/json", ...(init?.headers ?? {}) }, ...init });
  return r.json();
}

export default function PropFirmMode() {
  const [s, setS] = useState<Status | null>(null);
  const [edit, setEdit] = useState<Partial<Status["config"]>>({});
  async function load() { setS(await fetch("/api/prop-firm/status").then((r) => r.json())); }
  useEffect(() => { void load(); const id = setInterval(load, 4000); return () => clearInterval(id); }, []);

  async function save() { await api("/api/prop-firm/configure", { method: "POST", body: JSON.stringify({ enabled: true, ...edit }) }); load(); }
  async function reset() { await api("/api/prop-firm/reset", { method: "POST" }); load(); }
  async function disable() { await api("/api/prop-firm/configure", { method: "POST", body: JSON.stringify({ enabled: false }) }); load(); }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Trophy className="h-6 w-6 text-primary" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold">Prop Firm Challenge Mode</h1>
          <p className="text-sm text-muted-foreground">Simulator-only practice for prop-firm rules. Never connects to a real broker.</p>
        </div>
        <Badge variant="outline">SIMULATOR</Badge>
        {s && <Badge className={STATUS_COLOR[s.status]}>{s.status}</Badge>}
      </div>

      {s && (
        <div className="grid gap-2 md:grid-cols-4">
          <Stat label="Enabled" value={s.config.enabled ? "YES" : "NO"} />
          <Stat label="Profit USD" value={`$${s.profitUsd}`} />
          <Stat label="Target progress" value={`${s.profitTargetProgress}%`} />
          <Stat label="Daily DD left" value={`$${s.dailyDrawdownRemainingUsd}`} />
          <Stat label="Total DD left" value={`$${s.totalDrawdownRemainingUsd}`} />
          <Stat label="Passed rules" value={String(s.passed.length)} />
          <Stat label="Failed rules" value={String(s.failed.length)} />
          <Stat label="Account status" value={s.status} />
        </div>
      )}

      {s && (
        <Card>
          <CardHeader><CardTitle className="text-base">Configure</CardTitle><CardDescription>Defaults reflect a typical $100k challenge.</CardDescription></CardHeader>
          <CardContent className="grid gap-2 md:grid-cols-3">
            <Input type="number" placeholder={`Starting balance (${s.config.startingBalance})`} onChange={(e) => setEdit({ ...edit, startingBalance: Number(e.target.value) })} />
            <Input type="number" placeholder={`Profit target (${s.config.profitTarget})`} onChange={(e) => setEdit({ ...edit, profitTarget: Number(e.target.value) })} />
            <Input type="number" placeholder={`Max daily DD (${s.config.maxDailyDrawdownUsd})`} onChange={(e) => setEdit({ ...edit, maxDailyDrawdownUsd: Number(e.target.value) })} />
            <Input type="number" placeholder={`Max total DD (${s.config.maxTotalDrawdownUsd})`} onChange={(e) => setEdit({ ...edit, maxTotalDrawdownUsd: Number(e.target.value) })} />
            <Input type="number" placeholder={`Min trading days (${s.config.minTradingDays})`} onChange={(e) => setEdit({ ...edit, minTradingDays: Number(e.target.value) })} />
            <Input type="number" placeholder={`Max lot size (${s.config.maxLotSize})`} onChange={(e) => setEdit({ ...edit, maxLotSize: Number(e.target.value) })} />
            <Input type="number" placeholder={`Max positions (${s.config.maxPositions})`} onChange={(e) => setEdit({ ...edit, maxPositions: Number(e.target.value) })} />
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" defaultChecked={s.config.newsTradingAllowed} onChange={(e) => setEdit({ ...edit, newsTradingAllowed: e.target.checked })} />News trading allowed</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" defaultChecked={s.config.weekendHoldingAllowed} onChange={(e) => setEdit({ ...edit, weekendHoldingAllowed: e.target.checked })} />Weekend holding</label>
            <Input type="number" placeholder={`Consistency rule % (${s.config.consistencyRulePctOfTotal})`} onChange={(e) => setEdit({ ...edit, consistencyRulePctOfTotal: Number(e.target.value) })} />
            <div className="md:col-span-3 flex gap-2">
              <Button onClick={save}>Save & enable</Button>
              <Button variant="outline" onClick={reset}>Reset</Button>
              <Button variant="ghost" onClick={disable}>Disable mode</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {s && (
        <Card>
          <CardHeader><CardTitle className="text-base">Rule status</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap gap-1">
            {s.passed.map((p) => <Badge key={p} className="bg-emerald-500/20 text-emerald-400">✓ {p}</Badge>)}
            {s.failed.map((f) => <Badge key={f} variant="destructive">✗ {f}</Badge>)}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <Card><CardContent className="p-2"><p className="text-[10px] text-muted-foreground uppercase">{label}</p><p className="text-sm font-mono font-semibold">{value}</p></CardContent></Card>;
}
