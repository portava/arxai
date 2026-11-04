import { useCallback, useEffect, useMemo, useState } from "react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  persistRoutePanelLayout,
  readRoutePanelLayout,
  type RoutePanelLayout,
} from "./shellLayoutModel";

export function useRoutePanelLayout(
  routeKey: string,
  panelIds: readonly string[],
  options: {
    legacyKey?: string;
    defaultPreset?: RoutePanelLayout["preset"];
  } = {},
) {
  const { user } = useCurrentUser();
  const userId = user?.id ?? null;
  const panelIdKey = panelIds.join("|");
  const stablePanelIds = useMemo(() => panelIdKey ? panelIdKey.split("|") : [], [panelIdKey]);
  const [layout, setLayoutState] = useState<RoutePanelLayout>(() => ({
    collapsed: [],
    pinned: [],
    ...(options.defaultPreset ? { preset: options.defaultPreset } : {}),
  }));

  useEffect(() => {
    if (userId == null) return;
    setLayoutState(readRoutePanelLayout(
      window.localStorage,
      userId,
      routeKey,
      stablePanelIds,
      options,
    ));
  }, [routeKey, userId, panelIdKey, options.legacyKey, options.defaultPreset, stablePanelIds]);

  const setLayout = useCallback((next: RoutePanelLayout) => {
    setLayoutState(next);
    persistRoutePanelLayout(window.localStorage, userId, routeKey, next);
  }, [routeKey, userId]);

  return { layout, setLayout, userId };
}
