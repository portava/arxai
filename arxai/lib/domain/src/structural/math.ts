import { HORIZONS, type Mass, type Triple, type HorizonForecast } from "./contracts.js";

export function softmax(logits: readonly number[]): number[] {
  if (!logits.length || !logits.every(Number.isFinite)) throw new Error("INVALID_LOGITS");
  const max = Math.max(...logits), exps = logits.map(x => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(x => x / sum);
}
export function validateMass(mass: readonly Mass[]): void {
  if (mass.length !== 60 || mass.some(r => r.length !== 4 || r.some(x => !Number.isFinite(x) || x < 0))
    || mass.flat().reduce((s, x) => s + x, 0) > 1 + 1e-10) throw new Error("INVALID_EVENT_MASS");
}
export function hazardsToMass(hazards: readonly number[][]): Mass[] {
  if (hazards.length !== 60) throw new Error("INVALID_HAZARD_HORIZON");
  let survival = 1;
  const result = hazards.map(q => {
    if (q.length !== 5 || q.some(x => !Number.isFinite(x) || x < 0)
      || Math.abs(q.reduce((a, b) => a + b, 0) - 1) > 1e-10) throw new Error("INVALID_HAZARD");
    const row = q.slice(0, 4).map(x => x * survival) as Mass;
    survival *= q[4]!;
    return row;
  });
  validateMass(result); return result;
}
export function probabilities(mass: readonly Mass[], horizon: number): Triple {
  validateMass(mass);
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 60) throw new Error("INVALID_HORIZON");
  let up = 0, down = 0;
  for (const r of mass.slice(0, horizon)) { up += r[0] + r[1]; down += r[2] + r[3]; }
  return [up, down, Math.max(0, 1 - up - down)];
}
export const horizonsFromMass = (mass: Mass[]): HorizonForecast[] =>
  HORIZONS.map(minutes => ({ minutes, probabilities: probabilities(mass, minutes) }));

/** Preserve each 60m subtype, including zero-late-mass infeasibility. */
export function reallocateEarly(base: Mass[], candidate: Mass[], weight: number): Mass[] {
  validateMass(base); validateMass(candidate);
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) throw new Error("INVALID_BLEND");
  const out = base.map(r => [...r] as Mass);
  for (let k = 0; k < 4; k++) {
    const total = base.reduce((s, r) => s + r[k]!, 0);
    const late = base.slice(5).reduce((s, r) => s + r[k]!, 0);
    const early = base.slice(0, 5).map((r, j) => (1 - weight) * r[k]! + weight * candidate[j]![k]!);
    const proposed = early.reduce((a, b) => a + b, 0);
    const scale = proposed > total ? total / proposed : 1;
    const accepted = Math.min(total, proposed * scale);
    if (late <= 1e-15 && total - accepted > 1e-12) continue;
    for (let j = 0; j < 5; j++) out[j]![k] = early[j]! * scale;
    for (let j = 5; j < 60; j++) out[j]![k] = late > 1e-15 ? (total - accepted) * base[j]![k]! / late : 0;
  }
  validateMass(out); return out;
}

/** New explicit mapping: share directional mass using baseline early subtype/time
 * shape, falling back to terminal subtype shape and uniform early time. */
export function prebreakCandidate(base: Mass[], p: Triple): Mass[] {
  if (p.some(x => !Number.isFinite(x) || x < 0) || Math.abs(p.reduce((a, b) => a + b, 0) - 1) > 1e-10) throw new Error("INVALID_PROBABILITY");
  const result = Array.from({ length: 60 }, () => [0, 0, 0, 0] as Mass);
  for (let d = 0; d < 2; d++) {
    const ks = d === 0 ? [0, 1] : [2, 3];
    const early = base.slice(0, 5).reduce((s, r) => s + r[ks[0]!]! + r[ks[1]!]!, 0);
    const terminal = base.reduce((s, r) => s + r[ks[0]!]! + r[ks[1]!]!, 0);
    for (const k of ks) for (let j = 0; j < 5; j++) {
      const shape = early > 0 ? base[j]![k]! / early : terminal > 0 ? base.reduce((s, r) => s + r[k]!, 0) / terminal / 5 : 0;
      result[j]![k] = p[d]! * shape;
    }
  }
  return result;
}
export function brier(p: Triple, outcome: number): number { return p.reduce((s, x, i) => s + (x - Number(i === outcome)) ** 2, 0); }
export function logLoss(p: Triple, outcome: number): number { return -Math.log(Math.max(1e-15, p[outcome]!)); }
