import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ChevronDown, ChevronUp, Pin, PinOff, Search, PanelLeftClose, PanelRightClose } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSidePanelArea } from "./SidePanelArea";
import { usePanelController, type PanelEdge } from "./PanelController";
import { usePanelPresence } from "./usePanelPresence";

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
  /** Preserve stateful forms and running views while their panel is collapsed. */
  keepMounted?: boolean;
  edge?: PanelEdge;
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
  keepMounted = false,
  edge,
}: LayoutPanelProps) {
  const sideArea = useSidePanelArea();
  const controller = usePanelController();
  const desktop = !!controller?.enabled;
  const mode = desktop ? controller!.mode(id) : "open";
  const presence = usePanelPresence(mode);
  const isCollapsed = !desktop && collapsed && !pinned;
  const panelEdge = edge ?? sideArea?.side ?? "left";
  const CloseIcon = panelEdge === "right" ? PanelRightClose : panelEdge === "bottom" ? ChevronDown : PanelLeftClose;
  const peeking = desktop && mode === "peek";
  return (
    <section
      ref={presence.ref}
      id={`workspace-${id}`}
      hidden={hidden || (desktop && presence.phase === "closed")}
      className={cn("arx-panel min-w-0", peeking && "arx-panel--peek", className)}
      style={desktop ? presence.style : undefined}
      data-panel-state={desktop ? presence.phase : undefined}
      data-panel-edge={panelEdge}
      data-reduced-motion={presence.reduced}
      role={peeking ? "dialog" : undefined}
      aria-modal={peeking ? true : undefined}
      aria-hidden={desktop && presence.phase === "closing" ? true : undefined}
      inert={desktop && presence.phase === "closing" ? true : undefined}
      aria-label={title}
      tabIndex={-1}
      data-layout-panel={id}
      data-collapsed={desktop ? mode !== "open" : isCollapsed}
    >
      <div className="arx-panel-head">
        <div className="flex min-w-0 items-center gap-2">
          <Icon size={15} className="text-cyan-300" aria-hidden="true" />
          <h2 className="truncate">{title}</h2>
          {pinned && <span className="arx-pin-label">PINNED</span>}
        </div>
        <div className="flex items-center gap-1">
          {peeking && <button type="button" className="arx-panel-keep-open"
            onClick={() => controller!.dock(id)} aria-label={`Keep ${title} open`}>Keep open</button>}
          <button
            type="button"
            aria-pressed={pinned}
            aria-label={pinned ? `Unpin ${title}` : `Pin ${title}`}
            title={pinned ? "Unpin panel" : "Pin panel"}
            onClick={desktop ? () => controller!.togglePin(id) : onPin}
            className="arx-icon-btn"
            data-testid={`layout-panel-pin-${id}`}
          >
            {pinned ? <PinOff size={13} aria-hidden="true" /> : <Pin size={13} aria-hidden="true" />}
          </button>
          <button
            type="button"
            disabled={pinned}
            aria-expanded={desktop ? mode !== "closed" : !isCollapsed}
            aria-label={desktop ? `Close ${title}` : `${isCollapsed ? "Expand" : "Collapse"} ${title}`}
            title={pinned ? "Pinned panels stay expanded" : `${isCollapsed ? "Expand" : "Collapse"} panel`}
            onClick={desktop ? () => { presence.capture(); controller!.close(id); } : onCollapse}
            className="arx-icon-btn"
            data-testid={`layout-panel-collapse-${id}`}
          >
            {desktop ? <CloseIcon size={14} aria-hidden="true"/> : isCollapsed ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronUp size={14} aria-hidden="true" />}
          </button>
        </div>
      </div>
      {(desktop || keepMounted || !isCollapsed) && <div hidden={isCollapsed} className={cn("arx-panel-body", bodyClassName)}>{children}</div>}
    </section>
  );
}
