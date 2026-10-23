import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RefreshCw, ChevronDown, ChevronUp, Crosshair } from "lucide-react";
import { useCreateMeScalpFocus } from "@workspace/api-client-react";
import type { ScalpResult, ScalpMode } from "@workspace/api-client-react";
import { ScalpSignalCard, SCALP_SIGNAL_BUS_TIMEFRAME } from "./ScalpSignalCard";
import type { PublishedScannerAction } from "@/lib/scannerActionability";
import { useSelectedActionStore } from "@/components/scanner/selectedActionStore";
import { useAssistantName } from "@/lib/assistant-name";

// RubyScalpFocusCard (T003) — the Focus-tab "Ruby Scalp Signal" card. It
// reads the shared chart symbol, asks the shared scalp engine to evaluate
// THAT symbol, and renders the result. Re-evaluates whenever the symbol
// changes; a manual Refresh re-runs on demand. Collapsible + mobile-clean.
//
// SAFETY: read-only evaluation. Building a trade is delegated to onBuild,
// which routes through the existing gated trade ticket.

export function RubyScalpFocusCard({
  symbol,
  mode = "ANY",
  onBuild,
}: {
  symbol: string | null | undefined;
  mode?: ScalpMode;
  onBuild?: (r: ScalpResult) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [result, setResult] = useState<ScalpResult | null>(null);
  const { name } = useAssistantName();
  const focus = useCreateMeScalpFocus();
  const { mutate } = focus;

  // Publish the selected-symbol verdict the scalp card computes so the header's
  // Action cell shows EXACTLY it (Task #600). The verdict is keyed by symbol AND
  // the scalp's timeframe (the card publishes its real "1m" read), so when the
  // symbol OR timeframe switches we clear the PREVIOUS symbol+timeframe key
  // first, and clear on unmount — a stale verdict can never linger for a
  // symbol/timeframe whose Focus card is no longer mounted there. `setAction` is
  // stable, so this callback is too.
  const { set: setAction } = useSelectedActionStore();
  const lastKeyRef = useRef<{ symbol: string; timeframe: string } | null>(null);
  /** The `${symbol}|${mode}` of the most recently ISSUED scalp read — late
   *  responses for any other symbol/mode are dropped so a slow old read can't
   *  repaint after a switch. */
  const requestKeyRef = useRef<string | null>(null);
  /** Last `${symbol}|${mode}` the fetch effect ran for — guards against
   *  identity-only effect re-runs retracting a published verdict. */
  const lastRunKeyRef = useRef<string | null>(null);
  const publishAction = useCallback(
    (pubSymbol: string, pubTimeframe: string, action: PublishedScannerAction) => {
      const prev = lastKeyRef.current;
      if (prev && (prev.symbol !== pubSymbol || prev.timeframe !== pubTimeframe)) {
        setAction(prev.symbol, prev.timeframe, null);
      }
      lastKeyRef.current = { symbol: pubSymbol, timeframe: pubTimeframe };
      setAction(pubSymbol, pubTimeframe, action);
    },
    [setAction],
  );
  useEffect(() => {
    return () => {
      const prev = lastKeyRef.current;
      if (prev) setAction(prev.symbol, prev.timeframe, null);
    };
  }, [setAction]);

  useEffect(() => {
    const sym = (symbol ?? "").trim();
    // Re-run ONLY on a real symbol/mode change. The effect also re-fires when a
    // dep's identity changes (e.g. `mutate` from a re-render); retracting the
    // published verdict on such a run would wipe the header's lifted verdict
    // without a republish. Key-guard makes identity-only re-runs a no-op.
    const runKey = `${sym}|${mode}`;
    if (lastRunKeyRef.current === runKey) return;
    lastRunKeyRef.current = runKey;
    // Cold-start honesty on symbol/mode switch: drop the PREVIOUS symbol's
    // rendered result AND retract its published verdict immediately, so neither
    // the old card nor a stale lifted verdict can flash under the new selection
    // while the new read is in flight (the header shows the neutral pending
    // state in that gap).
    setResult(null);
    const prev = lastKeyRef.current;
    if (prev) {
      setAction(prev.symbol, prev.timeframe, null);
      lastKeyRef.current = null;
    }
    if (!sym) return;
    requestKeyRef.current = runKey;
    mutate(
      { data: { symbol: sym, mode } },
      // Late-response guard: only adopt the result if this response is for the
      // symbol+mode still selected (a slow read for the OLD selection must not
      // repaint after a switch already cleared it). On failure, publish the
      // honest CHECK_FAILED display marker for the scalp bus key so the
      // header's Action cell resolves immediately ("Check failed") instead of
      // waiting for the pending timeout — a later successful read/refresh
      // overwrites it with the real verdict.
      {
        onSuccess: (data) => { if (requestKeyRef.current === runKey) setResult(data); },
        onError: () => {
          if (requestKeyRef.current === runKey) {
            publishAction(sym, SCALP_SIGNAL_BUS_TIMEFRAME, "CHECK_FAILED");
          }
        },
      },
    );
  }, [symbol, mode, mutate, setAction, publishAction]);

  const sym = (symbol ?? "").trim();

  const runRefresh = () => {
    if (!sym) return;
    const runKey = `${sym}|${mode}`;
    requestKeyRef.current = runKey;
    mutate(
      { data: { symbol: sym, mode } },
      {
        onSuccess: (data) => { if (requestKeyRef.current === runKey) setResult(data); },
        onError: () => {
          if (requestKeyRef.current === runKey) {
            publishAction(sym, SCALP_SIGNAL_BUS_TIMEFRAME, "CHECK_FAILED");
          }
        },
      },
    );
  };

  return (
    <Card data-testid="ruby-scalp-focus" className="rounded-2xl border-ruby/25 bg-card">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-ruby/15 text-ruby ring-1 ring-ruby/25">
              <Crosshair className="h-[18px] w-[18px]" />
            </span>
            {name} Scalp Signal
          </CardTitle>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={runRefresh}
              disabled={!sym || focus.isPending}
              data-testid="ruby-scalp-focus-refresh"
            >
              <RefreshCw className={`h-4 w-4 ${focus.isPending ? "animate-spin" : ""}`} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={() => setCollapsed((c) => !c)}
              data-testid="ruby-scalp-focus-collapse"
            >
              {collapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </CardHeader>

      {!collapsed && (
        <CardContent className="space-y-3">
          {!sym && (
            <p className="text-sm text-muted-foreground">
              Pick a market above to get {name}'s live scalp read.
            </p>
          )}
          {sym && focus.isError && (
            <p className="text-sm text-danger">
              {name} couldn't read this market right now. Try Refresh in a moment.
            </p>
          )}
          {sym && focus.isPending && !result && (
            <p className="text-sm text-muted-foreground animate-pulse">
              {name} is reading {sym}…
            </p>
          )}
          {result && (
            <ScalpSignalCard
              result={result}
              onBuild={onBuild}
              onActionability={publishAction}
            />
          )}
        </CardContent>
      )}
    </Card>
  );
}

export default RubyScalpFocusCard;
