// Plain-language reading of an agent's MEASURED trust (the calibration
// engine's reading of the agent's own graded record). This, not the agent
// registry's trustScore, is what drives advisory influence.
export type MeasuredTrust = {
  status: "measured" | "unmeasured"; n: number; influence: number; trustScore: number;
  basis: string; effectiveAuthorityWeight: number;
};

/** Plain-language reading of a measured-trust basis string. */
export function measuredTrustText(m: MeasuredTrust | undefined): string {
  if (!m) return "Not reported by the server.";
  const [kind, ...rest] = m.basis.split(":");
  const detail = rest.join(":");
  switch (kind) {
    case "no_replayable_record": return `No graded record: ${detail}.`;
    case "no_scored_record": return `No graded record yet (N=${m.n}).`;
    case "record_too_small_for_skill_test": return `Graded record too small to test for skill (N=${m.n}).`;
    case "no_out_of_sample_skill": return `Measured on N=${m.n}: no out-of-sample skill over the base rate, so influence 0.`;
    case "out_of_sample_skill": return `Measured on N=${m.n}: out-of-sample skill, influence ${m.influence}.`;
    default: return m.basis;
  }
}
