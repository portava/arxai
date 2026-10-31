import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";

type DockKind = "assistant" | "quickActions" | "search";
type DockTargets = Record<DockKind, HTMLElement>;
type RegisterDock = (elements: DockTargets) => () => void;
const RegisterContext = createContext<RegisterDock | null>(null);
const TargetContext = createContext<DockTargets | null>(null);

/** Move the three launch buttons, not their panels. The assistant conversation
 * remains mounted once; chart navigation never opens chat or starts voice. */
export function AssistantDockProvider({ children }: { children: ReactNode }) {
  const [targets, setTargets] = useState<DockTargets[]>([]);
  const register = useCallback<RegisterDock>(element => {
    setTargets(previous => previous.includes(element) ? previous : [...previous, element]);
    return () => setTargets(previous => previous.filter(target => target !== element));
  }, []);
  return <RegisterContext.Provider value={register}>
    <TargetContext.Provider value={targets.at(-1) ?? null}>{children}</TargetContext.Provider>
  </RegisterContext.Provider>;
}

export function useAssistantDockTarget(): HTMLElement | null {
  return useChartActionDockTarget("assistant");
}

export function useChartActionDockTarget(kind: DockKind): HTMLElement | null {
  return useContext(TargetContext)?.[kind] ?? null;
}

/** A primary or fullscreen chart reserves a touch-sized place in its header.
 * Ordinary comparison panes do not compete for it. Outside the app provider, no empty
 * placeholder is rendered (standalone chart previews retain their layout). */
export function AssistantDockSlot() {
  const register = useContext(RegisterContext);
  const assistant = useRef<HTMLDivElement>(null);
  const quickActions = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (register && assistant.current && quickActions.current && search.current)
      return register({assistant:assistant.current,quickActions:quickActions.current,search:search.current});
    return undefined;
  }, [register]);
  return register ? <div className="flex h-11 shrink-0 gap-1" role="group" aria-label="Chart help and navigation" data-testid="chart-assistant-dock">
    <div ref={quickActions} className="h-11 w-11" />
    <div ref={search} className="h-11 w-11" />
    <div ref={assistant} className="h-11 w-11" />
  </div> : null;
}
