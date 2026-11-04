import type { ReactNode } from "react";
import { Activity, type LucideIcon } from "lucide-react";
import { LayoutPanel } from "./LayoutPanel";
import { useRoutePanelLayout } from "./useRoutePanelLayout";
import { SidePanelArea } from "./SidePanelArea";

export function RouteLayoutPanel({
  routeKey,
  id,
  title,
  icon,
  children,
  className,
  keepMounted,
  side,
}: {
  routeKey: string;
  id: string;
  title: string;
  icon: LucideIcon;
  children: ReactNode;
  className?: string;
  keepMounted?: boolean;
  /** For routes with a real side area; full-width sections remain full-width. */
  side?: "left" | "right";
}) {
  const { layout, setLayout } = useRoutePanelLayout(routeKey, [id, "chart-details"]);
  const collapsed = layout.collapsed.includes(id);
  const pinned = layout.pinned.includes(id);
  const chartPage = routeKey.replace(/^\//, "") === "market-scanner";

  const panel = <LayoutPanel
    id={id}
    title={title}
    icon={icon}
    collapsed={collapsed}
    pinned={pinned}
    className={className}
    keepMounted={keepMounted}
    onCollapse={() => {
      if (pinned) return;
      setLayout({
        ...layout,
        collapsed: collapsed
          ? layout.collapsed.filter(panelId => panelId !== id)
          : [...layout.collapsed, id],
      });
    }}
    onPin={() => setLayout({
      ...layout,
      pinned: pinned
        ? layout.pinned.filter(panelId => panelId !== id)
        : [...layout.pinned, id],
      collapsed: pinned
        ? layout.collapsed
        : layout.collapsed.filter(panelId => panelId !== id),
      railed: (layout.railed ?? []).filter(panelId => panelId !== id),
      ...(layout.peek === id ? { peek: undefined } : {}),
    })}
  >{children}</LayoutPanel>;
  return <SidePanelArea side={side ?? "left"} panels={[{ id, title, icon },
    ...(chartPage ? [{ id: "chart-details", title: "Smart Chart details", icon: Activity }] : [])]}
    layout={layout} onChange={setLayout} className="arx-route-panel-area" showGroupToggle={false}>
    {panel}
    {chartPage && <div data-panel-details-slot/>}
  </SidePanelArea>;
}
