import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ChevronDown, ChevronUp, Pin, PinOff, Search } from "lucide-react";
import { cn } from "@/lib/utils";

export type LayoutPanelProps = {
  id: string;
  title: string;
  icon?: LucideIcon;
  collapsed: boolean;
  pinned: boolean;
  onCollapse: () => void;
  onPin: () => void;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  hidden?: boolean;
};

/** Shared accessible pin/collapse surface for Cockpit and specialist routes. */
export function LayoutPanel({
  id,
  title,
  icon: Icon = Search,
  collapsed,
  pinned,
  onCollapse,
  onPin,
  children,
  className,
  bodyClassName,
  hidden = false,
}: LayoutPanelProps) {
  const isCollapsed = collapsed && !pinned;
  return (
    <section
      id={`workspace-${id}`}
      hidden={hidden}
      className={cn("arx-panel min-w-0", className)}
      aria-label={title}
      tabIndex={-1}
      data-layout-panel={id}
    >
      <div className="arx-panel-head">
        <div className="flex min-w-0 items-center gap-2">
          <Icon size={15} className="text-cyan-300" aria-hidden="true" />
          <h2 className="truncate">{title}</h2>
          {pinned && <span className="arx-pin-label">PINNED</span>}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-pressed={pinned}
            aria-label={pinned ? `Unpin ${title}` : `Pin ${title}`}
            title={pinned ? "Unpin panel" : "Pin panel"}
            onClick={onPin}
            className="arx-icon-btn"
            data-testid={`layout-panel-pin-${id}`}
          >
            {pinned ? <PinOff size={13} aria-hidden="true" /> : <Pin size={13} aria-hidden="true" />}
          </button>
          <button
            type="button"
            disabled={pinned}
            aria-expanded={!isCollapsed}
            aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${title}`}
            title={pinned ? "Pinned panels stay expanded" : `${isCollapsed ? "Expand" : "Collapse"} panel`}
            onClick={onCollapse}
            className="arx-icon-btn"
            data-testid={`layout-panel-collapse-${id}`}
          >
            {isCollapsed ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronUp size={14} aria-hidden="true" />}
          </button>
        </div>
      </div>
      {!isCollapsed && <div className={cn("arx-panel-body", bodyClassName)}>{children}</div>}
    </section>
  );
}
