import { useEffect } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Flame } from "lucide-react";
import { useCreateMeScalpAddOnCheck } from "@workspace/api-client-react";
import {
  ADD_ON_LABEL,
  ADD_ON_TONE,
  FLAME_STAGE_LABEL,
  FLAME_STAGE_TONE,
} from "@/components/scanner/scalpLabels";
import { useAssistantName } from "@/lib/assistant-name";

// LiveScalpAddOnPanel — info-only add-on guidance injected into the live
// trade ticket. It tells the user whether (and how much) it is sane to add
// to an existing scalp on this symbol+direction, with the revenge guard and
// profit-cushion check.
//
// SAFETY: 100% read-only / advisory. It NEVER touches the Confirm flow, never
// enables/disables execution, never mutates the ticket. Confirm runs the same
// server-side 16-gate evaluator regardless of what this panel shows.

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

  const addOn = data.addOn;
  const flame = data.flame;

  return (
    <Alert
      className="border-premium/30 bg-premium/5"
      data-testid="ls-scalp-addon"
      data-addon={addOn.recommendation}
    >
      <Flame className="h-4 w-4 text-premium" />
      <AlertTitle className="flex flex-wrap items-center gap-2 text-premium">
        {name} add-on read
        <Badge variant="outline" className={ADD_ON_TONE[addOn.recommendation]}>
          {ADD_ON_LABEL[addOn.recommendation]}
        </Badge>
        <Badge variant="outline" className={FLAME_STAGE_TONE[flame.flameStage]}>
          {FLAME_STAGE_LABEL[flame.flameStage]}
        </Badge>
      </AlertTitle>
      <AlertDescription className="space-y-1 text-xs">
        <p className="text-muted-foreground">{addOn.reason}</p>
        <p className="text-muted-foreground">
          {addOn.usedAddOns}/{addOn.maxAddOns} adds used
          {addOn.remainingAddOns > 0 ? ` · ${addOn.remainingAddOns} left` : " · none left"}
        </p>
        {addOn.revengeGuardTriggered && (
          <p className="flex items-center gap-1 text-danger">
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
