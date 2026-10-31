import { useEffect, useState, type ReactNode } from "react";

/** Give the primary chart a rendering opportunity before mounting the analysis
 * stack. This is a loading state, never chart/analysis completion evidence. */
export function ScannerAnalysisMount({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    let frame: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => { if (active) setReady(true); };
    const onVisibility = () => { if (document.hidden) finish(); };
    if (document.hidden || typeof requestAnimationFrame !== "function") finish();
    else {
      frame = requestAnimationFrame(() => {
        if (!active) return;
        // A task after the frame lets the browser render the already committed
        // chart. The bounded fallback also handles a suspended frame callback.
        timer = setTimeout(finish, 0);
      });
    }
    const fallback = setTimeout(finish, 100);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
      clearTimeout(fallback);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return <div aria-busy={!ready} data-testid="scanner-analysis-mount" data-phase={ready ? "mounted" : "loading"}>
    {ready ? children : <p role="status" className="py-4 text-sm text-muted-foreground">Loading scanner analysis panels…</p>}
  </div>;
}
