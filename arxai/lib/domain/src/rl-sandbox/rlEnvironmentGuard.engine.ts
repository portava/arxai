import { type RlActionRequest, type RlAdmissionDecision } from "./rlSandbox.types";

// guardEnvironment — fail-closed on anything other than SIMULATOR.
// This is the FIRST gate in the RL admission chain. The system rule is
// "RL only inside simulator first" — this engine enforces it.
export function guardEnvironment(req: RlActionRequest): RlAdmissionDecision | null {
  if (req.environment !== "SIMULATOR") {
    return {
      verdict: "REJECTED_NOT_SIMULATOR",
      requestId: req.requestId,
      reasons: [`environment=${req.environment} — RL is restricted to SIMULATOR only`],
    };
  }
  return null;                            // null = continue chain
}
