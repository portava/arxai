import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * A toolbar menu button whose controls float over the chart instead of taking
 * a row of their own. The controls stay mounted while closed, so their state,
 * focus targets and labels are unchanged; only their visibility differs.
 *
 * The popup opens under its button. It stays inside the nearest ancestor that
 * clips it (a scrolling tools panel, or the chart card): it flips to the
 * button's right edge, or else shifts and narrows, rather than being cut off.
 */
export function ToolbarPopup({ label, title, popupLabel, testId, children, open: controlled, onOpenChange, disabled }: {
  label: ReactNode; title?: string; popupLabel: string; testId: string; children: ReactNode;
  open?: boolean; onOpenChange?: (open: boolean) => void; disabled?: boolean;
}) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const setOpen = (next: boolean) => { if (controlled === undefined) setOwn(next); onOpenChange?.(next); };
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  // Horizontal placement relative to the trigger: null = default left edge.
  const [placement, setPlacement] = useState<PopupPlacement | null>(null);
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    const trigger = triggerRef.current;
    const rect = trigger?.getBoundingClientRect();
    if (!trigger || !rect) return;
    setPlacement(fitPopup(rect, popupBounds(trigger)));
  }, [open]);
  const latest = useRef(setOpen); latest.current = setOpen;
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) latest.current(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return <div ref={wrapRef} className="relative inline-flex" onKeyDown={event => {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault(); event.stopPropagation(); setOpen(false); triggerRef.current?.focus();
  }}>
    <Button ref={triggerRef} type="button" size="sm" variant={open ? "secondary" : "outline"} className="h-8 gap-1 text-xs" disabled={disabled}
      aria-haspopup="true" aria-expanded={open} aria-controls={id} title={title} data-testid={`${testId}-toggle`} onClick={() => setOpen(!open)}>
      {label}<ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
    </Button>
    <div id={id} role="group" aria-label={popupLabel} data-testid={`${testId}-controls`}
      className={open
        ? `absolute z-40 mt-1 flex flex-wrap items-center gap-2 rounded-md border border-zinc-700 bg-zinc-950 p-3 text-xs shadow-xl shadow-black/50 top-full w-max max-w-[min(90vw,26rem)]`
        : "hidden"}
      style={open ? { ...(placement?.alignEnd ? { right: 0 } : { left: placement?.left ?? 0 }), ...(placement ? { maxWidth: placement.maxWidth } : {}) } : undefined}>
      {children}
    </div>
  </div>;
}

const POPUP_WIDTH = 416, POPUP_GAP = 8;

/** The horizontal box the popup must stay inside: the nearest ancestor that
 * clips overflow, else the chart card, else the window. */
export function popupBounds(trigger: HTMLElement): { left: number; right: number } {
  for (let el = trigger.parentElement; el; el = el.parentElement) {
    // overflow-x clips horizontally; the shorthand's first value is the x axis.
    const style = getComputedStyle(el);
    const clips = [style.overflowX, style.overflow?.split(" ")[0]].some(value => !!value && value !== "visible");
    if (clips) {
      const box = el.getBoundingClientRect();
      if (box.width > 0) return { left: box.left, right: box.right };
    }
    if (el.dataset.testid === "arx-native-chart") break;
  }
  const card = trigger.closest<HTMLElement>('[data-testid="arx-native-chart"]')?.getBoundingClientRect();
  return { left: card?.left ?? 0, right: card?.right ?? window.innerWidth };
}

/** Popup left offset (relative to the trigger) and maximum width. Prefer the
 * trigger's left edge, then its right edge; otherwise shift so the popup starts
 * inside the bounds and narrow it to fit. */
export interface PopupPlacement { alignEnd: boolean; left: number; maxWidth: number }
export function fitPopup(trigger: { left: number; right: number }, bounds: { left: number; right: number },
  viewportWidth = typeof window === "undefined" ? POPUP_WIDTH : window.innerWidth): PopupPlacement {
  const room = Math.max(0, bounds.right - bounds.left - 2 * POPUP_GAP);
  const width = Math.min(POPUP_WIDTH, viewportWidth * 0.9, room);
  const min = bounds.left + POPUP_GAP, max = bounds.right - POPUP_GAP;
  if (trigger.left + width <= max) return { alignEnd: false, left: 0, maxWidth: width };
  if (trigger.right - width >= min) return { alignEnd: true, left: 0, maxWidth: width };
  return { alignEnd: false, left: Math.max(min, max - width) - trigger.left, maxWidth: width };
}
