import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useChartSymbol } from "@/lib/use-chart-symbol";
import { collectRuntimeContext } from "./runtimeContext";
import type { HealthSummary, BridgeDiagnosticSummary, RuntimeContext } from "./runtimeContextTypes";

const REFRESH_MS = 12_000;

async function safeJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) return null;
    return await r.json() as T;
  } catch { return null; }
}

export function useRuntimeContext(): RuntimeContext {
  const [location] = useLocation();
  const [chartSymbol] = useChartSymbol();
  const [health, setHealth] = useState<HealthSummary | null>(null);
  const [bridge, setBridge] = useState<BridgeDiagnosticSummary | null>(null);
  // null = kill-switch state unknown (read failed / not yet loaded) — the
  // context reports it as unknown rather than a fabricated "off".
  const [emergencyStop, setEmergencyStop] = useState<boolean | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      // Perf: skip the network round-trip while the tab is backgrounded.
      // The next visibilitychange (or interval tick once visible) resumes it.
      if (typeof document !== "undefined" && document.hidden) return;
      const [h, b, sys] = await Promise.all([
        safeJson<HealthSummary>("/api/app/health-summary"),
        safeJson<BridgeDiagnosticSummary>("/api/mt5/diagnostic-summary"),
        safeJson<{ killSwitchEngaged?: boolean }>("/api/system/status"),
      ]);
      if (cancelled) return;
      if (h) setHealth(h);
      if (b) setBridge(b);
      // Unlike health/bridge we do NOT keep a stale value on failure: a
      // kill-switch state we could not confirm degrades to null (unknown).
      setEmergencyStop(typeof sys?.killSwitchEngaged === "boolean" ? sys.killSwitchEngaged : null);
      setTick((t) => t + 1);
    };
    void refresh();
    const t = window.setInterval(refresh, REFRESH_MS);
    const onResize = () => setTick((x) => x + 1);
    // Resume immediately when the user returns to the tab so the runtime
    // context isn't stale for up to a full interval after refocus.
    const onVisibility = () => { if (!document.hidden) void refresh(); };
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(t);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return useMemo(() => collectRuntimeContext({
    route: location,
    selectedSymbol: chartSymbol ?? null,
    bridge,
    health,
    emergencyStop,
  }), [location, chartSymbol, bridge, health, emergencyStop, tick]);
}
