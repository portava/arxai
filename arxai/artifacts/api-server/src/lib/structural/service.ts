import { createHash } from "node:crypto";
import { fitStructuralModel, forecastStructural, evaluateForecast, performanceBrake, MODEL_POLICY, fitWindowCount, MIN_FIT_WINDOWS,
  calibrate, probabilities, scenarioIndex, type GradedObservation,
  forecastHorizon, forecastHorizonBars, forecastStepMs, forecastHorizonId, DEFAULT_FORECAST_HORIZON, FORECAST_HORIZONS,
  regradeAgainstBaseline, type StructuralModel, type StructuralBar, type StructuralForecast, type DataOrigin, type ForecastScore, type ForecastHorizonPreset } from "@workspace/domain/structural";

export interface StoredForecast { id: string; issuedAt: number; forecast: StructuralForecast; scores: ForecastScore[] }
export interface ForecastRepository {
  list(userId: number, symbol: string): Promise<StoredForecast[]>;
  save(userId: number, row: StoredForecast, model: StructuralModel): Promise<StoredForecast>;
  appendScores(userId: number, id: string, scores: ForecastScore[]): Promise<void>;
}
/** What the forecast saw when it looked at the feed. Safe to show a user. */
export interface ForecastFeedDiagnostics {
  historySource: string | null; historyBars: number; chartSource: string | null;
  chartQuality: string; chartAiUsable: boolean; closedBars: number; lastCloseAgeSeconds: number | null;
  /** Stored bars older than the newest unbroken run (separated from it by a gap). */
  barsBeforeLastGap?: number;
  /** Bar length the forecast read, e.g. "M1" or "H4". */
  timeframe?: string;
  /** Consecutive 180-bar windows the model could train on, and how many it needs. */
  trainingWindows?: number; trainingWindowsNeeded?: number;
}
export interface ForecastFeed { bars: StructuralBar[]; origin: DataOrigin; ready: boolean; reason: string | null; diagnostics?: ForecastFeedDiagnostics }
/**
 * Fewest unbroken one-minute bars the model can be fitted on. It follows from
 * MODEL_POLICY (15-bar stride, 60-minute purge, 80 training episodes after the
 * chronological split); a test pins it to the model's actual behaviour.
 */
export const MIN_FIT_BARS = 2460;
/** A domain refusal: a stable code plus the non-secret facts behind it. */
export class ForecastRefusal extends Error {
  constructor(readonly code: string, readonly detail?: ForecastFeedDiagnostics) { super(code); this.name = "ForecastRefusal"; }
}
export interface ForecastDependencies {
  readFeed(symbol: string, horizon?: ForecastHorizonPreset): Promise<ForecastFeed>; repository: ForecastRepository; now(): number;
  fit?: (...args: Parameters<typeof fitStructuralModel>) => StructuralModel | Promise<StructuralModel>;
}

/** Dependency direction ends at data, receipt memory and math. No order capability. */
export class StructuralForecastService {
  private models = new Map<string, { model: StructuralModel; expires: number }>();
  private fitting = new Map<string, Promise<StructuralModel>>();
  private issuing = new Map<string, Promise<StoredForecast>>();
  constructor(private readonly deps: ForecastDependencies) {}

  private async model(feed: ForecastFeed, horizon: ForecastHorizonPreset): Promise<StructuralModel> {
    const key = `${feed.origin.provider}:${feed.origin.symbol}:${horizon.timeframe}`;
    const cached = this.models.get(key);
    if (cached && cached.expires > this.deps.now()) return cached.model;
    const pending = this.fitting.get(key);
    if (pending) return pending;
    const work = Promise.resolve().then(async () => {
      const model = await (this.deps.fit ?? fitStructuralModel)(feed.bars, feed.origin);
      // Include full input content: corrections at an unchanged cutoff must not
      // silently reuse another model identity.
      const hash = createHash("sha256").update(JSON.stringify({ bars: feed.bars, policy: MODEL_POLICY })).digest("hex");
      model.modelId += `:${hash}`;
      if (this.models.size >= 12) this.models.delete(this.models.keys().next().value!);
      // Refit at most hourly, or once per bar for bars longer than an hour.
      this.models.set(key, { model, expires: this.deps.now() + Math.max(3_600_000, horizon.stepMs) });
      return model;
    }).finally(() => this.fitting.delete(key));
    this.fitting.set(key, work); return work;
  }

  issue(userId: number, symbol: string, horizonId: string = DEFAULT_FORECAST_HORIZON): Promise<StoredForecast> {
    const horizon = forecastHorizon(horizonId);
    if (!horizon) return Promise.reject(new ForecastRefusal("INVALID_HORIZON"));
    const key = `${userId}:${symbol}:${horizon.id}`;
    const pending = this.issuing.get(key);
    if (pending) return pending;
    // Reading history and fitting take several seconds, so a request made late
    // in a minute could cross the bar boundary and be refused although a newer
    // closed bar was moments away. Re-read once for exactly those two refusals;
    // every other refusal, and a second miss, is returned as is.
    const work = this.issueOnce(userId, symbol, horizon).catch(error => {
      const code = error instanceof Error ? error.message : "";
      if (code !== "LAST_CLOSED_BAR_OLDER_THAN_ONE_MINUTE" && code !== "LAST_CLOSED_BAR_OLDER_THAN_ONE_BAR" && code !== "FIRST_HORIZON_ALREADY_CLOSED") throw error;
      return this.issueOnce(userId, symbol, horizon);
    }).finally(() => this.issuing.delete(key));
    this.issuing.set(key, work); return work;
  }

  private async issueOnce(userId: number, symbol: string, horizon: ForecastHorizonPreset): Promise<StoredForecast> {
    const feed = await this.deps.readFeed(symbol, horizon), now = this.deps.now();
    const asOf = feed.bars.at(-1)?.closeTime;
    const facts = (extra: Partial<ForecastFeedDiagnostics> = {}): ForecastFeedDiagnostics | undefined => feed.diagnostics
      ? { ...feed.diagnostics, timeframe: horizon.timeframe, lastCloseAgeSeconds: asOf == null ? null : Math.round((now - asOf) / 1000), ...extra } : undefined;
    // The newest closed bar must be the one that just closed: older than one
    // bar means the feed missed a close (one minute for M1, four hours for H4).
    if (!feed.ready || asOf == null || asOf > now || now - asOf >= horizon.stepMs) {
      const stale = horizon.stepMs === 60_000 ? "LAST_CLOSED_BAR_OLDER_THAN_ONE_MINUTE" : "LAST_CLOSED_BAR_OLDER_THAN_ONE_BAR";
      const code = !feed.ready ? feed.reason ?? "FEED_NOT_READY" : asOf == null ? "NO_CLOSED_BARS" : asOf > now ? "LAST_BAR_IN_FUTURE" : stale;
      throw new ForecastRefusal(code, facts());
    }
    if (feed.origin.kind === "SYNTHETIC_TEST") throw new Error("SIMULATED_INPUT_REFUSED");
    // A window is defined by its bar length; never read it from other bars.
    if (feed.bars.some(b => b.closeTime - b.openTime !== horizon.stepMs)) throw new ForecastRefusal("FEED_BAR_LENGTH_MISMATCH", facts());
    // Say so before fitting, with the facts, instead of a bare model error.
    const windows = fitWindowCount(feed.bars);
    if (windows < MIN_FIT_WINDOWS) throw new ForecastRefusal("UNBROKEN_HISTORY_TOO_SHORT", facts({ trainingWindows: windows, trainingWindowsNeeded: MIN_FIT_WINDOWS }));
    if ((feed.diagnostics?.closedBars ?? feed.bars.length) < 120) throw new ForecastRefusal("RECENT_HISTORY_HAS_GAP", facts());
    const existing = (await this.deps.repository.list(userId, symbol)).filter(r => forecastHorizonId(r.forecast) === horizon.id);
    const sameBar = existing.find(r => r.forecast.asOf === asOf && r.forecast.origin.provider === feed.origin.provider);
    if (sameBar) return sameBar;
    const model = await this.model(feed, horizon);
    const samePolicy = existing.filter(r => r.forecast.version === model.version && r.forecast.origin.provider === feed.origin.provider);
    const observations = samePolicy.flatMap(r => r.scores.filter(s => s.horizon === 5)
      .map(s => ({ asOf: r.forecast.asOf, completedAt: s.observedThrough, brier: s.brier, baselineBrier: s.baselineBrier })));
    const quarantined = performanceBrake(samePolicy.some(r => r.forecast.gateReason === "PERFORMANCE_QUARANTINE"), observations, asOf);
    const forecast = forecastStructural(model, feed.bars.slice(-120), feed.origin, quarantined, horizon.bars, horizon.id);
    // Learn from this window's graded forecasts: calibrate the shown
    // probabilities only when that scored better on forecasts it never saw.
    const graded: GradedObservation[] = existing.filter(r => r.forecast.origin.provider === feed.origin.provider).flatMap(r => {
      const score = r.scores.find(s => s.horizon === horizon.bars);
      return score ? [{ p: r.forecast.calibration?.raw ?? probabilities(r.forecast.mass, horizon.bars), outcome: scenarioIndex(score.outcome),
        completedAt: score.observedThrough, asOf: r.forecast.asOf, update: Boolean(r.forecast.update) }] : [];
    });
    const windowMs = horizon.bars * horizon.stepMs;
    // A forecast issued while an earlier one of this window is still open is
    // an update of it. Recorded now, at issue, and never changed afterwards.
    const anchor = existing.filter(r => !r.forecast.update && r.forecast.origin.provider === feed.origin.provider && r.forecast.asOf < asOf)
      .sort((a, b) => b.forecast.asOf - a.forecast.asOf)[0];
    if (anchor && asOf < anchor.forecast.asOf + windowMs)
      forecast.update = { of: anchor.id, anchorAsOf: anchor.forecast.asOf, barsIntoWindow: Math.round((asOf - anchor.forecast.asOf) / horizon.stepMs) };
    const window = forecast.horizons.find(h => h.bars === horizon.bars);
    if (window) {
      const learned = calibrate(window.probabilities, graded, asOf, windowMs);
      window.probabilities = learned.shown;
      forecast.calibration = learned.record;
    }
    const id = createHash("sha256").update(`${userId}:${symbol}:${horizon.id}:${asOf}:${model.modelId}`).digest("hex");
    const issuedAt = this.deps.now();
    if (issuedAt >= asOf + horizon.stepMs) throw new ForecastRefusal("FIRST_HORIZON_ALREADY_CLOSED", facts({ lastCloseAgeSeconds: Math.round((issuedAt - asOf) / 1000) }));
    const row = { id: `structural-${id}`, issuedAt, forecast, scores: [] };
    // Await durable write. A save failure cannot be displayed as an issued forecast.
    return this.deps.repository.save(userId, row, model);
  }

  async history(userId: number, symbol: string): Promise<StoredForecast[]> {
    const rows = await this.deps.repository.list(userId, symbol);
    if (!rows.length) return rows;
    const now = this.deps.now();
    // Read each bar length's feed only when a saved forecast of that length
    // has a horizon that has since closed and is still unscored.
    const feeds = new Map<string, Promise<ForecastFeed>>();
    const feedFor = (h: ForecastHorizonPreset) => {
      if (!feeds.has(h.timeframe)) feeds.set(h.timeframe, this.deps.readFeed(symbol, h));
      return feeds.get(h.timeframe)!;
    };
    // A stale current tip may still resolve old horizons. Require same provider.
    for (const row of rows) {
      const step = forecastStepMs(row.forecast);
      const preset = forecastHorizon(forecastHorizonId(row.forecast)) ?? FORECAST_HORIZONS.find(h => h.stepMs === step);
      // A window scored before grades existed has no letter; it is still due.
      const windowBars = forecastHorizonBars(row.forecast);
      const windowScores = row.scores.filter(s => s.horizon === windowBars);
      const ungradedWindow = windowScores.length > 0 && !windowScores.some(s => s.grade);
      if (!preset || (row.scores.some(s => s.horizon === 60) && !ungradedWindow) || now < row.forecast.asOf + step) continue;
      const feed = await feedFor(preset);
      if (row.forecast.origin.provider !== feed.origin.provider) continue;
      try {
        const future = feed.bars.filter(b => b.openTime >= row.forecast.asOf && b.closeTime <= row.forecast.asOf + 60 * step);
        const scores = evaluateForecast(row.forecast, future, now).flatMap(s => {
          if (!row.scores.some(old => old.horizon === s.horizon)) return [s];
          return s.horizon === windowBars && ungradedWindow && s.grade ? [{ ...s, lateGrade: true }] : [];
        });
        if (scores.length) {
          await this.deps.repository.appendScores(userId, row.id, scores);
          row.scores = [...row.scores.filter(old => !scores.some(s => s.horizon === old.horizon)), ...scores];
        }
      } catch (error) {
        // Missing/gapped history is unresolved, never scored as NEITHER.
        if (!(error instanceof Error) || !["OUTCOME_HISTORY_GAP", "GAP_DUPLICATE_OR_OUT_OF_ORDER", "INVALID_OHLC", "NON_FINAL_OR_NON_M1"].includes(error.message)) throw error;
      }
    }
    // Older grades are re-derived against the baseline for the reader; the
    // stored evaluation rows are never rewritten.
    return rows.map(r => ({ ...r, scores: r.scores.map(regradeAgainstBaseline) }));
  }
}
