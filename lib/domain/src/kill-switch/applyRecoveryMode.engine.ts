import {
  type ActionUnderRecovery, type KillSwitchState, type ProposedAction,
  KILL_SWITCH_DEFAULTS,
} from "./killSwitch.types";

// applyRecoveryMode — given the active KillSwitchState, modify a proposed
// (action, sizeMultiplier, confidence) tuple per the recovery mode rules.
//
//   BLOCK_ALL    → REJECT, size 0
//   PAPER_ONLY   → unchanged action, paperOnly=true (caller routes to sim)
//   A_PLUS_ONLY  → REJECT unless action===APPROVE (full) AND confidence ≥ 80
//   REDUCED_SIZE → cap sizeMultiplier at 0.5
//   NORMAL       → pass-through
//
// Returns ActionUnderRecovery — caller wires its own ProposedAction
// downstream. Defensive: never UPSCALES; only ever modifies toward safer.
export function applyRecoveryMode(
  state: KillSwitchState,
  proposed: { action: ProposedAction; sizeMultiplier: number; confidence: number },
): ActionUnderRecovery {
  const T = KILL_SWITCH_DEFAULTS;
  const modified: string[] = [];

  switch (state.mode) {
    case "BLOCK_ALL":
      modified.push("BLOCK_ALL — rejected regardless of proposal");
      return { action: "REJECT", sizeMultiplier: 0, confidence: proposed.confidence, paperOnly: false, modifiedReasons: modified };

    case "PAPER_ONLY":
      modified.push("PAPER_ONLY — proposal preserved but routed to sim");
      return { ...proposed, paperOnly: true, modifiedReasons: modified };

    case "A_PLUS_ONLY": {
      const isAplus = proposed.action === "APPROVE" && proposed.confidence >= T.aPlusMinConfidence;
      if (!isAplus) {
        modified.push(`A_PLUS_ONLY — proposal not A+ (action=${proposed.action}, confidence=${proposed.confidence.toFixed(0)} < ${T.aPlusMinConfidence}) → REJECT`);
        return { action: "REJECT", sizeMultiplier: 0, confidence: proposed.confidence, paperOnly: false, modifiedReasons: modified };
      }
      modified.push(`A_PLUS_ONLY — proposal is A+ (confidence ${proposed.confidence.toFixed(0)}) → allow`);
      return { ...proposed, paperOnly: false, modifiedReasons: modified };
    }

    case "REDUCED_SIZE": {
      const cap = Math.min(proposed.sizeMultiplier, T.reducedSizeMultiplierCap);
      if (cap < proposed.sizeMultiplier) {
        modified.push(`REDUCED_SIZE — multiplier capped ${proposed.sizeMultiplier.toFixed(2)} → ${cap.toFixed(2)}`);
      }
      return {
        action: cap > 0 ? proposed.action : "REJECT",
        sizeMultiplier: cap, confidence: proposed.confidence, paperOnly: false, modifiedReasons: modified,
      };
    }

    case "NORMAL":
      modified.push("NORMAL — pass-through");
      return { ...proposed, paperOnly: false, modifiedReasons: modified };
  }
}
