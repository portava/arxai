/**
 * Wires the live ARX app status into the assistant context so answers
 * can reference real state (MT5 deferred, sim engine, intent count, symbol).
 *
 * IMPORTANT — role handling:
 *   We do NOT trust any client-set role. The optional `uiRoleHint` is a UI
 *   convenience only. The server is the source of truth for permissions.
 *   The diagnostics panel is gated by a URL-query opt-in (?assistant-diag=1)
 *   so testers can flip it on without us inventing a client-side role.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useChartSymbol } from "@/lib/use-chart-symbol";
import { resolveRoute } from "@/knowledge/routeKnowledge";
import type { AskContext } from "@/knowledge/answerEngine";

interface DeferStatus {
  deferred: boolean;
  systemState: string;
  bridgeConnected: boolean;
  brokerProvider?: string;
}

export interface AssistantLiveContext extends AskContext {
  /** True when the URL has ?assistant-diag=1 — surfaces the diagnostics panel. */
  diagnosticsRequested: boolean;
  /** Raw values for the diagnostics panel. */
  raw: {
    chartSymbol: string;
    intentCount: number | null;
    simRunning: boolean;
    defer: DeferStatus | null;
  };
}

export function useAssistantContext(): AssistantLiveContext {
  const [location] = useLocation();
  const [chartSymbol] = useChartSymbol();
  const [defer, setDefer] = useState<DeferStatus | null>(null);
  const [intentCount, setIntentCount] = useState<number | null>(null);
  const [simRunning, setSimRunning] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void fetch("/api/system/mt5-deferred-status")
        .then((r) => (r.ok ? r.json() : null))
        .then((d: DeferStatus | null) => { if (!cancelled && d) setDefer(d); })
        .catch(() => { /* ignore */ });
      void fetch("/api/live-intent/queue")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (!cancelled && d?.counts) setIntentCount(d.counts.total ?? 0); })
        .catch(() => { /* ignore */ });
      void fetch("/api/market/session-status")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (!cancelled && d) setSimRunning(!!d.running); })
        .catch(() => { /* ignore */ });
    };
    refresh();
    const t = window.setInterval(refresh, 8000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, []);

  const diagnosticsRequested = useMemo(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("assistant-diag") === "1";
  }, []);

  return useMemo<AssistantLiveContext>(() => {
    const route = location;
    const pageTitle = resolveRoute(route)?.title;

    const safetyStatuses: string[] = [
      "FULL TESTER ACCESS",
      "LIVE BROKER EXECUTION DISABLED",
    ];
    if (defer?.deferred) safetyStatuses.push("MT5 DEFERRED · SIMULATOR MODE");
    if (simRunning) safetyStatuses.push("SIM ENGINE");
    if (chartSymbol) safetyStatuses.push(`FX: ${chartSymbol}`);
    if (intentCount !== null) safetyStatuses.push(`${intentCount} INTENTS`);

    const mt5Hint: AskContext["mt5Hint"] = defer?.bridgeConnected
      ? "connected"
      : defer?.deferred
        ? "deferred"
        : "disconnected";

    const tradingModeHint = defer?.bridgeConnected ? "broker-readonly" : "paper";

    return {
      route,
      pageTitle,
      safetyStatuses,
      mt5Hint,
      tradingModeHint,
      // uiRoleHint intentionally omitted — server is the source of truth.
      diagnosticsRequested,
      raw: { chartSymbol, intentCount, simRunning, defer },
    };
  }, [location, chartSymbol, defer, intentCount, simRunning, diagnosticsRequested]);
}
