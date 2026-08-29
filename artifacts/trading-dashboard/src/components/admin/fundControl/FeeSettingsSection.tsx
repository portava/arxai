// Fee Settings — capital policy: fee schedule, NAV cutoff, lock days, minimums,
// disclosure version, and the read-only speed-tier tables. No page surfaced this
// before.
//
// SAFETY: read + a single audited policy update (≥3-char reason). Only fields
// the operator changed are sent. No trading or live-pipeline surface is touched.

import { useState } from "react";
import {
  useGetAdminCapitalSettings,
  useUpdateAdminCapitalSettings,
} from "@workspace/api-client-react";
import type {
  CapitalSettings,
  CapitalSpeedTier,
  AdminCapitalSettingsReqPatch,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ReasonDialog, ErrorState, fmtMoney, fmtPct } from "./format";

export function FeeSettingsSection() {
  const settingsQ = useGetAdminCapitalSettings();

  if (settingsQ.isLoading) {
    return <Skeleton className="h-64 w-full" data-testid="fees-loading" />;
  }
  if (settingsQ.isError) {
    return (
      <ErrorState
        title="Fee policy unavailable"
        body="The capital settings could not be loaded. This is a load failure — fee policy is unchanged, not reset."
        onRetry={() => void settingsQ.refetch()}
        busy={settingsQ.isFetching}
        testid="fees-error"
      />
    );
  }
  const data = settingsQ.data;
  if (!data?.settings) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="fees-empty">
        Capital settings are not configured yet.
      </p>
    );
  }

  return (
    <FeeSettingsForm
      key={JSON.stringify(data.settings)}
      settings={data.settings}
      depositTiers={data.depositTiers ?? []}
      withdrawalTiers={data.withdrawalTiers ?? []}
      onSaved={() => void settingsQ.refetch()}
    />
  );
}

function FeeSettingsForm({
  settings,
  depositTiers,
  withdrawalTiers,
  onSaved,
}: {
  settings: CapitalSettings;
  depositTiers: CapitalSpeedTier[];
  withdrawalTiers: CapitalSpeedTier[];
  onSaved: () => void;
}) {
  const update = useUpdateAdminCapitalSettings();
  const [form, setForm] = useState({
    managementFeeAnnualPct: String(settings.managementFeeAnnualPct),
    performanceFeePct: String(settings.performanceFeePct),
    liquidityFeePct: String(settings.liquidityFeePct),
    navCutoffHour: String(settings.navCutoffHour),
    navCutoffMinute: String(settings.navCutoffMinute),
    navCutoffTimezone: settings.navCutoffTimezone,
    depositLockDays: String(settings.depositLockDays),
    minDepositAmount: String(settings.minDepositAmount),
    minWithdrawalAmount: String(settings.minWithdrawalAmount),
    disclosureVersion: settings.disclosureVersion,
  });
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function set<K extends keyof typeof form>(k: K, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  // Build a patch of only the fields that actually changed, coercing numerics.
  function buildPatch(): AdminCapitalSettingsReqPatch {
    const patch: AdminCapitalSettingsReqPatch = {};
    const num = (v: string) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    if (num(form.managementFeeAnnualPct) !== settings.managementFeeAnnualPct)
      patch.managementFeeAnnualPct = num(form.managementFeeAnnualPct);
    if (num(form.performanceFeePct) !== settings.performanceFeePct)
      patch.performanceFeePct = num(form.performanceFeePct);
    if (num(form.liquidityFeePct) !== settings.liquidityFeePct)
      patch.liquidityFeePct = num(form.liquidityFeePct);
    if (num(form.navCutoffHour) !== settings.navCutoffHour)
      patch.navCutoffHour = num(form.navCutoffHour);
    if (num(form.navCutoffMinute) !== settings.navCutoffMinute)
      patch.navCutoffMinute = num(form.navCutoffMinute);
    if (form.navCutoffTimezone !== settings.navCutoffTimezone)
      patch.navCutoffTimezone = form.navCutoffTimezone;
    if (num(form.depositLockDays) !== settings.depositLockDays)
      patch.depositLockDays = num(form.depositLockDays);
    if (num(form.minDepositAmount) !== settings.minDepositAmount)
      patch.minDepositAmount = num(form.minDepositAmount);
    if (num(form.minWithdrawalAmount) !== settings.minWithdrawalAmount)
      patch.minWithdrawalAmount = num(form.minWithdrawalAmount);
    if (form.disclosureVersion !== settings.disclosureVersion)
      patch.disclosureVersion = form.disclosureVersion;
    // Drop any keys that coerced to undefined (invalid numeric input).
    for (const k of Object.keys(patch) as Array<keyof AdminCapitalSettingsReqPatch>) {
      if (patch[k] === undefined) delete patch[k];
    }
    return patch;
  }

  const patch = buildPatch();
  const changedCount = Object.keys(patch).length;

  function save(reason: string) {
    setErr(null);
    update.mutate(
      { data: { reason, patch } },
      {
        onSuccess: () => {
          setConfirming(false);
          onSaved();
        },
        onError: (e) => setErr(e instanceof Error ? e.message : "Update failed."),
      },
    );
  }

  return (
    <div className="space-y-4" data-testid="fee-settings-section">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Fee schedule</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <NumField label="Management fee (annual %)" value={form.managementFeeAnnualPct} onChange={(v) => set("managementFeeAnnualPct", v)} testid="input-mgmt-fee" />
          <NumField label="Performance fee (%)" value={form.performanceFeePct} onChange={(v) => set("performanceFeePct", v)} testid="input-perf-fee" />
          <NumField label="Liquidity fee (%)" value={form.liquidityFeePct} onChange={(v) => set("liquidityFeePct", v)} testid="input-liquidity-fee" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">NAV cycle & limits</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <NumField label="NAV cutoff hour (0-23)" value={form.navCutoffHour} onChange={(v) => set("navCutoffHour", v)} testid="input-nav-hour" />
          <NumField label="NAV cutoff minute (0-59)" value={form.navCutoffMinute} onChange={(v) => set("navCutoffMinute", v)} testid="input-nav-minute" />
          <TextField label="NAV cutoff timezone" value={form.navCutoffTimezone} onChange={(v) => set("navCutoffTimezone", v)} testid="input-nav-tz" />
          <NumField label="Deposit lock (days)" value={form.depositLockDays} onChange={(v) => set("depositLockDays", v)} testid="input-lock-days" />
          <NumField label="Min deposit" value={form.minDepositAmount} onChange={(v) => set("minDepositAmount", v)} testid="input-min-deposit" />
          <NumField label="Min withdrawal" value={form.minWithdrawalAmount} onChange={(v) => set("minWithdrawalAmount", v)} testid="input-min-withdrawal" />
          <TextField label="Disclosure version" value={form.disclosureVersion} onChange={(v) => set("disclosureVersion", v)} testid="input-disclosure" />
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button
          disabled={changedCount === 0 || update.isPending}
          onClick={() => {
            setConfirming(true);
            setErr(null);
          }}
          data-testid="button-save-settings"
        >
          {changedCount === 0 ? "No changes" : `Review ${changedCount} change${changedCount === 1 ? "" : "s"}`}
        </Button>
        {err ? <p className="text-xs text-danger">{err}</p> : null}
      </div>

      <TierTable title="Deposit speed tiers" tiers={depositTiers} />
      <TierTable title="Withdrawal speed tiers" tiers={withdrawalTiers} />

      <ReasonDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Update capital policy"
        description={`Applying ${changedCount} change${changedCount === 1 ? "" : "s"}. Recorded with your reason in the audit log.`}
        confirmLabel="Save policy"
        busy={update.isPending}
        onConfirm={save}
      />
    </div>
  );
}

function NumField({ label, value, onChange, testid }: { label: string; value: string; onChange: (v: string) => void; testid?: string }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input type="number" value={value} onChange={(e) => onChange(e.target.value)} data-testid={testid} />
    </div>
  );
}

function TextField({ label, value, onChange, testid }: { label: string; value: string; onChange: (v: string) => void; testid?: string }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} data-testid={testid} />
    </div>
  );
}

function TierTable({ title, tiers }: { title: string; tiers: CapitalSpeedTier[] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {tiers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tiers configured.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tier</TableHead>
                  <TableHead>Fee mode</TableHead>
                  <TableHead className="text-right">Flat</TableHead>
                  <TableHead className="text-right">Percent</TableHead>
                  <TableHead>SLA</TableHead>
                  <TableHead>Disclosure</TableHead>
                  <TableHead>Active</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tiers.map((t) => (
                  <TableRow key={t.id} data-testid={`tier-${t.tierKey}`}>
                    <TableCell className="font-medium">{t.label}</TableCell>
                    <TableCell>{t.feeMode}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtMoney(t.flatFee)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtPct(t.percentageFee)}</TableCell>
                    <TableCell>{t.slaLabel ?? "—"}</TableCell>
                    <TableCell>{t.requiresDisclosure ? "Required" : "—"}</TableCell>
                    <TableCell>
                      {t.active ? (
                        <Badge className="bg-success/15 text-success">Active</Badge>
                      ) : (
                        <Badge className="bg-muted text-muted-foreground">Inactive</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
