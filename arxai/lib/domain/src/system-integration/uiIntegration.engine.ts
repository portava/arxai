import { z } from "zod/v4";
import {
  SymbolIdSchema, Score01Schema, SystemModeSchema,
  type SystemMode, type SymbolId,
} from "./systemIntegration.types";

// ═══════════════════════════════════════════════════════════════════════════
// UI Integration
// Decides what appears most prominently on the dashboard based on the
// Attention Engine. Danger alerts override normal cards. Recovery /
// lockdown / safe-shutdown produce a visually obvious global banner.
// Explanations are passed through verbatim — already plain English.
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const AttentionInputSchema = z.object({
  symbol: SymbolIdSchema,
  priority01: Score01Schema,
  isDanger: z.boolean(),
  label: z.string(),
});
export type AttentionInput = z.infer<typeof AttentionInputSchema>;

export const UIIntegrationInputSchema = z.object({
  attention: z.array(AttentionInputSchema),
  systemMode: SystemModeSchema,
  explanationPlainEnglish: z.string(),
  generatedAtIso: z.string(),
});
export type UIIntegrationInput = z.infer<typeof UIIntegrationInputSchema>;

export const UICardSchema = z.object({
  symbol: SymbolIdSchema,
  label: z.string(),
  prominence: z.enum(["HERO", "PRIMARY", "SECONDARY", "COLLAPSED"]),
  variant: z.enum(["NORMAL", "WARNING", "DANGER"]),
  priority01: Score01Schema,
});
export type UICard = z.infer<typeof UICardSchema>;

export const UIBannerSchema = z.object({
  visible: z.boolean(),
  tone: z.enum(["NEUTRAL", "INFO", "WARNING", "DANGER", "CRITICAL"]),
  title: z.string(),
  message: z.string(),
});
export type UIBanner = z.infer<typeof UIBannerSchema>;

export const UIIntegrationOutputSchema = z.object({
  generatedAtIso: z.string(),
  cards: z.array(UICardSchema),
  banner: UIBannerSchema,
  overrideNormalLayout: z.boolean(),
  explanationPlainEnglish: z.string(),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type UIIntegrationOutput = z.infer<typeof UIIntegrationOutputSchema>;

function bannerFor(mode: SystemMode): UIBanner {
  switch (mode) {
    case "SAFE_SHUTDOWN":
      return { visible: true, tone: "CRITICAL", title: "SAFE SHUTDOWN",
        message: "All trading is halted. The system is shutting down safely." };
    case "LOCKDOWN":
      return { visible: true, tone: "CRITICAL", title: "LOCKDOWN",
        message: "Trading is locked. No new orders will be sent until the lockdown clears." };
    case "RECOVERY_MODE":
      return { visible: true, tone: "DANGER", title: "RECOVERY MODE",
        message: "The trader is recovering. Sizing and frequency are limited." };
    case "DEGRADED_MODE":
      return { visible: true, tone: "DANGER", title: "DEGRADED MODE",
        message: "System is operating with reduced capability. Some features are paused." };
    case "COOLDOWN":
      return { visible: true, tone: "WARNING", title: "COOLDOWN",
        message: "Cooling down after recent activity. Reduced sizing applies." };
    case "REDUCED":
      return { visible: true, tone: "WARNING", title: "REDUCED",
        message: "Operating at reduced capacity." };
    case "NORMAL":
      return { visible: false, tone: "NEUTRAL", title: "", message: "" };
  }
}

const OVERRIDE_MODES = new Set<SystemMode>([
  "DEGRADED_MODE", "RECOVERY_MODE", "LOCKDOWN", "SAFE_SHUTDOWN",
]);

export function runUIIntegration(input: UIIntegrationInput): UIIntegrationOutput {
  const reasons: string[] = [];
  const blockers: string[] = [];

  // Sort attention by priority desc, then danger first within ties.
  const sorted = [...input.attention].sort((a, b) => {
    const dp = (b.priority01 as unknown as number) - (a.priority01 as unknown as number);
    if (dp !== 0) return dp;
    return (b.isDanger ? 1 : 0) - (a.isDanger ? 1 : 0);
  });

  const cards: UICard[] = sorted.map((a, idx) => {
    const variant: UICard["variant"] = a.isDanger
      ? "DANGER"
      : (a.priority01 as unknown as number) >= 0.7 ? "WARNING" : "NORMAL";
    let prominence: UICard["prominence"] = "COLLAPSED";
    if (a.isDanger) prominence = "HERO";
    else if (idx === 0) prominence = "HERO";
    else if (idx <= 2) prominence = "PRIMARY";
    else if (idx <= 5) prominence = "SECONDARY";
    return {
      symbol: a.symbol, label: a.label,
      prominence, variant, priority01: a.priority01,
    };
  });

  const banner = bannerFor(input.systemMode);
  const overrideNormalLayout = OVERRIDE_MODES.has(input.systemMode) || cards.some((c) => c.variant === "DANGER");

  if (overrideNormalLayout) reasons.push("normal layout overridden by danger / restrictive mode");
  if (banner.visible)       reasons.push(`global banner shown: ${banner.title}`);
  if (input.systemMode === "LOCKDOWN" || input.systemMode === "SAFE_SHUTDOWN") {
    blockers.push(`UI must disable all trade-entry controls in mode ${input.systemMode}`);
  }

  return {
    generatedAtIso: input.generatedAtIso,
    cards, banner, overrideNormalLayout,
    explanationPlainEnglish: input.explanationPlainEnglish,
    reasons, blockers,
  };
}
