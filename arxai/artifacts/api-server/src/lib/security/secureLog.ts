// AACI Security Foundation — secret-safe logging wrapper.
//
// Redacts secrets from a message + metadata BEFORE they reach any log sink,
// using the pure domain redactor (which builds on the shared sensitive-data
// filter). Never use console.log — this funnels through the app `logger`. Route
// handlers should prefer their request logger via `secureReqLog(req.log, ...)`.

import { security } from "@workspace/domain";
import { logger } from "../logger.js";

type Level = "info" | "warn" | "error" | "debug";

interface MinimalLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
}

function emit(
  log: MinimalLogger,
  level: Level,
  message: unknown,
  meta?: Record<string, unknown>,
): void {
  const safe = security.redactForLog(message, meta);
  log[level]({ ...safe.meta, redactedKeys: safe.redactedKeys }, safe.message);
}

/** Secret-safe log via the singleton app logger (non-request code). */
export function secureLog(
  level: Level,
  message: unknown,
  meta?: Record<string, unknown>,
): void {
  emit(logger as unknown as MinimalLogger, level, message, meta);
}

/** Secret-safe log via a request-scoped logger (`req.log`). */
export function secureReqLog(
  reqLog: MinimalLogger,
  level: Level,
  message: unknown,
  meta?: Record<string, unknown>,
): void {
  emit(reqLog, level, message, meta);
}

/** Redact an arbitrary value for safe inclusion in an existing log call. */
export function redactForLog<T>(value: T): T {
  return security.redactSecrets(value).value;
}
