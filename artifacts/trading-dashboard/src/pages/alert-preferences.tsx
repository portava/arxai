import React from "react";
import {
  useGetAlertPreferences,
  useUpdateAlertPreferences,
  getGetAlertPreferencesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// (L) Single-tenant preferences page. Persists to alert_preferences (id=1).
// CRITICAL alerts always bypass these toggles and quiet hours by design.
export default function AlertPreferencesPage() {
  const qc = useQueryClient();
  const { data: prefs, isLoading } = useGetAlertPreferences({
    query: { queryKey: getGetAlertPreferencesQueryKey() },
  });
  const update = useUpdateAlertPreferences();

  const patch = async (partial: Record<string, unknown>) => {
    await update.mutateAsync({ data: partial as never });
    qc.invalidateQueries({ queryKey: getGetAlertPreferencesQueryKey() });
  };

  if (isLoading || !prefs) return <div className="text-sm text-muted-foreground">Loading preferences…</div>;

  const toggles: Array<[string, keyof typeof prefs, string]> = [
    ["Market condition alerts",     "marketAlertsEnabled",          "Notify when active plans hit NO_TRADE conditions."],
    ["Risk lock alerts",            "riskAlertsEnabled",            "Notify when risk locks engage or you near the daily loss budget."],
    ["Broker health alerts",        "brokerAlertsEnabled",          "Notify on broker disconnects or feed delays."],
    ["Open position alerts",        "positionAlertsEnabled",        "Notify when an open position approaches its stop loss."],
    ["AI coach alerts",             "coachAlertsEnabled",           "Coach observations and suggested replay drills."],
    ["Weekly review alerts",        "weeklyReviewAlertsEnabled",    "Notify when a new weekly performance review is ready."],
    ["Trade plan alerts",           "tradePlanAlertsEnabled",       "Notify when a trade plan becomes ready or invalidated."],
    ["Execution safety alerts",     "executionSafetyAlertsEnabled", "Always-on for safety events (CRITICAL alerts bypass this anyway)."],
  ];

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold">Alert preferences</h1>
        <p className="text-sm text-muted-foreground">Control which categories generate notifications and set quiet hours. CRITICAL safety alerts cannot be silenced.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Categories</CardTitle>
          <CardDescription>Toggle a category off to suppress its non-critical alerts.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {toggles.map(([label, key, desc]) => (
            <div key={key} className="flex items-start justify-between gap-4">
              <div>
                <Label className="font-medium">{label}</Label>
                <div className="text-xs text-muted-foreground">{desc}</div>
              </div>
              <Switch
                checked={Boolean(prefs[key])}
                onCheckedChange={(v) => patch({ [key]: v })}
                data-testid={`switch-${key}`}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Push delivery</CardTitle>
          <CardDescription>
            Choose the minimum severity that may trigger a push notification.
            Critical alerts always push regardless of this setting (live-risk
            events cannot be silenced).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label>Minimum push severity</Label>
          <select
            className="w-48 rounded-md border bg-background p-2 text-sm"
            value={(prefs as { minimumPushSeverity?: string }).minimumPushSeverity ?? "info"}
            onChange={(e) => patch({ minimumPushSeverity: e.target.value })}
            data-testid="select-minimum-push-severity"
          >
            <option value="info">Info (all alerts push)</option>
            <option value="warning">Warning (warnings + critical only)</option>
            <option value="critical">Critical only</option>
          </select>
          {(prefs as { minimumPushSeverity?: string }).minimumPushSeverity === "critical" && (
            <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
              You will only receive push alerts for critical events (live-risk
              emergencies, MT5 disconnects during open live trades, broker
              rejections). Routine watch/warning alerts will still appear
              in-app but will not push to your phone.
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Quiet hours</CardTitle>
          <CardDescription>UTC hour range during which non-critical alerts are silenced. Leave blank to disable.</CardDescription>
        </CardHeader>
        <CardContent className="flex items-end gap-4">
          <div>
            <Label>Start (UTC, 0–23)</Label>
            <Input
              type="number" min={0} max={23} className="w-24"
              value={prefs.quietHoursStart ?? ""}
              onChange={(e) => patch({ quietHoursStart: e.target.value === "" ? null : Number(e.target.value) })}
              data-testid="input-quiet-hours-start"
            />
          </div>
          <div>
            <Label>End (UTC, 0–23)</Label>
            <Input
              type="number" min={0} max={23} className="w-24"
              value={prefs.quietHoursEnd ?? ""}
              onChange={(e) => patch({ quietHoursEnd: e.target.value === "" ? null : Number(e.target.value) })}
              data-testid="input-quiet-hours-end"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
