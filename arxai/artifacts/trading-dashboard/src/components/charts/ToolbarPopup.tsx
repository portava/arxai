import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * A toolbar menu button whose controls float over the chart instead of taking
 * a row of their own. The controls stay mounted while closed, so their state,
 * focus targets and labels are unchanged; only their visibility differs.
 *
 * The popup opens under its button and flips to the button's right edge when
 * it would otherwise run off the side of the window.
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
  const [alignEnd, setAlignEnd] = useState(false);
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // The chart card clips its contents, so fit inside it rather than the window.
    const card = triggerRef.current?.closest<HTMLElement>('[data-testid="arx-native-chart"]')?.getBoundingClientRect();
    const left = card?.left ?? 0, right = card?.right ?? window.innerWidth;
    const width = Math.min(416, window.innerWidth * 0.9);
    // Prefer the left edge; flip only when that overflows and the flip fits.
    setAlignEnd(rect.left + width > right - 8 && rect.right - width >= left + 8);
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
        ? `absolute z-40 mt-1 flex flex-wrap items-center gap-2 rounded-md border border-zinc-700 bg-zinc-950 p-3 text-xs shadow-xl shadow-black/50 top-full w-max max-w-[min(90vw,26rem)] ${alignEnd ? "right-0" : "left-0"}`
        : "hidden"}>
      {children}
    </div>
  </div>;
}
