// Lifecycle engine — classifies where a setup is in its life across 8 strictly
// ordered stages. Pure & deterministic, with terse factual reasons.
//
//   WATCHING → TREND_FORMING → SETUP_FORMING → ENTRY_APPROACHING →
//   ENTRY_WINDOW_OPEN → LATE → INVALID → EXPIRED
//
// HONEST: a blind read (insufficient candles) is always WATCHING — never a
// fabricated "entry window". Direction never forces a stage; a strong bias with
// no clean entry stays in TREND_FORMING/SETUP_FORMING, not ENTRY_WINDOW_OPEN.

import type {
  EarlyTrendReading,
  FakeoutReading,
  LateDetection,
  SignalLifecycleStage,
  SignalScannerInput,
} from "./signalIntelligence.types.js";

export interface LifecycleInput {
  early: EarlyTrendReading;
  fakeout: FakeoutReading;
  scanner: SignalScannerInput | null;
  late: LateDetection;
  hasSufficientData: boolean;
  /** True when price/structure has broken the invalidation level. */
  invalidated: boolean;
  /** True when the read has aged past its validity window. */
  expired: boolean;
}

export interface LifecycleVerdict {
  stage: SignalLifecycleStage;
  reasons: string[];
}

function inEntryZone(scanner: SignalScannerInput | null): boolean {
  if (!scanner || !scanner.entryZone) return false;
  return true;
}

export function classifyLifecycle(input: LifecycleInput): LifecycleVerdict {
  const { early, fakeout, scanner, late, hasSufficientData, invalidated, expired } = input;
  const reasons: string[] = [];

  // Terminal stages first (ordered: EXPIRED then INVALID).
  if (expired) {
    return { stage: "EXPIRED", reasons: ["Setup aged past its validity window."] };
  }
  if (invalidated) {
    return { stage: "INVALID", reasons: ["Price broke the invalidation level."] };
  }

  // Honest default — nothing readable yet.
  if (!hasSufficientData || early.blind) {
    return { stage: "WATCHING", reasons: ["Waiting for enough data to read structure."] };
  }

  // A confirmed trap/failed-breakout against the lean keeps us out of an entry.
  const trap = fakeout.detected && fakeout.confidence >= 60;
  if (trap) reasons.push(`Fakeout risk: ${fakeout.kind.toLowerCase().replace(/_/g, " ")}.`);

  // LATE: clean entry has passed (do-not-chase).
  if (late.isLate) {
    reasons.push(late.reason ?? "Clean entry already passed.");
    return { stage: "LATE", reasons };
  }

  const action = scanner?.recommendedAction ?? "WAIT";
  const actionable = action === "BUY" || action === "SELL";
  const directionalPressure =
    early.pressure === "BUILDING_BULLISH" || early.pressure === "BUILDING_BEARISH";
  const hasEntryZone = inEntryZone(scanner);

  // ENTRY_WINDOW_OPEN: scanner says act AND we have a concrete entry zone AND no
  // disqualifying trap. This is the ONLY "act now" stage.
  if (actionable && hasEntryZone && !trap) {
    reasons.push(`Scanner action ${action} with a defined entry zone.`);
    if (early.bosChoch !== "NONE") reasons.push(`Structure event: ${early.bosChoch.toLowerCase().replace(/_/g, " ")}.`);
    return { stage: "ENTRY_WINDOW_OPEN", reasons };
  }

  // ENTRY_APPROACHING: actionable lean forming but entry not yet defined/clean,
  // or a trap is keeping us patient.
  if ((actionable || directionalPressure) && (hasEntryZone || early.bosChoch !== "NONE")) {
    reasons.push("Setup is maturing toward an entry.");
    if (trap) reasons.push("Holding back until the trap risk clears.");
    return { stage: "ENTRY_APPROACHING", reasons };
  }

  // SETUP_FORMING: a structure event or directional pressure is present.
  if (early.bosChoch !== "NONE" || directionalPressure || early.compression) {
    reasons.push("A setup is forming but is not entry-ready.");
    return { stage: "SETUP_FORMING", reasons };
  }

  // TREND_FORMING: clean swing structure but nothing actionable yet.
  if (early.structure === "HH_HL" || early.structure === "LH_LL") {
    reasons.push("Directional structure is forming.");
    return { stage: "TREND_FORMING", reasons };
  }

  // Default — watching.
  reasons.push("No clean structure or setup yet.");
  return { stage: "WATCHING", reasons };
}
