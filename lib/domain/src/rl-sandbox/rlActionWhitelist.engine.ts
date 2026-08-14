import {
  type RlActionRequest, type RlAdmissionDecision, RL_ALLOWED_KINDS,
} from "./rlSandbox.types";
import { guardEnvironment } from "./rlEnvironmentGuard.engine";

// admitRlAction — the master admission engine. Composes:
//   1. environment guard (must be SIMULATOR)
//   2. action-kind whitelist (must be SIZING/EXIT/RISK_ALLOCATION/PAUSE)
//
// Enforces independently of any caller-provided check (defense in depth):
// even if upstream code believes the request is fine, this engine still
// re-validates both rules.
export function admitRlAction(req: RlActionRequest): RlAdmissionDecision {
  const reasons: string[] = [];

  // Gate 1: environment
  const envBlock = guardEnvironment(req);
  if (envBlock !== null) return envBlock;
  reasons.push(`environment=SIMULATOR — passed env guard`);

  // Gate 2: action kind whitelist
  if (!RL_ALLOWED_KINDS.includes(req.kind)) {
    return {
      verdict: "REJECTED_FORBIDDEN_KIND",
      requestId: req.requestId,
      reasons: [...reasons, `kind=${req.kind} not in whitelist [${RL_ALLOWED_KINDS.join(", ")}] — RL must not decide entries/signals/strategy selection`],
    };
  }

  reasons.push(`kind=${req.kind} in whitelist — admitted`);
  return { verdict: "ADMITTED", requestId: req.requestId, reasons };
}
