// Pure: no I/O. Shared by the command route (arm time) and the watch
// evaluator (fire time).

// Whether a watch kind may arm / fire under the CURRENT settings (sweep
// 2026-11-04). The watch-level permission alone was not enough: the instant
// trade pipeline (rubyAuthCheck) also needs allowRubyOpenCommands for the
// entry and allowRubyCloseCommands for a close, so a watch armed without them
// fired and was refused every time. Same rule at arm time and at fire time.
// Returns null when allowed, else the block reason.
export type RubyWatchPermissionBlock =
  | "RUBY_EXECUTION_NOT_AUTHORIZED"
  | "RUBY_WATCH_ENTER_NOT_ENABLED"
  | "RUBY_WATCH_CLOSE_NOT_ENABLED"
  | "RUBY_MONITOR_NOT_ENABLED"
  | "RUBY_OPEN_COMMANDS_NOT_ENABLED"
  | "RUBY_CLOSE_COMMANDS_NOT_ENABLED";

export function rubyWatchPermissionBlock(
  kind: string,
  settings: {
    rubyExecutionAuthority?: string | null;
    allowRubyWatchEnter?: boolean | null; allowRubyWatchClose?: boolean | null; allowRubyMonitor?: boolean | null;
    allowRubyOpenCommands?: boolean | null; allowRubyCloseCommands?: boolean | null;
  } | null | undefined,
): RubyWatchPermissionBlock | null {
  const s = settings ?? {};
  if (kind === "WATCH_AND_ENTER" && s.allowRubyWatchEnter !== true) return "RUBY_WATCH_ENTER_NOT_ENABLED";
  if (kind === "WATCH_AND_CLOSE" && s.allowRubyWatchClose !== true) return "RUBY_WATCH_CLOSE_NOT_ENABLED";
  if (kind === "MONITOR_TRADE" && s.allowRubyMonitor !== true) return "RUBY_MONITOR_NOT_ENABLED";
  if ((s.rubyExecutionAuthority ?? "OFF").trim().toUpperCase() !== "AI_ASSISTED") return "RUBY_EXECUTION_NOT_AUTHORIZED";
  if (kind === "WATCH_AND_ENTER" && s.allowRubyOpenCommands !== true) return "RUBY_OPEN_COMMANDS_NOT_ENABLED";
  if ((kind === "WATCH_AND_CLOSE" || kind === "MONITOR_TRADE") && s.allowRubyCloseCommands !== true) return "RUBY_CLOSE_COMMANDS_NOT_ENABLED";
  return null;
}
