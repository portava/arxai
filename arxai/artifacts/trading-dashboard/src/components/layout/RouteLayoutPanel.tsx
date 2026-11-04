import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { LayoutPanel } from "./LayoutPanel";
import { useRoutePanelLayout } from "./useRoutePanelLayout";

export function RouteLayoutPanel({
  routeKey,
  id,
  title,
  icon,
  children,
  className,
  keepMounted,
}: {
  routeKey: string;
  id: string;
  title: string;
  icon: LucideIcon;
  children: ReactNode;
  className?: string;
  keepMounted?: boolean;
}) {
  const { layout, setLayout } = useRoutePanelLayout(routeKey, [id]);
  const collapsed = layout.collapsed.includes(id);
  const pinned = layout.pinned.includes(id);

  return <LayoutPanel
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
    })}
  >{children}</LayoutPanel>;
}
