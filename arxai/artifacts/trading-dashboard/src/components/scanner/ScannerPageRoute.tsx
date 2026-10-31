import { useEffect, useState } from "react";
import { getLoadedMarketScannerPage, loadMarketScannerPage } from "@/lib/scannerRoute";

/** A warmed route renders synchronously. For a cold visit, show its own shell
 * while loading instead of suspending the entire router. This avoids the outer
 * Suspense fallback holding an already-ready Scanner behind its reveal delay. */
export function ScannerPageRoute() {
  const [state, setState] = useState(() => ({ module: getLoadedMarketScannerPage(), error: null as unknown }));
  useEffect(() => {
    if (state.module) return;
    let active = true;
    loadMarketScannerPage().then(
      module => { if (active) setState({ module, error: null }); },
      error => { if (active) setState({ module: undefined, error }); },
    );
    return () => { active = false; };
  }, [state.module]);
  if (state.error) throw state.error;
  if (state.module) {
    const Page = state.module.default;
    return <Page />;
  }
  return <div className="mx-auto w-full max-w-[1200px] pt-2" role="status" aria-live="polite">
    <p className="text-sm text-muted-foreground">Opening Market Scanner…</p>
    <div className="mt-4 h-[420px] rounded-lg border border-border bg-card" aria-hidden="true" />
  </div>;
}
