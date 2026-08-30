import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

// RANK 14 (critical) — this page was wired to a route that had been 410 Gone
// for a whole phase.
//
// THE DEFECT
//   Every hook here pinned GET/PATCH `/api/alert-preferences`. routes/alerts.ts
//   registers that exact path as `deprecatedGet` (a fixed envelope carrying NO
//   preference fields) and `deprecatedMutation` → 410 Gone. No other router
//   handles it. So all eight category switches rendered OFF regardless of the
//   user's real setting — `Boolean(prefs[key])` on an absent key is false — and
//   flipping any switch, the severity select, or a quiet-hours field threw 410
//   with no error UI: the control snapped back and nothing saved. A user who
//   silenced a category believed they had, and had not.
//
//   routes/alerts.ts line 11 justified the deprecation with "Frontend audit
//   (rg) confirmed zero consumers of … /api/alert-preferences". That audit was
//   wrong — this page was, and still is, the consumer.
//
// THE FIX
//   Repointed at `/api/me/notification-preferences` (routes/meNotifications.ts):
//   `requireUser`, one row per user, and — unlike the retired singleton
//   `alert_preferences` table — the store that notify()'s category gate and
//   sendService's push gate actually read. The old page's eight categories are
//   mapped onto that table's real columns; a category with no column is NOT
//   shown, because a switch that writes nowhere is the defect we are fixing.
//
//   Every save now reports failure. `updatedFields` comes back from the server
//   and is checked, so a field the server silently dropped can never render as
//   saved.

type Prefs = {
  inAppEnabled: boolean;
  pushEnabled: boolean;
  emailEnabled: boolean | null;
  mt5StatusEnabled: boolean;
  riskAlertsEnabled: boolean;
  tradeEventsEnabled: boolean;
  aiCoachingEnabled: boolean;
  playbookChecklistEnabled: boolean;
  journalRemindersEnabled: boolean;
  sessionRemindersEnabled: boolean;
  securityAlertsEnabled: boolean;
  quietHoursEnabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  timezone: string | null;
  minimumPushSeverity: "info" | "warning" | "critical";
  criticalAlwaysDelivered: boolean;
  pushConfigured: boolean;
};

const PREFS_KEY = ["me", "notification-preferences"] as const;

async function fetchPrefs(): Promise<Prefs | null> {
  const res = await fetch("/api/me/notification-preferences", { credentials: "include" });
  if (!res.ok) return null;
  const json = (await res.json()) as Partial<Prefs> | null;
  // A body without the shape we need is UNKNOWN, not "all your switches are
  // off" — the exact conflation that produced the original defect.
  if (!json || typeof json.inAppEnabled !== "boolean") return null;
  return json as Prefs;
}

// Only categories that map to a real column on user_notification_preferences.
const CATEGORIES: Array<[label: string, key: keyof Prefs, desc: string]> = [
  ["In-app notifications", "inAppEnabled", "Master switch for the notification centre and the alert bell."],
  ["Risk alerts", "riskAlertsEnabled", "Risk locks, cooldowns, and approaching your daily loss budget."],
  ["MT5 bridge status", "mt5StatusEnabled", "Bridge disconnects, stale heartbeats, and feed delays."],
  ["Trade events", "tradeEventsEnabled", "Fills, stop-loss and take-profit hits, and closes on your trades."],
  ["AI coaching", "aiCoachingEnabled", "Coach observations and suggested drills."],
  ["Playbook & checklist", "playbookChecklistEnabled", "Reminders when a playbook step or pre-trade check is missing."],
  ["Journal reminders", "journalRemindersEnabled", "Nudges to review a trade or write up a session."],
  ["Session reminders", "sessionRemindersEnabled", "Session open/close and scheduled review reminders."],
  ["Security alerts", "securityAlertsEnabled", "Sign-ins, password changes, and push-subscription changes."],
];

export default function AlertPreferencesPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: prefs, isLoading, isError } = useQuery({
    queryKey: PREFS_KEY,
    queryFn: fetchPrefs,
  });

  const update = useMutation({
    mutationFn: async (partial: Record<string, unknown>) => {
      const res = await fetch("/api/me/notification-preferences", {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(partial),
      });
      const body = (await res.json().catch(() => null)) as
        | { updatedFields?: string[]; message?: string; error?: string }
        | null;
      if (!res.ok) throw new Error(body?.message ?? body?.error ?? `Save failed (HTTP ${res.status})`);
      // The server echoes exactly which columns it wrote. If it dropped one, we
      // must not paint a success state over it.
      const requested = Object.keys(partial);
      const written = new Set(body?.updatedFields ?? []);
      const dropped = requested.filter((k) => !written.has(k));
      if (dropped.length > 0) throw new Error(`The server did not store: ${dropped.join(", ")}`);
      return body;
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: PREFS_KEY }); },
    onError: (err: unknown) => {
      // RANK 14: a failed save used to be completely silent — the switch simply
      // snapped back. It never does that quietly again.
      toast({
        title: "Preference not saved",
        description: err instanceof Error ? err.message : "Your change was not stored. Nothing was updated.",
        variant: "destructive",
      });
      void qc.invalidateQueries({ queryKey: PREFS_KEY });
    },
  });

  const patch = (partial: Record<string, unknown>) => update.mutate(partial);

  if (isLoading) return <div className="text-sm text-muted-foreground">Loading preferences…</div>;

  if (isError || !prefs) {
    return (
      <div className="max-w-3xl space-y-3" data-testid="alert-preferences-unavailable">
        <h1 className="text-2xl font-semibold">Alert preferences</h1>
        <div className="rounded-md border border-warning/40 bg-warning/10 p-4 text-sm text-warning">
          Your notification preferences could not be loaded, so none are shown. This page is not
          claiming your alerts are off — it simply cannot read your settings right now. Reload to
          try again.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold">Alert preferences</h1>
        <p className="text-sm text-muted-foreground">
          Control which categories generate notifications and set quiet hours. CRITICAL safety
          alerts bypass every switch on this page and cannot be silenced.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Categories</CardTitle>
          <CardDescription>
            Turn a category off to suppress its non-critical alerts, in-app and on push.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {CATEGORIES.map(([label, key, desc]) => (
            <div key={String(key)} className="flex items-start justify-between gap-4">
              <div>
                <Label className="font-medium">{label}</Label>
                <div className="text-xs text-muted-foreground">{desc}</div>
              </div>
              <Switch
                checked={Boolean(prefs[key])}
                disabled={update.isPending}
                onCheckedChange={(v) => patch({ [key]: v })}
                data-testid={`switch-${String(key)}`}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Push delivery</CardTitle>
          <CardDescription>
            The minimum severity that may trigger a push notification. Critical alerts always push
            regardless of this setting — live-risk events cannot be silenced.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {!prefs.pushConfigured && (
            // Honest about the thing the old page implied but never checked: a
            // severity floor is irrelevant if the server cannot push at all.
            <div className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground" data-testid="push-not-configured">
              Push notifications are not configured on this server, so nothing here will reach your
              phone yet. Your choice is still saved and takes effect once push is set up.
            </div>
          )}
          <div className="flex items-start justify-between gap-4">
            <div>
              <Label className="font-medium">Push notifications</Label>
              <div className="text-xs text-muted-foreground">Send alerts to your subscribed devices.</div>
            </div>
            <Switch
              checked={Boolean(prefs.pushEnabled)}
              disabled={update.isPending}
              onCheckedChange={(v) => patch({ pushEnabled: v })}
              data-testid="switch-pushEnabled"
            />
          </div>
          <Label>Minimum push severity</Label>
          <select
            className="w-48 rounded-md border bg-background p-2 text-sm"
            value={prefs.minimumPushSeverity}
            disabled={update.isPending}
            onChange={(e) => patch({ minimumPushSeverity: e.target.value })}
            data-testid="select-minimum-push-severity"
          >
            <option value="info">Info (all alerts push)</option>
            <option value="warning">Warning (warnings + critical only)</option>
            <option value="critical">Critical only</option>
          </select>
          {prefs.minimumPushSeverity === "critical" && (
            <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
              You will only receive push alerts for critical events. Routine watch and warning
              alerts will still appear in-app but will not push to your phone.
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Quiet hours</CardTitle>
          <CardDescription>
            A local-time range during which non-critical alerts are silenced. Critical alerts still
            come through.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Label className="font-medium">Enable quiet hours</Label>
              <div className="text-xs text-muted-foreground">
                Quiet hours are only applied while this is on.
              </div>
            </div>
            <Switch
              checked={Boolean(prefs.quietHoursEnabled)}
              disabled={update.isPending}
              onCheckedChange={(v) => patch({ quietHoursEnabled: v })}
              data-testid="switch-quietHoursEnabled"
            />
          </div>
          <div className="flex items-end gap-4">
            <div>
              {/* HH:MM, matching the column the server parses
                  (notificationService.inQuietHours splits on ":"). The old page
                  sent integers 0–23 into a text column no gate could read. */}
              <Label>Start (HH:MM)</Label>
              <Input
                type="time"
                className="w-32"
                defaultValue={prefs.quietHoursStart ?? ""}
                disabled={update.isPending}
                onBlur={(e) => {
                  const v = e.target.value === "" ? null : e.target.value;
                  if (v !== (prefs.quietHoursStart ?? null)) patch({ quietHoursStart: v });
                }}
                data-testid="input-quiet-hours-start"
              />
            </div>
            <div>
              <Label>End (HH:MM)</Label>
              <Input
                type="time"
                className="w-32"
                defaultValue={prefs.quietHoursEnd ?? ""}
                disabled={update.isPending}
                onBlur={(e) => {
                  const v = e.target.value === "" ? null : e.target.value;
                  if (v !== (prefs.quietHoursEnd ?? null)) patch({ quietHoursEnd: v });
                }}
                data-testid="input-quiet-hours-end"
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
