import {
  validateResearchV2Config,
  type DeepReadonly,
  type ResearchV2Config,
  type ResearchV2Input,
  type ResearchV2Partition,
  type ResearchV2Trade,
  type ResearchV2OpenObservation,
} from "@workspace/domain/backtest/research-core";

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const integer = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value);
// Only arithmetic-rounding tolerance, never display rounding or a percentage of capital.
const equal = (actual: unknown, expected: number): boolean => finite(actual) && finite(expected)
  && Math.abs(actual - expected) <= 32 * Number.EPSILON * Math.max(Number.MIN_VALUE, Math.abs(actual), Math.abs(expected));
const equalDecomposition = (net: number, gross: number, spread: number, slip: number, fee: number): boolean => {
  const decomposed=gross-spread-slip-fee;
  return [net,gross,spread,slip,fee,decomposed].every(finite)
    && Math.abs(net-decomposed)<=32*Number.EPSILON*Math.max(Number.MIN_VALUE,Math.abs(gross),Math.abs(spread),Math.abs(slip),Math.abs(fee),Math.abs(net));
};
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const yearMs = 365.25 * 86400000;
const cashAmount = (value: number, scale: number): number => {
  const amount=value*scale;
  if(!finite(value)||!finite(scale)||scale<=0||!finite(amount)
    ||(value!==0&&(amount===0||!finite(amount/scale)||Math.abs(amount/scale-value)>Math.max(Number.MIN_VALUE,Math.abs(value)*1e-8))))return NaN;
  return amount;
};
// Verify representability independently: huge balances must not swallow fills.
const cashMove = (balance: number, delta: number): number => {
  const next=balance+delta;
  if (!finite(balance)||!finite(delta)||!finite(next)||(delta!==0&&next===balance)
    ||Math.abs((next-balance)-delta)>Math.max(Number.MIN_VALUE,Math.abs(delta)*1e-8)) return NaN;
  return next;
};
type Position = DeepReadonly<ResearchV2Trade | ResearchV2OpenObservation>;

/** Independently reconstruct the optional fully-paid hypothetical account from
 * source bars and fills before displaying it. This does not re-run EMA signal
 * selection. The enclosing binding checks strategy/source identity and ledger
 * consistency; signal selection still trusts engine output. This is not an
 * independent strategy reproduction or source authentication. No actual balance,
 * currency, broker fill or return is inferred.
 * Every partition starts with the explicit scenario capital, independently.
 */
export function verifyChartResearchCash(
  input: DeepReadonly<ResearchV2Input>,
  config: DeepReadonly<ResearchV2Config>,
  partition: DeepReadonly<ResearchV2Partition>,
): boolean {
  try { return verify(input, config, partition); } catch { return false; }
}
function verify(input: DeepReadonly<ResearchV2Input>, config: DeepReadonly<ResearchV2Config>, p: DeepReadonly<ResearchV2Partition>): boolean {
  if (!object(config) || !object(p)) return false;
  if (config.cash === undefined) return !Object.hasOwn(p, "cash");
  if (!object(input) || !Array.isArray(input.bars) || !object(p.cash)) return false;
  const checked = validateResearchV2Config(config, input.bars.length), scenario = checked.cash;
  if (!scenario || checked.strategy.direction !== "long_only" || (input.priceBasis !== "BID" && input.priceBasis !== "MID")) return false;
  const bars: DeepReadonly<ResearchV2Input["bars"]> = input.bars;
  const step = input.intervalMs, cost = checked.costs, scale = cashAmount(scenario.fixedQuantity,scenario.pointValue);
  if(!finite(scale)||scale<=0||!Object.values(cost).every(value=>finite(cashAmount(value,scale))))return false;
  if (!integer(step) || step <= 0 || !integer(input.asOfMs)) return false;
  let previousClose = -1;
  const half = input.priceBasis === "MID" ? cost.fullSpreadPriceUnits / 2 : 0;
  const entry = (reference: number) => reference + ((input.priceBasis === "BID" ? cost.fullSpreadPriceUnits : half) + cost.adverseSlippagePerFillPriceUnits);
  const exit = (reference: number) => reference - (half + cost.adverseSlippagePerFillPriceUnits);
  for (const bar of bars) {
    if (!object(bar) || !integer(bar.openTimeMs) || bar.openTimeMs < 0 || bar.openTimeMs < previousClose || !Number.isSafeInteger(bar.openTimeMs + step) || bar.openTimeMs + step > input.asOfMs
      || ![bar.open,bar.high,bar.low,bar.close].every(value => finite(value) && value > 0)
      || bar.low > Math.min(bar.open,bar.close) || bar.high < Math.max(bar.open,bar.close) || bar.low > bar.high
      || exit(bar.low) <= 0 || !finite(entry(bar.high))) return false;
    previousClose = bar.openTimeMs + step;
  }
  const ranges = {train:[0,checked.splits.trainEndExclusive],validation:[checked.splits.trainEndExclusive,checked.splits.validationEndExclusive],holdout:[checked.splits.validationEndExclusive,bars.length]} as const;
  if (!(p.name in ranges)) return false;
  const [from,to] = ranges[p.name];
  if (p.fromInclusive !== from || p.toExclusive !== to || !Array.isArray(p.trades) || !Array.isArray(p.decisions) || !Array.isArray(p.markedCurve)
    || !Array.isArray(p.cash.curve) || p.markedCurve.length !== to-from || p.cash.curve.length !== to-from || !object(p.metrics)) return false;
  if (p.openPosition !== null && !object(p.openPosition)) return false;
  const decisions = new Map<number, DeepReadonly<ResearchV2Partition>["decisions"][number]>();
  let previousSignal = from-1;
  const decisionRows: DeepReadonly<ResearchV2Partition["decisions"]> = p.decisions;
  for (const decision of decisionRows) {
    if (!object(decision) || !integer(decision.signalIndex) || decision.signalIndex <= previousSignal || decision.signalIndex < from || decision.signalIndex >= to
      || decision.knownThroughMs !== bars[decision.signalIndex]!.openTimeMs + step || decision.side !== "BUY"
      || !["filled","gap_expired","invalid_bracket","partition_ended","insufficient_capital"].includes(decision.disposition)
      || (decision.disposition !== "filled" && decision.entryIndex !== null) || !object(decision.signal)
      || ![decision.signal.previousFastEma,decision.signal.previousSlowEma,decision.signal.fastEma,decision.signal.slowEma,decision.signal.atr,decision.signal.stopDistancePriceUnits,decision.signal.targetDistancePriceUnits].every(value=>finite(value)&&value>0)
      || decision.signal.previousFastEma>decision.signal.previousSlowEma || decision.signal.fastEma<=decision.signal.slowEma
      || !equal(decision.signal.stopDistancePriceUnits,decision.signal.atr*checked.strategy.stopAtrMultiple)
      || !equal(decision.signal.targetDistancePriceUnits,decision.signal.stopDistancePriceUnits*checked.strategy.targetR)) return false;
    decisions.set(decision.signalIndex,decision); previousSignal=decision.signalIndex;
  }
  const positions: Position[] = [...p.trades,...(p.openPosition ? [p.openPosition] : [])];
  let previousExit = from-1;
  for (const position of positions) {
    if (!object(position) || position.side !== "BUY" || !integer(position.signalIndex) || !integer(position.entryIndex)
      || position.signalIndex < from || position.entryIndex !== position.signalIndex+1 || position.entryIndex >= to || position.entryIndex <= previousExit
      || position.signalIndex < previousExit || position.entryTimeMs !== bars[position.entryIndex]!.openTimeMs
      || !equal(position.entryReferencePrice,bars[position.entryIndex]!.open) || !equal(position.entryPrice,entry(bars[position.entryIndex]!.open))) return false;
    const decision = decisions.get(position.signalIndex);
    if (!decision || decision.disposition !== "filled" || decision.entryIndex !== position.entryIndex || !object(decision.signal)
      || !finite(decision.signal.stopDistancePriceUnits) || decision.signal.stopDistancePriceUnits <= 0
      || !finite(decision.signal.targetDistancePriceUnits) || decision.signal.targetDistancePriceUnits <= 0
      || !equal(position.stopPrice,position.entryPrice-decision.signal.stopDistancePriceUnits)
      || !equal(position.targetPrice,position.entryPrice+decision.signal.targetDistancePriceUnits)
      || position.stopPrice <= 0 || position.targetPrice <= 0
      || position.entryTimeMs-decision.knownThroughMs > checked.maxEntryGapMs) return false;
    if ("exitIndex" in position) {
      if (!integer(position.exitIndex) || position.exitIndex < position.entryIndex || position.exitIndex >= to) return false;
      previousExit=position.exitIndex;
    } else previousExit=to;
  }
  if (p.decisions.filter(decision=>decision.disposition==="filled").length !== positions.length) return false;
  const benchmarkEntry = entry(bars[from]!.open), benchmarkDebit = cashAmount(benchmarkEntry+cost.feePerFillPriceUnits,scale);
  if (!finite(benchmarkDebit) || benchmarkDebit <= 0) return false;
  const benchmarkEntered = benchmarkDebit <= scenario.initialCapital;
  const benchmarkCash=benchmarkEntered?cashMove(scenario.initialCapital,-benchmarkDebit):scenario.initialCapital;
  if(!finite(benchmarkCash))return false;
  let available = scenario.initialCapital, completedNet = 0, completedCosts = 0, markedNet = 0;
  let wins=0,grossWins=0,grossLosses=0;
  let cashPeak = scenario.initialCapital, drawdown = 0, drawdownPercent = 0, unitPeak = 0, unitDrawdown = 0, deficit = false;
  let cursor=0, active: Position | null=null, lastEquity=scenario.initialCapital, benchmarkLast=scenario.initialCapital;
  for (let index=from;index<to;index++) {
    const bar=bars[index]!;
    // Pending decisions are evaluated at the next source open, before any
    // current-bar exit or proceeds. A rejected entry cannot wait for funds.
    const pending=decisions.get(index-1);
    if(pending){
      if(active)return false;
      if(bar.openTimeMs-pending.knownThroughMs>checked.maxEntryGapMs){
        if(pending.disposition!=="gap_expired"||pending.entryIndex!==null)return false;
      }else{
        const fill=entry(bar.open),stop=fill-pending.signal.stopDistancePriceUnits,target=fill+pending.signal.targetDistancePriceUnits;
        const debit=cashAmount(fill+cost.feePerFillPriceUnits,scale);
        if(![fill,stop,target,debit].every(finite)||debit<=0)return false;
        const expected=stop<=0||target<=0?"invalid_bracket":debit>available?"insufficient_capital":"filled";
        if(pending.disposition!==expected || pending.entryIndex!==(expected==="filled"?index:null))return false;
      }
    }
    if (positions[cursor]?.entryIndex===index) {
      if (active) return false;
      active=positions[cursor++]!;
      const debit=cashAmount(active.entryPrice+cost.feePerFillPriceUnits,scale);
      if (!finite(debit) || debit<=0 || debit>available) return false;
      available=cashMove(available,-debit);if(!finite(available))return false;
    }
    if (active) {
      const quoteOpen=bar.open-half, quoteLow=bar.low-half, quoteHigh=bar.high-half;
      const stopGap=quoteOpen<=active.stopPrice, targetGap=quoteOpen>=active.targetPrice;
      const stopTouched=quoteLow<=active.stopPrice, targetTouched=quoteHigh>=active.targetPrice;
      const atHoldingExit=index-active.entryIndex>=checked.strategy.maxHoldingBars;
      const reason=stopGap?"stop_gap":targetGap?"target_gap_capped":atHoldingExit?"max_hold_next_open":stopTouched?"stop":targetTouched?"target":null;
      if ("exitIndex" in active && active.exitIndex===index) {
        if (!reason || active.reason!==reason || !object(active.exitTime)) return false;
        const atOpen=reason==="stop_gap"||reason==="target_gap_capped"||reason==="max_hold_next_open";
        const reference=reason==="stop"?active.stopPrice+half:(reason==="target"||reason==="target_gap_capped")?active.targetPrice+half:bar.open;
        const fill=exit(reference), net=fill-active.entryPrice-2*cost.feePerFillPriceUnits;
        if (!equal(active.exitReferencePrice,reference) || !equal(active.exitPrice,fill)
          || active.exitTime.earliestMs!==bar.openTimeMs || active.exitTime.latestMs!==bar.openTimeMs+(atOpen?0:step) || active.exitTime.precision!==(atOpen?"open":"bar_interval")
          || active.ambiguousStopAndTarget!==(reason==="stop"&&targetTouched)
          || !equal(active.grossPriceUnits,reference-active.entryReferencePrice) || !equal(active.spreadCostPriceUnits,cost.fullSpreadPriceUnits)
          || !equal(active.slippageCostPriceUnits,2*cost.adverseSlippagePerFillPriceUnits) || !equal(active.feeCostPriceUnits,2*cost.feePerFillPriceUnits)
          || !equal(active.netPriceUnits,net) || !equalDecomposition(net,active.grossPriceUnits,active.spreadCostPriceUnits,active.slippageCostPriceUnits,active.feeCostPriceUnits)) return false;
        completedNet+=net;
        if(net>0){wins++;grossWins+=net;}else if(net<0)grossLosses-=net;
        completedCosts=completedCosts+cost.fullSpreadPriceUnits+2*cost.adverseSlippagePerFillPriceUnits+2*cost.feePerFillPriceUnits;
        available=cashMove(available,cashAmount(fill-cost.feePerFillPriceUnits,scale));if(!finite(available))return false;
        active=null;
      } else if (reason) return false; // A declared open position cannot survive an earlier modeled exit.
    }
    const signalAtClose=decisions.get(index);
    if(signalAtClose&&(active || (index===to-1)!==(signalAtClose.disposition==="partition_ended")))return false;
    markedNet=completedNet+(active?exit(bar.close)-active.entryPrice-2*cost.feePerFillPriceUnits:0);
    if(!finite(cashAmount(markedNet,scale))||(benchmarkEntered&&!finite(cashAmount(exit(bar.close)-benchmarkEntry-2*cost.feePerFillPriceUnits,scale))))return false;
    const equity=active?cashMove(available,cashAmount(exit(bar.close)-cost.feePerFillPriceUnits,scale)):available;
    const benchmarkEquity=benchmarkEntered?cashMove(benchmarkCash,cashAmount(exit(bar.close)-cost.feePerFillPriceUnits,scale)):scenario.initialCapital;
    const marked=p.markedCurve[index-from], point=p.cash.curve[index-from], observed=bar.openTimeMs+step;
    if (!object(marked)||!object(point)||marked.index!==index||point.index!==index||marked.observedThroughMs!==observed||point.observedThroughMs!==observed
      ||!equal(marked.netPriceUnits,markedNet)||!equal(point.cash,available)||!equal(point.equity,equity)||!equal(point.benchmarkEquity,benchmarkEquity)) return false;
    unitPeak=Math.max(unitPeak,markedNet); unitDrawdown=Math.max(unitDrawdown,unitPeak-markedNet);
    cashPeak=Math.max(cashPeak,equity);drawdown=Math.max(drawdown,cashPeak-equity);drawdownPercent=Math.max(drawdownPercent,(cashPeak-equity)/cashPeak*100);
    deficit ||= available<0||equity<0;lastEquity=equity;benchmarkLast=benchmarkEquity;
  }
  if (cursor!==positions.length || active!==p.openPosition) return false;
  if (p.openPosition) {
    const open=p.openPosition,last=bars[to-1]!, liquidation=exit(last.close);
    if (open.outcome!=="unresolved" || open.observedThroughMs!==last.openTimeMs+step || !equal(open.markReferencePrice,last.close)
      || !equal(open.hypotheticalLiquidationPrice,liquidation) || !equal(open.netIfLiquidatedPriceUnits,liquidation-open.entryPrice-2*cost.feePerFillPriceUnits)
      || !equal(open.paidEntryFeePriceUnits,cost.feePerFillPriceUnits) || !equal(open.estimatedExitFeePriceUnits,cost.feePerFillPriceUnits)
      || open.exitScheduledForNextOpen!==(to-open.entryIndex>=checked.strategy.maxHoldingBars)) return false;
  }
  const cash=p.cash, elapsed=bars[to-1]!.openTimeMs+step-bars[from]!.openTimeMs;
  const annualized=elapsed>=yearMs&&lastEquity>0?100*Math.expm1(Math.log(lastEquity/scenario.initialCapital)*yearMs/elapsed):null;
  const annualizedExpected=annualized!==null&&finite(annualized)?annualized:null;
  return cash.version===scenario.version && cash.unitLabel===scenario.unitLabel && equal(cash.initialCapital,scenario.initialCapital)
    && equal(cash.completedNet,cashAmount(completedNet,scale)) && equal(cash.completedCosts,cashAmount(completedCosts,scale)) && equal(cash.lastEquity,lastEquity)
    && equal(cash.totalReturnPercent,(lastEquity-scenario.initialCapital)/scenario.initialCapital*100)
    && (annualizedExpected===null?cash.annualizedReturnPercent===null:equal(cash.annualizedReturnPercent,annualizedExpected))
    && equal(cash.maxDrawdown,drawdown)&&equal(cash.maxDrawdownPercent,drawdownPercent)&&cash.capitalDeficit===deficit
    && object(cash.benchmark)&&cash.benchmark.status===(benchmarkEntered?"entered_unresolved":"insufficient_capital")
    && (benchmarkEntered?equal(cash.benchmark.entryPrice,benchmarkEntry):cash.benchmark.entryPrice===null)
    && equal(cash.benchmark.lastEquity,benchmarkLast)&&equal(cash.benchmark.totalReturnPercent,(benchmarkLast-scenario.initialCapital)/scenario.initialCapital*100)
    && (p.trades.length?equal(p.metrics.winRate,wins/p.trades.length):p.metrics.winRate===null)
    && (grossLosses>0?equal(p.metrics.profitFactor,grossWins/grossLosses):p.metrics.profitFactor===null)
    && p.metrics.profitFactorUnavailable===(!p.trades.length?"no_completed_trades":grossLosses===0?"no_losses":null)
    && p.metrics.completedTrades===p.trades.length&&equal(p.metrics.completedNetPriceUnits,completedNet)&&equal(p.metrics.lastMarkedNetPriceUnits,markedNet)&&equal(p.metrics.maxMarkedDrawdownPriceUnits,unitDrawdown);
}
