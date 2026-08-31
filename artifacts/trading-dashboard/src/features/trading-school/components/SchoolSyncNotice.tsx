/**
 * Trading School — failed-sync notice.
 *
 * CONFIDENT_ABSENT fixed: when the per-user progress read fails (new device,
 * 401, offline), the school pages used to render the local cache as bare fact
 * — "0% of 10 steps", "Not attempted", re-locked steps the user already
 * passed elsewhere. This banner is the distinct error state: it renders ONLY
 * while no server sync has succeeded this session AND the last attempt
 * failed, and says the on-screen numbers are the local cache. It renders
 * nothing while the first sync is still pending (that is not an error) and
 * nothing once a sync has succeeded.
 */
import { CloudOff } from "lucide-react";
import { useSchoolSyncStatus } from "../lib/progress";

export function SchoolSyncNotice() {
  const status = useSchoolSyncStatus();
  if (status !== "failed") return null;
  return (
    <div
      className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs text-warning"
      data-testid="school-sync-notice"
      role="status"
    >
      <CloudOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>
        Progress may be out of date — couldn't reach the server, so this shows
        only what's saved on this device. Steps passed elsewhere aren't counted
        (or locked) until the connection is back.
      </span>
    </div>
  );
}
