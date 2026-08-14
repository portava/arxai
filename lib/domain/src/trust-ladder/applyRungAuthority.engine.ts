import {
  type ActionUnderRung, type RungProposedAction, type TrustRung, RUNG_AUTHORITY,
} from "./trustLadder.types";

// applyRungAuthority — modify a proposed action per the current rung's
// authority cap. Composes with kill-switch + governor: this layer NEVER
// enables more than the rung allows; downstream layers can still tighten.
//
// Per-rung effects:
//   OBSERVE_ONLY            → REJECT, paperOnly+suggestionOnly (logs only)
//   SUGGEST_ONLY            → REJECT, paperOnly+suggestionOnly (operator-only surfacing)
//   SHADOW_TRADE            → unchanged action, paperOnly=true (sim only)
//   MICRO_LOT_ONLY          → cap sizeMultiplier at 0.10 (real but tiny)
//   LIMITED_AUTO            → cap sizeMultiplier at 0.50 (real, partial)
//   FULL_AUTO_WITH_GOVERNOR → pass-through (governor still gates)
//
// Defensive: never UPSCALES. If proposed multiplier already smaller than
// the rung cap, keep the smaller value.
export function applyRungAuthority(
  rung: TrustRung,
  proposed: { action: RungProposedAction; sizeMultiplier: number },
): ActionUnderRung {
  const A = RUNG_AUTHORITY;
  const reasons: string[] = [];
  switch (rung) {
    case "OBSERVE_ONLY":
      reasons.push("OBSERVE_ONLY — AI logs only, no action surfaced or sent");
      return { action: "REJECT", sizeMultiplier: 0, paperOnly: true, suggestionOnly: true, modifiedReasons: reasons };

    case "SUGGEST_ONLY":
      reasons.push("SUGGEST_ONLY — surfaced to operator only, never auto-routed");
      return { action: "REJECT", sizeMultiplier: 0, paperOnly: true, suggestionOnly: true, modifiedReasons: reasons };

    case "SHADOW_TRADE":
      reasons.push("SHADOW_TRADE — proposal preserved but routed to sim only");
      return { action: proposed.action, sizeMultiplier: proposed.sizeMultiplier, paperOnly: true, suggestionOnly: false, modifiedReasons: reasons };

    case "MICRO_LOT_ONLY": {
      const cap = Math.min(proposed.sizeMultiplier, A.microLotMultiplier);
      if (cap < proposed.sizeMultiplier) reasons.push(`MICRO_LOT_ONLY — multiplier capped ${proposed.sizeMultiplier.toFixed(2)} → ${cap.toFixed(2)}`);
      else reasons.push(`MICRO_LOT_ONLY — multiplier ${cap.toFixed(2)} already within micro cap`);
      return {
        action: cap > 0 ? proposed.action : "REJECT",
        sizeMultiplier: cap, paperOnly: false, suggestionOnly: false, modifiedReasons: reasons,
      };
    }

    case "LIMITED_AUTO": {
      const cap = Math.min(proposed.sizeMultiplier, A.limitedAutoMultiplier);
      if (cap < proposed.sizeMultiplier) reasons.push(`LIMITED_AUTO — multiplier capped ${proposed.sizeMultiplier.toFixed(2)} → ${cap.toFixed(2)}`);
      else reasons.push(`LIMITED_AUTO — multiplier ${cap.toFixed(2)} already within limited cap`);
      return {
        action: cap > 0 ? proposed.action : "REJECT",
        sizeMultiplier: cap, paperOnly: false, suggestionOnly: false, modifiedReasons: reasons,
      };
    }

    case "FULL_AUTO_WITH_GOVERNOR":
      reasons.push("FULL_AUTO_WITH_GOVERNOR — pass-through (governor still gates)");
      return { action: proposed.action, sizeMultiplier: proposed.sizeMultiplier, paperOnly: false, suggestionOnly: false, modifiedReasons: reasons };
  }
}
