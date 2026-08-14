import { type ReconnectState, type ServiceId } from "./resilience.types";

// ═══════════════════════════════════════════════════════════════════════════
// Reconnect Manager — exponential backoff with jitter, capped delay, hard
// give-up after maxAttempts. Pure. Caller supplies a deterministic jitter
// function (or default uses a fixed multiplier of 1.0 for determinism).
// ═══════════════════════════════════════════════════════════════════════════

export interface ReconnectInput {
  serviceId: ServiceId;
  attempts: number;
  baseDelayMs?: number;       // default 500
  maxDelayMs?: number;        // default 30_000
  maxAttempts?: number;       // default 10
  jitter01?: number;          // default 0 (deterministic)
}

export function nextReconnect(input: ReconnectInput): ReconnectState {
  const reasons: string[] = [];
  const base = input.baseDelayMs ?? 500;
  const cap  = input.maxDelayMs ?? 30_000;
  const max  = input.maxAttempts ?? 10;
  const jitter = Math.max(0, Math.min(1, input.jitter01 ?? 0));
  const attempts = Math.max(0, Math.floor(input.attempts));
  if (attempts >= max) {
    reasons.push(`give up: attempts ${attempts} ≥ max ${max}`);
    return { serviceId: input.serviceId, attempts, nextDelayMs: cap, shouldGiveUp: true, reasons };
  }
  const exp = Math.min(cap, base * 2 ** attempts);
  const nextDelayMs = Math.min(cap, exp * (1 + jitter));
  reasons.push(`attempt ${attempts + 1}/${max} · delay ${nextDelayMs.toFixed(0)}ms (base ${base}, cap ${cap}, jitter ${jitter})`);
  return { serviceId: input.serviceId, attempts, nextDelayMs, shouldGiveUp: false, reasons };
}
