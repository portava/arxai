import { useEffect, useState } from "react";
import { markActionStart, markActionEnd, markRenderComplete } from "@/lib/perf";
import { resolveSymbol } from "@/lib/symbolRegistry";

// Build TT — shared chart symbol. Bridges the chart and the trade ticket
// without disturbing the existing SymbolProvider. Persists in localStorage and
// emits a window event so all panels stay in sync.
//
// Task #558 — the bus is locked to the 36 approved ARX Focus markets. The
// default is V75 (ARX's primary market) and ANY symbol that does not resolve to
// an approved Focus market — a stale localStorage value, a removed market, or
// an off-universe push — is redirected to V75 on both read and write. The
// frontend symbol registry (`resolveSymbol`) is itself locked to the 36, so a
// non-resolving bare symbol is, by definition, not an approved Focus market.
const KEY = "highroll.chartSymbol";
const EVT = "highroll-chart-symbol";
const DEFAULT = "V75";

/** Coerce any chart-bus symbol to an approved Focus market, else V75. Preserves
 *  an exchange prefix (e.g. "FX:EURUSD") when the bare symbol is approved. */
function approvedChartSymbol(raw: string | null | undefined): string {
  if (!raw) return DEFAULT;
  const bare = raw.includes(":") ? raw.split(":")[1]! : raw;
  return resolveSymbol(bare) ? raw : DEFAULT;
}

export function getChartSymbol(): string {
  if (typeof window === "undefined") return DEFAULT;
  return approvedChartSymbol(localStorage.getItem(KEY));
}

export function setChartSymbol(rawSymbol: string) {
  if (typeof window === "undefined") return;
  // Redirect off-universe writes to V75 before they ever reach the bus.
  const s = approvedChartSymbol(rawSymbol);
  // PART 3 — instrument the symbol-switch propagation. Every listener
  // (chart, trade panel, ticket, Ruby) fires synchronously inside the
  // dispatchEvent below, so the end-mark is captured *after* every
  // useState setter has scheduled a render. The actual paint is measured
  // via markRenderComplete on the next animation frame — that's the
  // real "dropdown click → label updated" budget number.
  const pid = markActionStart("chart.symbolSwitch", { page: typeof location !== "undefined" ? location.pathname : undefined });
  localStorage.setItem(KEY, s);
  window.dispatchEvent(new CustomEvent(EVT, { detail: s }));
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => {
      markRenderComplete(pid);
      markActionEnd(pid);
    });
  } else {
    markActionEnd(pid);
  }
}

/** Plain symbol (no exchange prefix) — useful for trade tickets. */
export function bareSymbol(s: string): string {
  return s.includes(":") ? s.split(":")[1]! : s;
}

export function useChartSymbol(): [string, (s: string) => void] {
  const [s, setS] = useState<string>(() => getChartSymbol());
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (typeof detail === "string") setS(detail);
    };
    const storage = (e: StorageEvent) => { if (e.key === KEY && e.newValue) setS(e.newValue); };
    window.addEventListener(EVT, handler);
    window.addEventListener("storage", storage);
    return () => { window.removeEventListener(EVT, handler); window.removeEventListener("storage", storage); };
  }, []);
  return [s, setChartSymbol];
}
