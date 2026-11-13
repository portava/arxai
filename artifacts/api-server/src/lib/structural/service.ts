import { createHash } from "node:crypto";
import { fitStructuralModel, forecastStructural, evaluateForecast, performanceBrake, MODEL_POLICY,
  type StructuralModel, type StructuralBar, type StructuralForecast, type DataOrigin, type ForecastScore } from "@workspace/domain/structural";

export interface StoredForecast { id: string; issuedAt: number; forecast: StructuralForecast; scores: ForecastScore[] }
export interface ForecastRepository {
  list(userId: number, symbol: string): Promise<StoredForecast[]>;
  save(userId: number, row: StoredForecast, model: StructuralModel): Promise<StoredForecast>;
  appendScores(userId: number, id: string, scores: ForecastScore[]): Promise<void>;
}
export interface ForecastFeed { bars: StructuralBar[]; origin: DataOrigin; ready: boolean; reason: string | null }
export interface ForecastDependencies {
  readFeed(symbol: string): Promise<ForecastFeed>; repository: ForecastRepository; now(): number;
  fit?: (...args: Parameters<typeof fitStructuralModel>) => StructuralModel | Promise<StructuralModel>;
}

/** Dependency direction ends at data, receipt memory and math. No order capability. */
export class StructuralForecastService {
  private models = new Map<string, { model: StructuralModel; expires: number }>();
  private fitting = new Map<string, Promise<StructuralModel>>();
  private issuing = new Map<string, Promise<StoredForecast>>();
  constructor(private readonly deps: ForecastDependencies) {}

  private async model(feed: ForecastFeed): Promise<StructuralModel> {
    const key = `${feed.origin.provider}:${feed.origin.symbol}`;
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
      this.models.set(key, { model, expires: this.deps.now() + 3_600_000 });
      return model;
    }).finally(() => this.fitting.delete(key));
    this.fitting.set(key, work); return work;
  }

  issue(userId: number, symbol: string): Promise<StoredForecast> {
    const key = `${userId}:${symbol}`;
    const pending = this.issuing.get(key);
    if (pending) return pending;
    const work = this.issueOnce(userId, symbol).finally(() => this.issuing.delete(key));
    this.issuing.set(key, work); return work;
  }

  private async issueOnce(userId: number, symbol: string): Promise<StoredForecast> {
    const feed = await this.deps.readFeed(symbol), now = this.deps.now();
    const asOf = feed.bars.at(-1)?.closeTime;
    if (!feed.ready || asOf == null || asOf > now || now - asOf >= 60_000) throw new Error(feed.reason ?? "STALE_OR_UNAVAILABLE_FEED");
    if (feed.origin.kind === "SYNTHETIC_TEST") throw new Error("SIMULATED_INPUT_REFUSED");
    const existing = await this.deps.repository.list(userId, symbol);
    const sameBar = existing.find(r => r.forecast.asOf === asOf && r.forecast.origin.provider === feed.origin.provider);
    if (sameBar) return sameBar;
    const model = await this.model(feed);
    const samePolicy = existing.filter(r => r.forecast.version === model.version && r.forecast.origin.provider === feed.origin.provider);
    const observations = samePolicy.flatMap(r => r.scores.filter(s => s.horizon === 5)
      .map(s => ({ asOf: r.forecast.asOf, completedAt: s.observedThrough, brier: s.brier, baselineBrier: s.baselineBrier })));
    const quarantined = performanceBrake(samePolicy.some(r => r.forecast.gateReason === "PERFORMANCE_QUARANTINE"), observations, asOf);
    const forecast = forecastStructural(model, feed.bars.slice(-120), feed.origin, quarantined);
    const id = createHash("sha256").update(`${userId}:${symbol}:${asOf}:${model.modelId}`).digest("hex");
    const issuedAt = this.deps.now();
    if (issuedAt >= asOf + 60_000) throw new Error("FIRST_HORIZON_ALREADY_CLOSED");
    const row = { id: `structural-${id}`, issuedAt, forecast, scores: [] };
    // Await durable write. A save failure cannot be displayed as an issued forecast.
    return this.deps.repository.save(userId, row, model);
  }

  async history(userId: number, symbol: string): Promise<StoredForecast[]> {
    const rows = await this.deps.repository.list(userId, symbol);
    if (!rows.length) return rows;
    const feed = await this.deps.readFeed(symbol), now = this.deps.now();
    // A stale current tip may still resolve old horizons. Require same provider.
    for (const row of rows) {
      if (row.scores.some(s => s.horizon === 60) || row.forecast.origin.provider !== feed.origin.provider) continue;
      try {
        const future = feed.bars.filter(b => b.openTime >= row.forecast.asOf && b.closeTime <= row.forecast.asOf + 3_600_000);
        const scores = evaluateForecast(row.forecast, future, now).filter(s => !row.scores.some(old => old.horizon === s.horizon));
        if (scores.length) { await this.deps.repository.appendScores(userId, row.id, scores); row.scores.push(...scores); }
      } catch (error) {
        // Missing/gapped history is unresolved, never scored as NEITHER.
        if (!(error instanceof Error) || !["OUTCOME_HISTORY_GAP", "GAP_DUPLICATE_OR_OUT_OF_ORDER", "INVALID_OHLC", "NON_FINAL_OR_NON_M1"].includes(error.message)) throw error;
      }
    }
    return rows;
  }
}
