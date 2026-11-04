import type { RoutePanelLayout } from "./shellLayoutModel";

export function railPanels<T extends RoutePanelLayout>(layout: T, ids: readonly string[], rail: boolean): T {
  const railed = new Set(layout.railed ?? []);
  for (const id of ids) {
    if (rail && !layout.pinned.includes(id)) railed.add(id);
    else railed.delete(id);
  }
  return { ...layout, railed: [...railed].filter(id => !layout.pinned.includes(id)) };
}

export function revealPanel<T extends RoutePanelLayout>(layout: T, id: string): T {
  return { ...railPanels(layout, [id], false), collapsed: layout.collapsed.filter(value => value !== id) };
}

export function sideIsRailed(layout: RoutePanelLayout, ids: readonly string[]): boolean {
  return ids.length > 0 && ids.every(id => !layout.pinned.includes(id) && layout.railed?.includes(id));
}
