import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { RoutePanelLayout } from "./shellLayoutModel";
import { panelIsClosed, peekPanel, railPanels, revealPanel, withSlidingPanels } from "./sidePanelModel";

export type PanelEdge = "left" | "right" | "bottom";
export type PanelMode = "open" | "closed" | "peek";
type Controls = {
  enabled: boolean;
  mode: (id: string) => PanelMode;
  close: (id: string) => void;
  peek: (id: string) => void;
  dock: (id: string) => void;
  isPinned: (id: string) => boolean;
  togglePin: (id: string) => void;
};
const Context = createContext<Controls | null>(null);
export const usePanelController = () => useContext(Context);

/** Layout presentation stays below the owning page's authorization/providers. */
export function PanelController<T extends RoutePanelLayout>({ layout: saved, onChange, children }: {
  layout: T; onChange: (layout: T) => void; children: ReactNode;
}) {
  const layout = withSlidingPanels(saved);
  const [enabled, setEnabled] = useState(() => typeof window !== "undefined" && window.innerWidth >= 1024);
  const current = useRef({ layout, onChange });
  current.current = { layout, onChange };
  const frame = useRef<number | null>(null);
  const focus = (selector: string) => {
    const ownerDocument = document;
    if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    frame.current = window.requestAnimationFrame(() => {
      frame.current = null;
      ownerDocument.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
    });
  };
  const mode = (id: string): PanelMode => !panelIsClosed(layout, id) ? "open" : layout.peek === id ? "peek" : "closed";
  const dismiss = () => {
    const { layout: latest, onChange: update } = current.current;
    const id = latest.peek;
    update({ ...latest, peek: undefined });
    if (id) focus(`[data-panel-rail-icon="${id}"]`);
  };
  useEffect(() => {
    const resize = () => setEnabled(window.innerWidth >= 1024);
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    };
  }, []);
  useEffect(() => {
    if (!enabled || !layout.peek || mode(layout.peek) !== "peek") return;
    const ownerDocument = document;
    focus(`[data-layout-panel="${layout.peek}"]`);
    const keydown = (event: KeyboardEvent) => {
      // Existing command-palette, chart-fullscreen and reviewed-order dialogs
      // own their keys while on top; never close two layers with one Escape.
      const panel = ownerDocument.querySelector<HTMLElement>(`[data-layout-panel="${layout.peek}"]`);
      const otherModal = [...ownerDocument.querySelectorAll<HTMLElement>('[aria-modal="true"]:is([role="dialog"],[role="alertdialog"])')]
        .some(element => element !== panel && element.getClientRects().length > 0);
      if (otherModal) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation(); dismiss();
      } else if (event.key === "Tab") {
        const items = [...(panel?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]') ?? [])]
          .filter(element => element.getClientRects().length > 0);
        const first = items[0], last = items.at(-1);
        if (first && last && (!panel?.contains(ownerDocument.activeElement) || ownerDocument.activeElement === panel
          || (!event.shiftKey && ownerDocument.activeElement === last) || (event.shiftKey && ownerDocument.activeElement === first))) {
          event.preventDefault(); (event.shiftKey ? last : first).focus();
        }
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [enabled, layout.peek]);
  return <Context.Provider value={{
    enabled, mode,
    close: id => { onChange(railPanels(layout, [id], true)); focus(`[data-panel-rail-icon="${id}"]`); },
    peek: id => { onChange(peekPanel(layout, id)); focus(`[data-layout-panel="${id}"]`); },
    dock: id => { onChange(revealPanel(layout, id)); focus(`[data-layout-panel="${id}"]`); },
    isPinned: id => layout.pinned.includes(id),
    togglePin: id => onChange(layout.pinned.includes(id)
      ? { ...layout, pinned: layout.pinned.filter(value => value !== id) }
      : { ...revealPanel(layout, id), pinned: [...layout.pinned, id] }),
  }}>
    {children}
    {enabled && layout.peek && mode(layout.peek) === "peek" && createPortal(
      <div className="arx-panel-peek-backdrop" data-testid="panel-peek-backdrop" aria-hidden="true"
        onPointerDown={event => { event.preventDefault(); event.stopPropagation(); dismiss(); }}/>, document.body)}
  </Context.Provider>;
}
