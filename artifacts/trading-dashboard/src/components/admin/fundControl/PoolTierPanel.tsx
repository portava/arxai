// Pool Tier Panel — displays the active buy-in tier pricing for a strategy
// pool, shows tier progress toward the next threshold, and lets an admin/OWNER
// update the dynamic T10 growth multiplier / step size / downgrade mode.
//
// SAFETY: admin/OWNER only (the enclosing page is wrapped in
// AdminDiagnosticsGate). All mutations are reason-gated and audited server-side.
// This panel is RECORD-ONLY — it never touches the live-execution path or any
// gate in the 16-gate evaluator.

import { useState } from "react";
import {
  useGetAdminFundBookPoolTierState,
  usePatchAdminFundBookPoolTierState,
  useGetAdminFundBookPoolTierEvents,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { TrendingUp, ChevronRight, History } from "lucide-react";
import { ReasonDialog, ErrorState, fmtMoney, fmtPct } from "./format";

interface Props {
  poolKey: string;
  poolName: string;
}

export function PoolTierPanel({ poolKey, poolName }: Props) {
  const tierQ = useGetAdminFundBookPoolTierState(poolKey);
  const patch = usePatchAdminFundBookPoolTierState();
  const eventsQ = useGetAdminFundBookPoolTierEvents(poolKey, { limit: 20 });

  const [editOpen, setEditOpen] = useState(false);
  const [multiplier, setMultiplier] = useState("");
  const [stepSize, setStepSize] = useState("");
  const [downgradeEnabled, setDowngradeEnabled] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (tierQ.isLoading) {
    return <Skeleton className="h-32 w-full" data-testid={`tier-panel-loading-${poolKey}`} />;
  }

  if (tierQ.isError) {
    return (
      <ErrorState
        title="Tier state unavailable"
        body="The buy-in tier state for this pool could not be loaded."
        onRetry={() => void tierQ.refetch()}
        busy={tierQ.isFetching}
        testid={`tier-panel-error-${poolKey}`}
      />
    );
  }

  const ts = tierQ.data?.tierState;
  if (!ts) return null;

  const isDynamic = ts.activePricingMode === "DYNAMIC";
  const hasNext = ts.nextTierThreshold != null;
  // activeTierNavMin is the floor NAV for the current tier; used for correct
  // within-tier progress: (nav - floor) / (nextThreshold - floor).
  const tierFloor = ts.activeTierNavMin ?? 0;

  function openEdit() {
    setMultiplier(String(ts!.dynamicGrowthMultiplier ?? 0.15));
    setStepSize(String(ts!.dynamicGrowthStepSize ?? 50000));
    setDowngradeEnabled(ts!.tierDowngradeModeEnabled ?? false);
    setErr(null);
    setEditOpen(true);
  }

  function submitEdit(reason: string) {
    setErr(null);
    patch.mutate(
      {
        poolKey,
        data: {
          dynamicGrowthMultiplier: multiplier ? Number(multiplier) : undefined,
          dynamicGrowthStepSize: stepSize ? Number(stepSize) : undefined,
          tierDowngradeModeEnabled: downgradeEnabled,
          reason,
        },
      },
      {
        onSuccess: () => {
          setEditOpen(false);
          void tierQ.refetch();
        },
        onError: (e) => setErr(e instanceof Error ? e.message : "Update failed."),
      },
    );
  }

  return (
    <Card data-testid={`tier-panel-${poolKey}`}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <TrendingUp className="h-4 w-4" />
            {poolName} — Buy-in Tier Pricing
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className={isDynamic ? "border-warning/40 text-warning" : ""}
              data-testid={`tier-badge-${poolKey}`}
            >
              {ts.activeTierLabel}
            </Badge>
            {isDynamic ? (
              <Badge className="bg-warning/15 text-warning">Dynamic</Badge>
            ) : (
              <Badge variant="outline">Fixed</Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <TierField label="Active tier" value={`T${ts.activeTierNum} — ${ts.activeTierLabel}`} />
          <TierField label="Buy-in price / unit" value={fmtMoney(ts.activeBuyInPrice)} />
          <TierField label="Finalized NAV" value={fmtMoney(ts.finalizedTotalNav)} />
          <TierField label="Finalized NAV / unit" value={fmtMoney(ts.finalizedNavPerUnit)} />
          {hasNext ? (
            <>
              <TierField
                label="Next tier at"
                value={
                  <span className="flex items-center gap-1">
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                    {fmtMoney(ts.nextTierThreshold!)}
                  </span>
                }
              />
              <TierField
                label="Next tier price"
                value={
                  ts.nextTierEstimatedPrice != null
                    ? fmtMoney(ts.nextTierEstimatedPrice)
                    : "—"
                }
              />
            </>
          ) : null}
          <TierField
            label="Downgrade mode"
            value={
              ts.tierDowngradeModeEnabled
                ? <Badge variant="outline" className="text-[10px] text-warning border-warning/40">Enabled</Badge>
                : <span className="text-muted-foreground text-xs">Disabled</span>
            }
          />
          <TierField
            label="T10 growth multiplier"
            value={fmtPct(ts.dynamicGrowthMultiplier)}
          />
          <TierField
            label="T10 price step size"
            value={fmtMoney(ts.dynamicGrowthStepSize)}
          />
        </div>

        {/* Progress to next tier — uses within-tier range for accuracy */}
        {hasNext && ts.finalizedTotalNav != null && ts.nextTierThreshold != null ? (() => {
          const range = ts.nextTierThreshold - tierFloor;
          const pct = range > 0
            ? Math.min(1, Math.max(0, (ts.finalizedTotalNav - tierFloor) / range))
            : 1;
          const pctDisplay = `${Math.round(pct * 100)}%`;
          const remaining = ts.nextTierThreshold - ts.finalizedTotalNav;
          return (
            <div className="space-y-1" data-testid={`tier-progress-${poolKey}`}>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Progress to next tier</span>
                <span className="tabular-nums font-medium">{pctDisplay} — {fmtMoney(remaining)} remaining</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: pctDisplay }}
                />
              </div>
            </div>
          );
        })() : null}

        {ts.tierChanged ? (
          <p className="text-xs text-warning" data-testid={`tier-changed-${poolKey}`}>
            ↑ Tier advanced from T{ts.previousTierNum} on this read.
          </p>
        ) : null}

        {/* Tier event history */}
        <div className="mt-1">
          <div className="flex items-center gap-1 mb-1">
            <History className="h-3 w-3 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Tier event history
            </span>
          </div>
          {eventsQ.isLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : !eventsQ.data?.events?.length ? (
            <p className="text-xs text-muted-foreground italic">No tier events recorded yet.</p>
          ) : (
            <div className="max-h-40 overflow-y-auto space-y-1 pr-1">
              {eventsQ.data.events.map((ev) => (
                <div
                  key={ev.id}
                  className="flex items-center justify-between text-xs py-1 border-b border-border/20"
                  data-testid={`tier-event-${ev.id}`}
                >
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px] px-1 py-0">{ev.eventType}</Badge>
                    <span className="text-muted-foreground">
                      T{ev.tierNumBefore} → T{ev.tierNumAfter}
                    </span>
                    {ev.finalizedNavAfter != null ? (
                      <span className="tabular-nums text-muted-foreground">
                        NAV {fmtMoney(ev.finalizedNavAfter)}
                      </span>
                    ) : null}
                  </div>
                  <span className="text-muted-foreground shrink-0 ml-2">
                    {ev.createdAt ? new Date(ev.createdAt).toLocaleDateString() : "—"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <Button
          size="sm"
          variant="outline"
          onClick={openEdit}
          disabled={patch.isPending}
          data-testid={`button-edit-tier-${poolKey}`}
        >
          Edit tier growth config
        </Button>
        {err ? <p className="text-xs text-danger">{err}</p> : null}
      </CardContent>

      <ReasonDialog
        open={editOpen}
        onOpenChange={(o) => {
          if (!o) setEditOpen(false);
        }}
        title={`Edit T10 dynamic growth config — ${poolName}`}
        description="Adjust the growth multiplier (10–30%) and step size (NAV increment between price steps) for the dynamic T10 tier. Record-only — does not affect any live trade or gate."
        confirmLabel="Save config"
        busy={patch.isPending}
        extra={
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="tier-multiplier">Growth multiplier (0.10 – 0.30)</Label>
              <Input
                id="tier-multiplier"
                data-testid="input-tier-multiplier"
                value={multiplier}
                onChange={(e) => setMultiplier(e.target.value)}
                placeholder="e.g. 0.15"
              />
              <p className="text-xs text-muted-foreground">
                Each price step = previous step × (1 + multiplier).
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="tier-step">NAV step size ($)</Label>
              <Input
                id="tier-step"
                data-testid="input-tier-step"
                value={stepSize}
                onChange={(e) => setStepSize(e.target.value)}
                placeholder="e.g. 50000"
              />
              <p className="text-xs text-muted-foreground">
                NAV increment between each dynamic price step.
              </p>
            </div>
            <div className="flex items-center justify-between rounded-md border border-border/50 p-3">
              <div className="space-y-0.5">
                <Label htmlFor="tier-downgrade">Allow tier downgrade</Label>
                <p className="text-xs text-muted-foreground">
                  When on, finalized NAV falls below a threshold may lower the active tier. Record-only.
                </p>
              </div>
              <Switch
                id="tier-downgrade"
                data-testid="switch-tier-downgrade"
                checked={downgradeEnabled}
                onCheckedChange={setDowngradeEnabled}
              />
            </div>
          </div>
        }
        onConfirm={(reason) => submitEdit(reason)}
      />
    </Card>
  );
}

function TierField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col border-b border-border/30 py-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
