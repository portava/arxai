// Single open-signal for the mounted assistant (Ruby) live panel.
//
// DEAD GAUGE fixed here: every "Ask Ruby to explain" button used to write
// `sessionStorage["arx.assistant.open.v2"] = "1"` and dispatch a SYNTHETIC
// StorageEvent. Nothing ever listened: ArxAssistantLivePanel reads that key
// only inside its useState initializer, mounts once in AppLayout, and
// registers no 'storage' listener — so the click silently did nothing, and
// the panel instead popped open unexpectedly on the user's NEXT full page
// reload (when the initializer finally re-ran and saw the stale "1").
//
// The fix is an explicit in-tab event the panel actually subscribes to:
//   * openAssistantPanel() dispatches ASSISTANT_OPEN_EVENT — the live signal;
//   * the sessionStorage key is kept ONLY as reload persistence (the panel's
//     initializer still reads it), written here so both stay in step.
// (A real 'storage' event never fires in the tab that wrote the value, so the
// old StorageEvent forgery could not have worked even with a listener.)

export const ASSISTANT_OPEN_STORAGE_KEY = "arx.assistant.open.v2";
export const ASSISTANT_OPEN_EVENT = "arx:assistant:open";

/** Ask the mounted assistant live panel to open now (and stay open on reload). */
export function openAssistantPanel(): void {
  try {
    sessionStorage.setItem(ASSISTANT_OPEN_STORAGE_KEY, "1");
  } catch {
    /* storage unavailable — the live event below still opens the panel */
  }
  try {
    window.dispatchEvent(new CustomEvent(ASSISTANT_OPEN_EVENT));
  } catch {
    /* no window (SSR/test teardown) — nothing to open */
  }
}
