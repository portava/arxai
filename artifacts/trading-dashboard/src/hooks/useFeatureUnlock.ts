import { useCallback, useEffect, useState } from "react";
import { useCurrentUser } from "./useCurrentUser";

/**
 * UI-only feature unlock gate — backed by localStorage, scoped per user.
 *
 * Why this exists:
 *   The ARX backend isolation refactor is in progress (Phase 2/3 will scope
 *   every trading table by userId). Until then, this hook gives every newly
 *   signed-in user a clean first-load experience by hiding feature panels
 *   until they explicitly click "Connect" / "Start" on each one.
 *
 *   Storage key is `arx_feature_unlocks_v1:<userId>`, so user A's unlocks
 *   on a shared browser do NOT leak to user B after a re-login.
 *
 *   ⚠️ This is a UI gate, NOT a security boundary. A user with devtools
 *   could flip the flag and see whatever data the (still global) backend
 *   returns. The real fix is per-user data scoping at the route layer
 *   (Phase 3 — see .local/session_plan.md).
 */

export type FeatureKey = "mt5" | "paper" | "analysis" | "simulator";

const STORAGE_PREFIX = "arx_feature_unlocks_v1";

type UnlockMap = Partial<Record<FeatureKey, true>>;

function keyFor(userId: number | null): string {
  return `${STORAGE_PREFIX}:${userId ?? "anon"}`;
}

function readAll(userId: number | null): UnlockMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(keyFor(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as UnlockMap;
    return {};
  } catch {
    return {};
  }
}

function writeAll(userId: number | null, map: UnlockMap): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(keyFor(userId), JSON.stringify(map));
    window.dispatchEvent(new CustomEvent("arx-unlock-change"));
  } catch {
    /* ignore quota / private mode errors */
  }
}

export function useFeatureUnlock(feature: FeatureKey) {
  const { user } = useCurrentUser();
  const userId = user?.id ?? null;
  const [unlocked, setUnlocked] = useState<boolean>(() => Boolean(readAll(userId)[feature]));

  useEffect(() => {
    const sync = () => setUnlocked(Boolean(readAll(userId)[feature]));
    sync();
    window.addEventListener("storage", sync);
    window.addEventListener("arx-unlock-change", sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("arx-unlock-change", sync);
    };
  }, [feature, userId]);

  const unlock = useCallback(() => {
    const map = readAll(userId);
    map[feature] = true;
    writeAll(userId, map);
  }, [feature, userId]);

  const lock = useCallback(() => {
    const map = readAll(userId);
    delete map[feature];
    writeAll(userId, map);
  }, [feature, userId]);

  return { unlocked, unlock, lock };
}

export function useAllUnlocks(): Record<FeatureKey, boolean> {
  const mt5 = useFeatureUnlock("mt5");
  const paper = useFeatureUnlock("paper");
  const analysis = useFeatureUnlock("analysis");
  const simulator = useFeatureUnlock("simulator");
  return {
    mt5: mt5.unlocked,
    paper: paper.unlocked,
    analysis: analysis.unlocked,
    simulator: simulator.unlocked,
  };
}

/**
 * Clears unlocks for the currently-signed-in user. Hook variant — needs to
 * read the current user from React Query, so it must run inside a component.
 */
export function useResetAllUnlocks(): () => void {
  const { user } = useCurrentUser();
  const userId = user?.id ?? null;
  return useCallback(() => writeAll(userId, {}), [userId]);
}

/**
 * Backward-compat: pre-Phase-1 callers passed no user. Resets the legacy
 * unscoped key plus the anon key. Per-user keys are not touched.
 */
export function resetAllUnlocks(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_PREFIX); // legacy unscoped key
    window.localStorage.removeItem(keyFor(null));   // anon
    window.dispatchEvent(new CustomEvent("arx-unlock-change"));
  } catch {
    /* ignore */
  }
}
