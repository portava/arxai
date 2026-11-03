import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Flame } from "lucide-react";
import { useCreateMeScalpAddOnCheck, type MeScalpAddOnCheckResp } from "@workspace/api-client-react";
import {
  ADD_ON_LABEL,
  ADD_ON_TONE,
  FLAME_STAGE_LABEL,
  FLAME_STAGE_TONE,
} from "@/components/scanner/scalpLabels";
import { useAssistantName } from "@/lib/assistant-name";
import { safeDate } from "@/lib/safeFormat";

// LiveScalpAddOnPanel — info-only add-on guidance injected into the live
// trade ticket. It tells the user whether (and how much) it is sane to add
// to an existing scalp on this symbol+direction, with the revenge guard and
// profit-cushion check.
//
// SAFETY: 100% read-only / advisory. It NEVER touches the Confirm flow, never
// enables/disables execution, never mutates the ticket. Confirm runs the same
// server-side 16-gate evaluator regardless of what this panel shows.

function ageText(asOf: string, now: number): string | null {
  const t = new Date(asOf).getTime();
  if (!Number.isFinite(t)) return null;
  const sec = Math.round((now - t) / 1000);
  if (sec < 0) return null;
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m ago`;
}

/**
 * Same window as the server's SCALP_POSITIONS_FRESH_MS (the rule behind
 * positionsStale). The check runs once per symbol/side and is not refetched,
 * so the panel ages the reading itself while the ticket stays open.
 */
const POSITIONS_FRESH_MS = 90_000;
const AGE_TICK_MS = 1_000;

function useTickingNow(intervalMs: number): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return nowMs;
}

export function LiveScalpAddOnPanel({
  symbol,
  side,
}: {
  symbol: string;
  side: "BUY" | "SELL";
}) {
  const { name } = useAssistantName();
  const check = useCreateMeScalpAddOnCheck();
  const { mutate, data } = check;

  useEffect(() => {
    const sym = symbol.trim().toUpperCase();
    if (!sym) return;
    mutate({ data: { symbol: sym, direction: side } });
  }, [symbol, side, mutate]);

  if (!data || !data.hasOpenBasket) return null;
  return <AddOnRead data={data} name={name} />;
}

function AddOnRead({ data, name }: { data: MeScalpAddOnCheckResp; name: string }) {
  const now = useTickingNow(AGE_TICK_MS);
  const addOn = data.addOn;
  const flame = data.flame;
  // The server flags a positions reading older than 90 seconds (or with no
  // recorded time) as stale, by the same rule as the Position Manager: the
  // basket, adds used and the advice then describe that reading, not now.
  // That flag is from when the check ran; the reading keeps ageing while the
  // ticket is open, so the panel also downgrades it once it passes the same
  // window on a ticking clock (it never upgrades a server "stale").
  const asOf = data.positionsAsOf ?? null;
  const asOfMs = asOf ? new Date(asOf).getTime() : NaN;
  const agedOut = Number.isFinite(asOfMs) && now - asOfMs > POSITIONS_FRESH_MS;
  const stale = data.positionsStale === true || agedOut;
  const age = asOf ? ageText(asOf, now) : null;
  const when = asOf ? `${safeDate(asOf, "datetime")}${age ? ` (${age})` : ""}` : null;

  return (
    <Alert
      className="border-fuchsia-500/30 bg-fuchsia-500/5"
      data-testid="ls-scalp-addon"
      data-addon={addOn.recommendation}
      data-stale={stale ? "true" : "false"}
    >
      <Flame className="h-4 w-4 text-fuchsia-300" />
      <AlertTitle className="flex flex-wrap items-center gap-2 text-fuchsia-200">
        {name} add-on read
        <Badge variant="outline" className={ADD_ON_TONE[addOn.recommendation]}>
          {ADD_ON_LABEL[addOn.recommendation]}
        </Badge>
        <Badge variant="outline" className={FLAME_STAGE_TONE[flame.flameStage]}>
          {FLAME_STAGE_LABEL[flame.flameStage]}
        </Badge>
        {stale && (
          <Badge
            variant="outline"
            className="border-amber-500/40 bg-amber-500/10 text-warning"
            data-testid="ls-scalp-addon-not-live"
          >
            Not live
          </Badge>
        )}
      </AlertTitle>
      <AlertDescription className="space-y-1 text-xs">
        {stale ? (
          <p className="flex items-start gap-1 text-warning" data-testid="ls-scalp-addon-stale">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              {when
                ? `Your open positions here are from your MT5 bridge's reading at ${when}, not live. `
                : "No reading time is recorded for your open positions, so they may not be current. "}
              They may have changed or closed since. This add-on read describes that reading.
            </span>
          </p>
        ) : when ? (
          <p className="text-[11px] text-muted-foreground/70" data-testid="ls-scalp-addon-as-of">
            Positions as reported by your MT5 bridge at {when}.
          </p>
        ) : null}
        <p className="text-muted-foreground">{addOn.reason}</p>
        <p className="text-muted-foreground">
          {addOn.usedAddOns}/{addOn.maxAddOns} adds used
          {addOn.remainingAddOns > 0 ? ` · ${addOn.remainingAddOns} left` : " · none left"}
        </p>
        {addOn.revengeGuardTriggered && (
          <p className="flex items-center gap-1 text-rose-300">
            <AlertTriangle className="h-3 w-3" /> Revenge-trade guard is on — adding here looks emotional, not planned.
          </p>
        )}
        <p className="text-[11px] text-muted-foreground/70">
          Guidance only — this doesn't change the Confirm decision below.
        </p>
      </AlertDescription>
    </Alert>
  );
}

export default LiveScalpAddOnPanel;
