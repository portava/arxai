import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Activity } from "lucide-react";
import { LayoutPanel } from "./LayoutPanel";
import { usePanelController } from "./PanelController";
import { useSidePanelArea } from "./SidePanelArea";

/** The existing chart details keep their owner; only the presentation changes. */
export function ChartDetailPanel({ compact, children }: { compact: boolean; children: ReactNode }) {
  const controller = usePanelController();
  const edge = useSidePanelArea()?.side ?? "right";
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setSlot(document.querySelector<HTMLElement>("[data-panel-details-slot]")); }, []);
  if (!compact || !controller?.enabled) return <>{children}</>;
  const panel = <LayoutPanel id="chart-details" title="Smart Chart details" icon={Activity} edge={edge}
    collapsed={false} pinned={controller.isPinned("chart-details")} keepMounted
    onCollapse={() => controller.close("chart-details")} onPin={() => controller.togglePin("chart-details")}>
    {children}
  </LayoutPanel>;
  return slot ? createPortal(panel, slot) : panel;
}
