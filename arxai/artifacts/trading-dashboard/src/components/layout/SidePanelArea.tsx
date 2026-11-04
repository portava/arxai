import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, type LucideIcon } from "lucide-react";
import type { RoutePanelLayout } from "./shellLayoutModel";
import { railPanels, revealPanel, sideIsRailed } from "./sidePanelModel";
import "./side-panel-area.css";

type Side = "left" | "right";
export type SidePanelItem = { id: string; title: string; icon: LucideIcon };
const SidePanelContext = createContext<{
  side: Side;
  railed: string[];
  sendToRail: (id: string) => void;
} | null>(null);

export const useSidePanelArea = () => useContext(SidePanelContext);

/** Presentation only: data and account providers stay owned by the authorized page. */
export function SidePanelArea<T extends RoutePanelLayout>({
  side, panels, layout, onChange, children, className = "", quickAction,
}: {
  side: Side;
  panels: readonly SidePanelItem[];
  layout: T;
  onChange: (layout: T) => void;
  children: ReactNode;
  className?: string;
  quickAction?: ReactNode;
}) {
  const [desktop, setDesktop] = useState(() => typeof window !== "undefined" && window.innerWidth >= 1024);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const frame = useRef<number | null>(null);
  useEffect(() => {
    const update = () => setDesktop(window.innerWidth >= 1024);
    window.addEventListener("resize", update);
    setSlot(document.querySelector<HTMLElement>("[data-route-layout-slot]"));
    return () => {
      window.removeEventListener("resize", update);
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    };
  }, []);
  const ids = panels.map(panel => panel.id);
  const railed = desktop ? (layout.railed ?? []).filter(id => ids.includes(id) && !layout.pinned.includes(id)) : [];
  const fullRail = desktop && sideIsRailed(layout, ids);
  const Open = side === "left" ? PanelLeftOpen : PanelRightOpen;
  const Close = side === "left" ? PanelLeftClose : PanelRightClose;
  const changeSide = (rail: boolean) => onChange(railPanels(layout, ids, rail));
  const focusAfterRender = (selector: string, scroll: boolean) => {
    const ownerDocument = document;
    if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    frame.current = window.requestAnimationFrame(() => {
      frame.current = null;
      const target = ownerDocument.querySelector<HTMLElement>(selector);
      if (scroll) target?.scrollIntoView({ block: "nearest" });
      target?.focus({ preventScroll: true });
    });
  };
  const openPanel = (id: string) => {
    onChange(revealPanel(layout, id));
    focusAfterRender(`[data-layout-panel="${id}"]`, true);
  };
  return <SidePanelContext.Provider value={{
    side, railed,
    sendToRail: id => {
      onChange(railPanels(layout, [id], true));
      focusAfterRender(`[data-side-panel-open="${side}-${id}"]`, false);
    },
  }}>
    <div className={`arx-side-area ${className}`} data-side={side} data-railed={fullRail}>
      <div className="arx-side-tools" role="toolbar" aria-label={`${side === "left" ? "Left" : "Right"} tools`}>
        <button type="button" className="arx-side-toggle"
          aria-label={`${fullRail ? "Expand" : "Collapse"} ${side} tools`}
          title={`${fullRail ? "Expand" : "Collapse"} ${side} tools`}
          aria-expanded={!fullRail}
          disabled={!fullRail && ids.every(id => layout.pinned.includes(id))}
          onClick={() => changeSide(!fullRail)}>
          {fullRail ? <Open size={17} aria-hidden="true"/> : <Close size={17} aria-hidden="true"/>}
        </button>
        <div className="arx-side-tool-buttons">
          {panels.filter(panel => railed.includes(panel.id)).map(({ id, title, icon: Icon }) =>
            <button key={id} type="button" className="arx-side-icon"
              data-side-panel-open={`${side}-${id}`} aria-controls={`workspace-${id}`}
              aria-label={`Open ${title}`} title={`Open ${title}`} onClick={() => openPanel(id)}>
              <Icon size={17} aria-hidden="true"/>
            </button>)}
          {railed.includes("order") && quickAction}
        </div>
      </div>
      {children}
    </div>
    {slot && desktop && createPortal(<fieldset className="arx-side-layout-options">
      <legend>{side === "left" ? "Left" : "Right"} tools</legend>
      <button type="button" aria-pressed={!fullRail} onClick={() => changeSide(false)}>Shown</button>
      <button type="button" aria-pressed={fullRail} disabled={ids.every(id => layout.pinned.includes(id))}
        onClick={() => changeSide(true)}>Rail</button>
      {layout.pinned.some(id => ids.includes(id)) && <small>Pinned panels stay shown</small>}
    </fieldset>, slot)}
  </SidePanelContext.Provider>;
}
