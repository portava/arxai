import { scenarioIndex, scenarioOf, type DataOrigin, type StructuralBar, type Triple } from "./contracts.js";
import { observeStructure, structuralFeatures, validateBars, barStepMs } from "./observer.js";
import { probabilities, brier, logLoss } from "./math.js";
import { fitStructuralModel, predictMass, lowerMeanGain, fitWindowCount, MIN_FIT_WINDOWS, MODEL_POLICY, type StructuralModel } from "./model.js";

/**
 * Walk-forward accuracy: the model is fitted only on bars before a cutoff and
 * scored on forecasts issued after it, then refitted at the next cutoff. No
 * outcome used for scoring is ever seen by the fit that produced the forecast.
 * This measures this model on this history; it is not a promise about the future.
 */
export interface AccuracyRow { origin: number; p: Triple; baseline: Triple; outcome: number; mode: string }
export interface HorizonAccuracy {
  horizonBars: number; minutes: number; forecasts: number; folds: number;
  outcomes: { up: number; down: number; neither: number };
  /** Lower is better. Uniform = 1/3 each; baseline = the training period's own frequencies. */
  brier: number; baselineBrier: number; uniformBrier: number; logLoss: number;
  /** Mean Brier improvement over the baseline and its bootstrap 2.5% lower bound (> 0 = reliably better). */
  gainOverBaseline: number; gainLowerBound: number;
  /** How often the most likely class happened, versus always naming the baseline's most likely class. */
  topClassHitRate: number; baselineTopClassHitRate: number;
  /** When structure broke either way: share where the model gave the side that broke more weight than the other side. */
  breakSideHitRate: number | null; breaks: number;
  /** When the model leaned a side (that side its top class): share that broke that side first. */
  leanPrecision: number | null; leans: number;
  modes: Record<string, number>;
}
export interface WalkForwardResult { stepMs: number; bars: number; windows: number; folds: Array<{ trainBars: number; trainedThrough: number; gate: string; tested: number }>; horizons: HorizonAccuracy[] }

export function walkForwardAccuracy(bars: StructuralBar[], origin: DataOrigin, horizonBars: number[], opts: { folds?: number; stride?: number; fit?: typeof fitStructuralModel } = {}): WalkForwardResult {
  const folds = opts.folds ?? 4, stride = opts.stride ?? MODEL_POLICY.stride, fit = opts.fit ?? fitStructuralModel;
  const step = barStepMs(bars), n = bars.length;
  // The first fit needs the minimum training windows; the rest is split into equal test blocks.
  let firstCut = 120 + MIN_FIT_WINDOWS * MODEL_POLICY.stride + 60;
  while (firstCut < n && fitWindowCount(bars.slice(0, firstCut)) < MIN_FIT_WINDOWS) firstCut += MODEL_POLICY.stride;
  firstCut = Math.max(firstCut, Math.floor(n * .5));
  if (n - firstCut < 180 * folds) throw new Error("INSUFFICIENT_HISTORY_FOR_WALK_FORWARD");
  const block = Math.floor((n - firstCut) / folds);
  const rows = new Map<number, AccuracyRow[]>(horizonBars.map(h => [h, []]));
  const foldInfo: WalkForwardResult["folds"] = [];
  for (let k = 0; k < folds; k++) {
    const cut = firstCut + k * block, end = k === folds - 1 ? n : cut + block;
    let model: StructuralModel;
    try { model = fit(bars.slice(0, cut), origin); }
    catch (error) { foldInfo.push({ trainBars: cut, trainedThrough: bars[cut - 1]!.closeTime, gate: error instanceof Error ? error.message : "FIT_FAILED", tested: 0 }); continue; }
    let tested = 0;
    for (let i = Math.max(cut, 120); i + 60 <= end; i += stride) {
      const history = bars.slice(i - 120, i), future = bars.slice(i, i + 60), asOf = history.at(-1)!.closeTime;
      if (asOf < model.availableAt) continue;
      try { validateBars([...history, ...future], future.at(-1)!.closeTime, 180); } catch { continue; }
      const f = structuralFeatures(history, asOf);
      const prediction = predictMass(model, f.values, f.eligible);
      const event = observeStructure([...history, ...future]).events.find(e => e.time > asOf) ?? null;
      for (const h of horizonBars) {
        const outcome = scenarioIndex(scenarioOf(event && event.time <= asOf + h * step ? event : null));
        rows.get(h)!.push({ origin: asOf, p: probabilities(prediction.mass, h), baseline: probabilities(prediction.baseline, h), outcome, mode: prediction.mode });
      }
      tested++;
    }
    foldInfo.push({ trainBars: cut, trainedThrough: model.trainedThrough, gate: model.prebreakGate.reason, tested });
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const top = (p: Triple) => p.indexOf(Math.max(...p));
  const horizons = horizonBars.map(h => {
    const r = rows.get(h)!;
    const gains = r.map(x => brier(x.baseline, x.outcome) - brier(x.p, x.outcome));
    const breaks = r.filter(x => x.outcome < 2), leans = r.filter(x => top(x.p) < 2);
    const modes: Record<string, number> = {};
    for (const x of r) modes[x.mode] = (modes[x.mode] ?? 0) + 1;
    return { horizonBars: h, minutes: h * step / 60_000, forecasts: r.length, folds: foldInfo.filter(f => f.tested > 0).length,
      outcomes: { up: r.filter(x => x.outcome === 0).length, down: r.filter(x => x.outcome === 1).length, neither: r.filter(x => x.outcome === 2).length },
      brier: mean(r.map(x => brier(x.p, x.outcome))), baselineBrier: mean(r.map(x => brier(x.baseline, x.outcome))),
      uniformBrier: mean(r.map(x => brier([1 / 3, 1 / 3, 1 / 3], x.outcome))), logLoss: mean(r.map(x => logLoss(x.p, x.outcome))),
      gainOverBaseline: mean(gains), gainLowerBound: r.length ? lowerMeanGain(gains) : NaN,
      topClassHitRate: mean(r.map(x => Number(top(x.p) === x.outcome))), baselineTopClassHitRate: mean(r.map(x => Number(top(x.baseline) === x.outcome))),
      breakSideHitRate: breaks.length ? mean(breaks.map(x => Number(x.p[x.outcome]! > x.p[1 - x.outcome]!))) : null, breaks: breaks.length,
      leanPrecision: leans.length ? mean(leans.map(x => Number(top(x.p) === x.outcome))) : null, leans: leans.length,
      modes } satisfies HorizonAccuracy;
  });
  return { stepMs: step, bars: n, windows: fitWindowCount(bars), folds: foldInfo, horizons };
}
