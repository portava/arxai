import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, ChevronDown, ChevronUp, type LucideIcon } from "lucide-react";
import type { RoutePanelLayout } from "./shellLayoutModel";
import { railPanels, sideIsRailed, panelIsClosed } from "./sidePanelModel";
import { PanelController, usePanelController, type PanelEdge } from "./PanelController";
import "./side-panel-area.css";
import "./panel-motion.css";

export type SidePanelItem = { id: string; title: string; icon: LucideIcon };
const SidePanelContext = createContext<{ side: PanelEdge } | null>(null);
export const useSidePanelArea = () => useContext(SidePanelContext);
type Props<T extends RoutePanelLayout> = {
  side: PanelEdge; panels: readonly SidePanelItem[]; layout: T; onChange: (layout: T) => void;
  children: ReactNode; className?: string; quickAction?: ReactNode;
  columnIds?: readonly string[]; showGroupToggle?: boolean;
};

/** Can share a page-wide controller, or own a specialist route's controller. */
export function SidePanelArea<T extends RoutePanelLayout>(props: Props<T>) {
  const controller = usePanelController();
  return controller ? <Area {...props}/> : <PanelController layout={props.layout} onChange={props.onChange}><Area {...props}/></PanelController>;
}

function Area<T extends RoutePanelLayout>({
  side, panels, layout, onChange, children, className = "", quickAction, columnIds, showGroupToggle = true,
}: Props<T>) {
  const controller = usePanelController()!;
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setSlot(document.querySelector<HTMLElement>("[data-route-layout-slot]")); }, []);
  const ids = panels.map(panel => panel.id);
  const closed = controller.enabled ? ids.filter(id => controller.mode(id) !== "open") : [];
  const fullRail = controller.enabled && (columnIds ?? ids).every(id => controller.mode(id) !== "open");
  const Open = side === "left" ? PanelLeftOpen : side === "right" ? PanelRightOpen : ChevronUp;
  const Close = side === "left" ? PanelLeftClose : side === "right" ? PanelRightClose : ChevronDown;
  const changeSide = (rail: boolean) => onChange(railPanels(layout, columnIds ?? ids, rail));
  const label = side[0].toUpperCase() + side.slice(1);
  return <SidePanelContext.Provider value={{ side }}>
    <div className={`arx-side-area ${className}`} data-side={side} data-railed={fullRail}>
      <div className="arx-side-tools" role="toolbar" aria-label={`${label} tools`}>
        {showGroupToggle && <button type="button" className="arx-side-toggle"
          aria-label={`${fullRail ? "Expand" : "Collapse"} ${side} tools`}
          title={`${fullRail ? "Expand" : "Collapse"} ${side} tools`} aria-expanded={!fullRail}
          disabled={!fullRail && ids.every(id => layout.pinned.includes(id))} onClick={() => changeSide(!fullRail)}>
          {fullRail ? <Open size={17} aria-hidden="true"/> : <Close size={17} aria-hidden="true"/>}
        </button>}
        <div className="arx-side-tool-buttons">
          {panels.filter(panel => closed.includes(panel.id)).map(({ id, title, icon: Icon }) =>
            <button key={id} type="button" className="arx-side-icon" data-panel-rail-icon={id}
              aria-controls={`workspace-${id}`} aria-expanded={controller.mode(id) === "peek"}
              aria-label={`Open ${title}`} title={`Open ${title}`} onClick={() => controller.peek(id)}>
              <Icon size={17} aria-hidden="true"/>
            </button>)}
          {closed.includes("order") && quickAction}
        </div>
      </div>
      {children}
    </div>
    {slot && controller.enabled && createPortal(<fieldset className="arx-side-layout-options">
      <legend>{label} tools</legend>
      <button type="button" aria-pressed={!fullRail} onClick={() => changeSide(false)}>Shown</button>
      <button type="button" aria-pressed={fullRail} disabled={ids.every(id => layout.pinned.includes(id))}
        onClick={() => changeSide(true)}>Rail</button>
      {layout.pinned.some(id => ids.includes(id)) && <small>Pinned panels stay shown</small>}
    </fieldset>, slot)}
  </SidePanelContext.Provider>;
}
