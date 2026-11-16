// OneClickModeDisclaimer — the one dialog a user sees before one-click mode
// turns on. It states exactly what changes across the app, requires the
// checkbox, and calls `onAccept`. Turning the mode OFF never needs this dialog.
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle, Zap } from "lucide-react";
import type { OneClickModeView } from "@/lib/oneClickMode";

export const ONE_CLICK_MODE_CHANGES: readonly string[] = [
  "Buy and Sell buttons on the chart, scanner, trade panel and watchlist place a market order the moment you click. No ticket, no confirmation.",
  "Close (×) on any open position closes it the moment you click. No confirmation dialog.",
  "Orders use the lot size shown in the one-click bar, or your saved default lot when none is shown.",
  "Every server-side protection still runs on each click: account approval, lot caps, exposure, cooldowns, stale-price checks. A blocked click tells you why.",
  "This applies to the whole app for this account until you turn one-click off. You can turn it off at any time from the same switch.",
];

export function OneClickModeDisclaimer({
  open,
  onOpenChange,
  mode,
  busy,
  onAccept,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: OneClickModeView;
  busy: boolean;
  onAccept: () => void;
}) {
  const [agreed, setAgreed] = useState(false);
  useEffect(() => { if (!open) setAgreed(false); }, [open]);

  const scopeLabel = mode.scope === "live" ? "LIVE" : mode.scope === "demo" ? "DEMO" : "this";

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v); }}>
      <DialogContent className="max-w-lg" data-testid="one-click-disclaimer">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-amber-400" />
            Turn on one-click trading ({scopeLabel})
          </DialogTitle>
          <DialogDescription>
            One-click works like MT5's one-click panel: the first click trades. Read what changes before you accept.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          {mode.scope === "live" && (
            <Alert className="border-rose-500/40 bg-rose-500/5">
              <AlertTriangle className="h-4 w-4 text-rose-400" />
              <AlertTitle>Real money</AlertTitle>
              <AlertDescription className="text-xs">
                This is your LIVE account. Each click sends a real market order to your broker.
              </AlertDescription>
            </Alert>
          )}

          <ul className="space-y-2 text-sm" data-testid="one-click-disclaimer-changes">
            {ONE_CLICK_MODE_CHANGES.map((line, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                <span>{line}</span>
              </li>
            ))}
          </ul>

          {!mode.canEnable && mode.blockReason && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Cannot turn on</AlertTitle>
              <AlertDescription className="text-xs">{mode.blockReason}</AlertDescription>
            </Alert>
          )}

          <div className="flex items-start gap-3 rounded-md border border-border bg-background/40 p-3">
            <Checkbox
              id="one-click-mode-agree"
              checked={agreed}
              onCheckedChange={(v) => setAgreed(v === true)}
              disabled={busy || !mode.canEnable}
              data-testid="one-click-disclaimer-agree"
            />
            <Label htmlFor="one-click-mode-agree" className="cursor-pointer text-sm leading-snug">
              I understand that the entire app switches to one-click: Buy, Sell and Close execute immediately
              without a confirmation, and I accept responsibility for every click.
            </Label>
          </div>
        </div>

        <DialogFooter className="flex gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button
            onClick={onAccept}
            disabled={busy || !agreed || !mode.canEnable}
            className="bg-amber-600 text-white hover:bg-amber-700"
            data-testid="one-click-disclaimer-accept"
          >
            {busy ? "Turning on…" : "I accept — turn on one-click"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
