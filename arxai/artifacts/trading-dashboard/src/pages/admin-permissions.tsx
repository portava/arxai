import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type Matrix = {
  role: string; fullTesterAccess: boolean; canViewAllRoutes: boolean; canUseSimulator: boolean;
  canUseLiveTesterWorkflows: boolean; canSubmitLiveIntent: boolean; canExecuteRealBrokerOrder: boolean;
  canConfigureMT5: boolean; canEditRiskSettings: boolean; canClearTestData: boolean;
  canExportReports: boolean; canRunBacktesting: boolean; canRunShadowMode: boolean;
  canRunAiAutopilotSimulator: boolean; mt5Connected: boolean; mt5Deferred: boolean;
};

const COLS: Array<{ key: keyof Matrix; label: string }> = [
  { key: "fullTesterAccess", label: "Full Tester Access" },
  { key: "canViewAllRoutes", label: "View all routes" },
  { key: "canUseSimulator", label: "Use simulator" },
  { key: "canUseLiveTesterWorkflows", label: "Live tester workflows" },
  { key: "canSubmitLiveIntent", label: "Submit live intent" },
  { key: "canRunAiAutopilotSimulator", label: "AI autopilot (simulator)" },
  { key: "canRunShadowMode", label: "Shadow mode" },
  { key: "canRunBacktesting", label: "Backtesting" },
  { key: "canEditRiskSettings", label: "Edit risk settings" },
  { key: "canClearTestData", label: "Clear test data" },
  { key: "canExportReports", label: "Export reports" },
  { key: "canConfigureMT5", label: "Configure MT5" },
  { key: "canExecuteRealBrokerOrder", label: "Real broker order (LOCKED)" },
];

export default function AdminPermissions() {
  const [rows, setRows] = useState<Matrix[]>([]);
  const [me, setMe] = useState<Matrix | null>(null);

  async function load() {
    const all = await fetch("/api/auth/roles").then((r) => r.json()) as { roles: Array<{ matrix: Matrix }> };
    setRows(all.roles.map((r) => r.matrix));
    setMe(await fetch("/api/auth/permissions").then((r) => r.json()));
  }
  useEffect(() => { void load(); }, []);

  async function login(role: string) {
    await fetch("/api/auth/dev-owner-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role }) });
    await load();
  }

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-4 p-4 md:p-6 pb-32 md:pb-6" data-testid="page-admin-permissions">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Permission Matrix</h1>
          <p className="text-sm text-muted-foreground">Role-based access. Real broker execution is hard-locked false for every role until the MT5 bridge connects.</p>
        </div>
        {me && <Badge>Active role: {me.role}</Badge>}
      </div>

      <Card>
        <CardHeader><CardTitle>Switch role (development)</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {["OWNER", "ADMIN", "TESTER", "VIEWER", "LOCKED"].map((r) => (
            <Button key={r} size="sm" variant="outline" onClick={() => login(r)} data-testid={`btn-login-${r}`}>{r}</Button>
          ))}
          <Button size="sm" variant="ghost" onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); await load(); }}>Logout</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Role × Permission</CardTitle></CardHeader>
        <CardContent className="overflow-auto">
          <table className="text-xs w-full">
            <thead>
              <tr><th className="text-left p-1">Permission</th>{rows.map((r) => <th key={r.role} className="p-1 px-3">{r.role}</th>)}</tr>
            </thead>
            <tbody>
              {COLS.map((c) => (
                <tr key={c.key} className={c.key === "canExecuteRealBrokerOrder" ? "bg-danger/10" : ""}>
                  <td className="p-1 font-mono">{c.label}</td>
                  {rows.map((r) => {
                    const ok = Boolean(r[c.key]);
                    const lock = c.key === "canExecuteRealBrokerOrder";
                    return <td key={r.role} className={`p-1 text-center ${lock ? "text-danger font-bold" : ok ? "text-success" : "text-muted-foreground"}`}>{lock ? "✕" : ok ? "✓" : "·"}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {me && (
        <Card>
          <CardHeader><CardTitle>Your permissions</CardTitle></CardHeader>
          <CardContent><pre className="text-xs whitespace-pre-wrap">{JSON.stringify(me, null, 2)}</pre></CardContent>
        </Card>
      )}
    </div>
  );
}
