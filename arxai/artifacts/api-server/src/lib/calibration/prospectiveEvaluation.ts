// Prospective CALIBRATION comparison only. No promotion, authority or P&L claim.
import { createHash } from "node:crypto";
import { stableStringify } from "@workspace/features/event-chain";
import { brierScore, readCalibration, improvementLowerBound, CALIBRATION_METHOD, type CalibrationFit } from "@workspace/domain/calibration";

export const PROSPECTIVE_METHOD = "paired-brier-future-cohort-v1";
export interface FrozenCalibrator {
  fitKey: string; version: number; fittedAt: string; dataTo: string; fit: CalibrationFit;
}
export interface ProspectivePlan {
  method: typeof PROSPECTIVE_METHOD;
  userId: number; strategy: "eleanor" | "scanner"; symbol: string; timeframe: string;
  collectionStart: string; collectionEnd: string; labelDeadline: string;
  minSample: number; minImprovement: number;
  candidate: FrozenCalibrator; baseline: FrozenCalibrator;
}
export interface Receipt { outcomeId: string; phase: string; observedAt: string; payload: Record<string, unknown> }
export const prospectiveHash = (value: unknown) => createHash("sha256").update(stableStringify(value)).digest("hex");
const ms = (value: unknown) => typeof value === "string" ? Date.parse(value) : NaN;
export function validateProspectivePlan(p: ProspectivePlan, registeredAt: string): void {
  const start = ms(p.collectionStart), end = ms(p.collectionEnd), deadline = ms(p.labelDeadline), registered = ms(registeredAt);
  if (p.method !== PROSPECTIVE_METHOD || !Number.isSafeInteger(p.userId) || p.userId <= 0 || !["eleanor", "scanner"].includes(p.strategy)
    || !/^[A-Za-z0-9_.-]{1,40}$/.test(p.symbol) || !/^[A-Za-z0-9]{1,12}$/.test(p.timeframe)
    || ![start,end,deadline,registered].every(Number.isFinite) || start <= registered || end <= start || deadline <= end
    || deadline - start > 90 * 86400_000 || !Number.isSafeInteger(p.minSample) || p.minSample < 100
    || !Number.isFinite(p.minImprovement) || p.minImprovement < 0.005 || p.minImprovement >= 1) throw new Error("INVALID_PROSPECTIVE_PLAN");
  for (const model of [p.candidate, p.baseline]) {
    if (model.fitKey !== `${p.strategy}|${p.symbol}|${p.timeframe}` || !Number.isSafeInteger(model.version) || model.version <= 0
      || !Number.isFinite(ms(model.fittedAt)) || !Number.isFinite(ms(model.dataTo)) || ms(model.fittedAt) >= registered || ms(model.dataTo) >= registered
      || model.fit.method !== CALIBRATION_METHOD || model.fit.status !== "measured"
      || !["isotonic", "base_rate"].includes(model.fit.model)) throw new Error("INVALID_FROZEN_CALIBRATOR");
    if (!Array.isArray(model.fit.blocks) || model.fit.blocks.some(block => !Number.isFinite(block.probability) || block.probability < 0 || block.probability > 1)) throw new Error("INVALID_FROZEN_CALIBRATOR");
    for (let score = 0; score <= 100; score++) {
      const value = readCalibration(model.fit, score).probability;
      if (value == null || !Number.isFinite(value) || value < 0 || value > 1) throw new Error("INVALID_FROZEN_CALIBRATOR");
    }
  }
  if (p.candidate.version === p.baseline.version) throw new Error("IDENTICAL_CALIBRATOR_VERSION");
}

export interface ProspectiveReport {
  status: "COLLECTING" | "REFUSED" | "NO_IMPROVEMENT" | "CALIBRATION_IMPROVED";
  reasons: string[]; registeredAt: string; evaluatedAt: string; planHash: string; receiptHash: string;
  captured: number; resolved: number | null; candidateBrier: number | null; baselineBrier: number | null;
  improvementLowerBound: number | null;
  liveAllowed: false; autoPromotionAllowed: false;
  limitation: string;
}

/** All captured directional predictions count, including deleted/invalid/pending
 * ones. No optional stopping: metrics remain hidden until the fixed deadline.
 * Five time blocks reduce (but cannot remove) serial-dependence uncertainty. */
export function evaluateProspective(p: ProspectivePlan, registeredAt: string, receipts: readonly Receipt[], nowMs: number): ProspectiveReport {
  validateProspectivePlan(p, registeredAt);
  if (!Number.isFinite(nowMs)) throw new Error("INVALID_EVALUATION_TIME");
  const rows = [...receipts].sort((a,b) => ms(a.observedAt) - ms(b.observedAt) || (a.outcomeId < b.outcomeId ? -1 : a.outcomeId > b.outcomeId ? 1 : 0));
  const report: ProspectiveReport = {
    status: "COLLECTING", reasons: [], registeredAt, evaluatedAt: new Date(nowMs).toISOString(), planHash: prospectiveHash(p), receiptHash: prospectiveHash(rows),
    captured: rows.filter(r => r.phase === "prediction").length, resolved: null, candidateBrier: null, baselineBrier: null, improvementLowerBound: null,
    liveAllowed: false, autoPromotionAllowed: false,
    limitation: "Calibration-only diagnostic from the captured application ledger; not proof of trading edge, AACI benefit, independent observations, or tamper resistance against database administrators.",
  };
  if (nowMs < ms(p.labelDeadline)) return report;
  const reasons = new Set<string>();
  const groups = new Map<string, Receipt[]>();
  for (const row of rows) { const group = groups.get(row.outcomeId) ?? []; group.push(row); groups.set(row.outcomeId,group); }
  const candidate: number[] = [], baseline: number[] = [], outcomes: (0|1)[] = [], deltas: number[] = [];
  const blocks: number[][] = Array.from({length:5},()=>[]);
  const identities = new Set<string>();
  for (const [id, group] of groups) {
    const predictions = group.filter(r => r.phase === "prediction"), labels = group.filter(r => r.phase === "outcome");
    if (!id || predictions.length !== 1 || labels.length !== 1 || group.some(r => !["prediction","outcome"].includes(r.phase))) { reasons.add("INCOMPLETE_OR_MUTATED_LEDGER"); continue; }
    const pred = predictions[0], label = labels[0], d = pred.payload, l = label.payload;
    const capturedAt = ms(pred.observedAt), predictedAt = ms(d.created_at), resolvedAt = ms(l.resolved_at), labelAt = ms(label.observedAt);
    if (![capturedAt,predictedAt,resolvedAt,labelAt].every(Number.isFinite) || capturedAt < ms(p.collectionStart) || capturedAt >= ms(p.collectionEnd)
      || predictedAt < ms(p.collectionStart) || predictedAt > capturedAt || capturedAt - predictedAt > 60_000
      || resolvedAt <= capturedAt || labelAt < resolvedAt || labelAt > ms(p.labelDeadline)
      || d.outcome_status !== "PENDING" || d.resolved_at != null || d.locked !== true || ms(d.locked_at) > capturedAt || ms(d.locked_at) < predictedAt || !Number.isFinite(ms(d.locked_at))
      || d.user_id !== p.userId || d.symbol !== p.symbol || d.timeframe !== p.timeframe || !["BUY","SELL"].includes(String(d.direction))
      || (p.strategy === "scanner" && !d.scanner_signal_id)) { reasons.add("INVALID_OBSERVATION_TIMING_OR_SCOPE"); continue; }
    for (const field of ["scanner_signal_id", "prediction_id"]) {
      if (d[field] == null) continue;
      const identity = `${field}:${String(d[field])}`;
      if (identities.has(identity)) reasons.add("DUPLICATE_PREDICTION_IDENTITY");
      identities.add(identity);
    }
    const evidence = l.evidence as Record<string, unknown> | null;
    const directionalMove = l.outcome_status === "WIN" ? evidence?.favorableMovePct : evidence?.adverseMovePct;
    const evidenceObserved = evidence?.method === "observed_move" && typeof directionalMove === "number" && Number.isFinite(directionalMove) && directionalMove > 0;
    const evidenceClosed = evidence?.method === "closed_trade" && Number.isSafeInteger(l.trade_id) && Number(l.trade_id) > 0
      && typeof l.pnl_r === "number" && Number.isFinite(l.pnl_r) && (l.outcome_status === "WIN" ? l.pnl_r > 0 : l.pnl_r < 0);
    if (!["WIN","LOSS"].includes(String(l.outcome_status)) || (!evidenceObserved && !evidenceClosed)) { reasons.add("UNSUPPORTED_OR_UNVERIFIED_LABEL"); continue; }
    if (typeof d.confidence_score !== "number" || !Number.isFinite(d.confidence_score) || d.confidence_score < 0 || d.confidence_score > 100) { reasons.add("INVALID_PREDICTION_SCORE"); continue; }
    const cp = readCalibration(p.candidate.fit,d.confidence_score).probability!, bp = readCalibration(p.baseline.fit,d.confidence_score).probability!;
    const y = l.outcome_status === "WIN" ? 1 : 0;
    const delta = (bp-y)**2-(cp-y)**2;
    candidate.push(cp); baseline.push(bp); outcomes.push(y); deltas.push(delta);
    blocks[Math.min(4,Math.floor((capturedAt-ms(p.collectionStart))/(ms(p.collectionEnd)-ms(p.collectionStart))*5))].push(delta);
  }
  report.resolved = outcomes.length;
  if (report.captured < p.minSample) reasons.add("INSUFFICIENT_PROSPECTIVE_SAMPLE");
  if (report.resolved !== report.captured) reasons.add("INCOMPLETE_OUTCOME_COVERAGE");
  if (blocks.some(b => b.length < 10)) reasons.add("INSUFFICIENT_TEMPORAL_COVERAGE");
  if (reasons.size) return {...report,status:"REFUSED",reasons:[...reasons]};
  const mean = (values:number[]) => values.reduce((a,b)=>a+b,0)/values.length;
  const lowerBound = improvementLowerBound(deltas,blocks.map(mean));
  return {...report,status:lowerBound>p.minImprovement?"CALIBRATION_IMPROVED":"NO_IMPROVEMENT", candidateBrier:brierScore(candidate,outcomes),baselineBrier:brierScore(baseline,outcomes),improvementLowerBound:lowerBound};
}
