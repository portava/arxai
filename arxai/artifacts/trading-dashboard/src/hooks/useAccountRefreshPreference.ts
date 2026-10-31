import { useCallback, useEffect, useState } from "react";

const KEY = "arx_autoRefresh_enabled";
const CHANGED = "arx:account-refresh-preference";
function readPreference() {
  try { return localStorage.getItem(KEY) !== "false"; }
  catch { return true; }
}

/** Shared preference for mounted account readers, including storage-denied tabs.
 * It controls read-only transport only, never the broker or trading settings. */
export function useAccountRefreshPreference() {
  const [enabled, setEnabled] = useState(readPreference);
  useEffect(() => {
    const local = (event: Event) => {
      const value = (event as CustomEvent<unknown>).detail;
      if (typeof value === "boolean") setEnabled(value);
    };
    const external = (event: StorageEvent) => {
      if (event.key === KEY || event.key === null) setEnabled(readPreference());
    };
    window.addEventListener(CHANGED, local);
    window.addEventListener("storage", external);
    return () => {
      window.removeEventListener(CHANGED, local);
      window.removeEventListener("storage", external);
    };
  }, []);
  const update = useCallback((value: boolean) => {
    setEnabled(value);
    try { localStorage.setItem(KEY, String(value)); } catch { /* Current-session setting still applies. */ }
    window.dispatchEvent(new CustomEvent(CHANGED, { detail: value }));
  }, []);
  return [enabled, update] as const;
}
