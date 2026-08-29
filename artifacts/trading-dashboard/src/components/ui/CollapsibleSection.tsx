import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CollapsibleSectionProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Persists open/closed state per user under this key. */
  storageKey?: string;
  defaultOpen?: boolean;
  rightSlot?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  testId?: string;
}

/**
 * Compact, accordion-style section. Header is always visible; body collapses
 * to zero footprint when closed. Open/closed state is remembered locally per
 * user when a storageKey is supplied — meets the brief's "default collapsed
 * state should be remembered locally per user".
 */
export function CollapsibleSection(props: CollapsibleSectionProps) {
  const { title, description, storageKey, defaultOpen = false, rightSlot, children, className, testId } = props;
  const initial = (() => {
    if (!storageKey || typeof window === "undefined") return defaultOpen;
    try {
      const v = window.localStorage.getItem(`arx.collapsible.${storageKey}`);
      if (v === "1") return true;
      if (v === "0") return false;
    } catch { /* ignore */ }
    return defaultOpen;
  })();
  const [open, setOpen] = React.useState(initial);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (storageKey && typeof window !== "undefined") {
      try { window.localStorage.setItem(`arx.collapsible.${storageKey}`, next ? "1" : "0"); } catch { /* ignore */ }
    }
  }

  return (
    <div
      className={cn("rounded-lg border border-border/60 bg-card/40", className)}
      data-testid={testId}
    >
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/40 rounded-lg transition-colors"
        aria-expanded={open}
        data-testid={testId ? `${testId}-toggle` : undefined}
      >
        <ChevronDown
          className={cn("h-4 w-4 text-muted-foreground transition-transform", open ? "rotate-0" : "-rotate-90")}
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-foreground">{title}</div>
          {description && <div className="text-xs text-muted-foreground truncate">{description}</div>}
        </div>
        {rightSlot && <div className="ml-2 flex items-center gap-2">{rightSlot}</div>}
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1" data-testid={testId ? `${testId}-body` : undefined}>
          {children}
        </div>
      )}
    </div>
  );
}
