import { startTransition, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Keep the first route commit focused on the chart and account/trade health.
 * Secondary panels mount once after two rendering opportunities; their normal
 * subscriptions and state then remain mounted. This is not a data-ready gate. */
export function ScannerSecondaryPanels({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const revealNow = useRef<(() => void) | null>(null);
  const root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null), moveFocus = useRef(false);
  useLayoutEffect(() => {
    if (mounted && moveFocus.current) { moveFocus.current = false; root.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"],button,input,select,a[href]')?.focus({ preventScroll: true }); }
  }, [mounted]);
  useEffect(() => {
    let disposed = false, finished = false, frame: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cancel = () => { if (frame !== null) cancelAnimationFrame(frame); if (timer !== null) clearTimeout(timer); frame = null; timer = null; };
    const reveal = (urgent = false) => {
      if (disposed || finished) return;
      finished = true;
      moveFocus.current = document.activeElement === button.current;
      cancel();
      if (urgent) setMounted(true); else startTransition(() => setMounted(true));
    };
    revealNow.current = () => reveal(true);
    // A hidden tab may suspend RAF. Do not leave its panels pending indefinitely.
    timer = setTimeout(() => reveal(), 250);
    frame = requestAnimationFrame(() => {
      if (disposed || finished) return;
      frame = requestAnimationFrame(() => { frame = null; reveal(); });
    });
    return () => { disposed = true; cancel(); revealNow.current = null; };
  }, []);
  return <div ref={root} data-testid="scanner-secondary-panels" aria-busy={!mounted}>{mounted ? children : <div className="min-h-32 rounded-xl border border-border p-4" data-testid="scanner-secondary-pending">
    <p role="status" className="text-sm text-txt-muted">Loading scanner panels…</p>
    <button ref={button} type="button" className="mt-2 rounded-md border border-border px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2" onClick={() => revealNow.current?.()}>Show scanner panels now</button>
  </div>}</div>;
}
