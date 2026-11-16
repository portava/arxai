// Pure: no I/O. Shared by the command route (arm time) and the watch
// evaluator (fire time).

// Whether a watch kind may arm / fire under the CURRENT settings (sweep
// 2026-11-04). The watch-level permission alone was not enough: the instant
// trade pipeline (eleanorAuthCheck) also needs allowEleanorOpenCommands for the
// entry and allowEleanorCloseCommands for a close, so a watch armed without them
// fired and was refused every time. Same rule at arm time and at fire time.
// Returns null when allowed, else the block reason.
export type EleanorWatchPermissionBlock =
  | "ELEANOR_EXECUTION_NOT_AUTHORIZED"
  | "ELEANOR_WATCH_ENTER_NOT_ENABLED"
  | "ELEANOR_WATCH_CLOSE_NOT_ENABLED"
  | "ELEANOR_MONITOR_NOT_ENABLED"
  | "ELEANOR_OPEN_COMMANDS_NOT_ENABLED"
  | "ELEANOR_CLOSE_COMMANDS_NOT_ENABLED";

export function eleanorWatchPermissionBlock(
  kind: string,
  settings: {
    eleanorExecutionAuthority?: string | null;
    allowEleanorWatchEnter?: boolean | null; allowEleanorWatchClose?: boolean | null; allowEleanorMonitor?: boolean | null;
    allowEleanorOpenCommands?: boolean | null; allowEleanorCloseCommands?: boolean | null;
  } | null | undefined,
): EleanorWatchPermissionBlock | null {
  const s = settings ?? {};
  if (kind === "WATCH_AND_ENTER" && s.allowEleanorWatchEnter !== true) return "ELEANOR_WATCH_ENTER_NOT_ENABLED";
  if (kind === "WATCH_AND_CLOSE" && s.allowEleanorWatchClose !== true) return "ELEANOR_WATCH_CLOSE_NOT_ENABLED";
  if (kind === "MONITOR_TRADE" && s.allowEleanorMonitor !== true) return "ELEANOR_MONITOR_NOT_ENABLED";
  if ((s.eleanorExecutionAuthority ?? "OFF").trim().toUpperCase() !== "AI_ASSISTED") return "ELEANOR_EXECUTION_NOT_AUTHORIZED";
  if (kind === "WATCH_AND_ENTER" && s.allowEleanorOpenCommands !== true) return "ELEANOR_OPEN_COMMANDS_NOT_ENABLED";
  if ((kind === "WATCH_AND_CLOSE" || kind === "MONITOR_TRADE") && s.allowEleanorCloseCommands !== true) return "ELEANOR_CLOSE_COMMANDS_NOT_ENABLED";
  return null;
}
