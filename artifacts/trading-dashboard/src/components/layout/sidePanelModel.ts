import type { RoutePanelLayout } from "./shellLayoutModel";

/** Migrate old folds without opening a newly introduced chart-details pane. */
export function withSlidingPanels<T extends RoutePanelLayout>(saved: T): T {
  return saved.slidingVersion === 1 ? saved : {
    ...saved, slidingVersion: 1,
    railed: [...new Set([...(saved.railed ?? []), ...(!saved.pinned.includes("chart-details") ? ["chart-details"] : [])])],
  };
}

export function railPanels<T extends RoutePanelLayout>(layout: T, ids: readonly string[], rail: boolean): T {
  const railed = new Set(layout.railed ?? []);
  for (const id of ids) {
    if (rail && !layout.pinned.includes(id)) railed.add(id);
    else railed.delete(id);
  }
  return { ...layout, railed: [...railed].filter(id => !layout.pinned.includes(id)),
    collapsed: rail ? layout.collapsed : layout.collapsed.filter(id => !ids.includes(id)),
    ...(layout.peek && ids.includes(layout.peek) ? { peek: undefined } : {}),
  };
}

export function revealPanel<T extends RoutePanelLayout>(layout: T, id: string): T {
  return { ...railPanels(layout, [id], false), collapsed: layout.collapsed.filter(value => value !== id), peek: undefined };
}

export function sideIsRailed(layout: RoutePanelLayout, ids: readonly string[]): boolean {
  return ids.length > 0 && ids.every(id => panelIsClosed(layout, id));
}

export function panelIsClosed(layout: RoutePanelLayout, id: string): boolean {
  return !layout.pinned.includes(id) && !!(layout.railed?.includes(id) || layout.collapsed.includes(id));
}

export function peekPanel<T extends RoutePanelLayout>(layout: T, id: string): T {
  return layout.pinned.includes(id) ? layout : { ...railPanels(layout, [id], true), peek: id };
}
