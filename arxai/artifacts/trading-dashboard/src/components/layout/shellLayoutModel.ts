export type DockMode = "expanded" | "compact";
export type ContentWidth = "fit" | "wide";
export type LayoutDensity = "comfortable" | "compact";

export type ShellPreferences = {
  dockMode: DockMode;
  contentWidth: ContentWidth;
  density: LayoutDensity;
};

export type RoutePanelLayout = {
  collapsed: string[];
  pinned: string[];
  railed?: string[];
  preset?: "Analyze" | "Trade" | "Review";
};

export type StorageLike = Pick<Storage, "getItem" | "setItem">;

const DEFAULT_SHELL_PREFERENCES: ShellPreferences = {
  dockMode: "expanded",
  contentWidth: "fit",
  density: "comfortable",
};

const SHELL_PREFERENCES_PREFIX = "arx.shell.preferences.v1";
const SIDEBAR_COLLAPSE_KEY = "highroll.sidebarCollapsed";
const SIDEBAR_MIGRATION_KEY = "arx.shell.sidebar-migrated.v1";
const ROUTE_LAYOUT_PREFIX = "arx.shell.panel-layout.v1";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function userKey(userId: number | string | null | undefined): string {
  return userId == null ? "anonymous" : String(userId);
}

function shellPreferencesKey(userId: number | string | null | undefined): string {
  return `${SHELL_PREFERENCES_PREFIX}:${userKey(userId)}`;
}

export function readShellPreferences(
  storage: StorageLike,
  userId: number | string | null | undefined,
): ShellPreferences {
  try {
    const raw = storage.getItem(shellPreferencesKey(userId));
    if (raw) {
      const value: unknown = JSON.parse(raw);
      if (!isRecord(value)) return DEFAULT_SHELL_PREFERENCES;
      return {
        dockMode: value.dockMode === "compact" ? "compact" : "expanded",
        contentWidth: value.contentWidth === "wide" ? "wide" : "fit",
        density: value.density === "compact" ? "compact" : "comfortable",
      };
    }

    // The old sidebar preference was browser-wide. Migrate it only once, for
    // the first signed-in user, so one account's setting is not copied to every
    // other account using the same browser.
    if (userId == null || storage.getItem(SIDEBAR_MIGRATION_KEY) === "1") {
      return DEFAULT_SHELL_PREFERENCES;
    }
    const oldValue = storage.getItem(SIDEBAR_COLLAPSE_KEY);
    if (oldValue == null) return DEFAULT_SHELL_PREFERENCES;
    const migrated: ShellPreferences = {
      ...DEFAULT_SHELL_PREFERENCES,
      dockMode: oldValue === "1" ? "compact" : "expanded",
    };
    storage.setItem(shellPreferencesKey(userId), JSON.stringify(migrated));
    storage.setItem(SIDEBAR_MIGRATION_KEY, "1");
    return migrated;
  } catch {
    return DEFAULT_SHELL_PREFERENCES;
  }
}

export function persistShellPreferences(
  storage: StorageLike,
  userId: number | string | null | undefined,
  preferences: ShellPreferences,
): void {
  try {
    storage.setItem(shellPreferencesKey(userId), JSON.stringify(preferences));
  } catch {
    // Private browsing and browser storage policies can reject writes.
  }
}

export function routePanelLayoutKey(
  userId: number | string | null | undefined,
  routeKey: string,
): string {
  return `${ROUTE_LAYOUT_PREFIX}:${userKey(userId)}:${routeKey}`;
}

const defaultRoutePanelLayout = (preset?: RoutePanelLayout["preset"]): RoutePanelLayout => ({
  collapsed: [],
  pinned: [],
  ...(preset ? { preset } : {}),
});

function sanitizePanelLayout(
  value: unknown,
  validIds: readonly string[],
  defaultPreset?: RoutePanelLayout["preset"],
): RoutePanelLayout {
  if (!isRecord(value)) return defaultRoutePanelLayout(defaultPreset);
  const valid = (list: unknown) =>
    Array.isArray(list)
      ? [...new Set(list.filter((id): id is string => typeof id === "string" && validIds.includes(id)))]
      : [];
  const pinned = valid(value.pinned);
  const preset = value.preset === "Analyze" || value.preset === "Trade" || value.preset === "Review"
    ? value.preset
    : defaultPreset;
  return {
    collapsed: valid(value.collapsed).filter((id) => !pinned.includes(id)),
    pinned,
    ...(Array.isArray(value.railed) ? { railed: valid(value.railed).filter(id => !pinned.includes(id)) } : {}),
    ...(preset ? { preset } : {}),
  };
}

export function readRoutePanelLayout(
  storage: StorageLike,
  userId: number | string | null | undefined,
  routeKey: string,
  validIds: readonly string[],
  options: {
    legacyKey?: string;
    defaultPreset?: RoutePanelLayout["preset"];
  } = {},
): RoutePanelLayout {
  const fallback = defaultRoutePanelLayout(options.defaultPreset);
  try {
    const key = routePanelLayoutKey(userId, routeKey);
    const current = storage.getItem(key);
    if (current) return sanitizePanelLayout(JSON.parse(current), validIds, options.defaultPreset);

    if (!options.legacyKey) return fallback;
    const legacy = storage.getItem(options.legacyKey);
    if (!legacy) return fallback;
    const migrated = sanitizePanelLayout(JSON.parse(legacy), validIds, options.defaultPreset);
    storage.setItem(key, JSON.stringify(migrated));
    return migrated;
  } catch {
    return fallback;
  }
}

export function persistRoutePanelLayout(
  storage: StorageLike,
  userId: number | string | null | undefined,
  routeKey: string,
  layout: RoutePanelLayout,
): void {
  try {
    storage.setItem(routePanelLayoutKey(userId, routeKey), JSON.stringify(layout));
  } catch {
    // Layout remains usable in memory if browser storage is unavailable.
  }
}

