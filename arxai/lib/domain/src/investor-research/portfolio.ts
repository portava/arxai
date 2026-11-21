import { basketSchema, planSchema, researchAuthority } from "./contracts.js";

const cents = (n: number) => Math.round(n * 100);
const dollars = (n: number) => n / 100;
function boundedTotal(values: number[]): number {
  const total = values.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(total) || total > 1e14) throw new Error("Portfolio total exceeds supported precision");
  return total;
}
export function requireRecentSnapshot(asOf: string, now = Date.now()) {
  const age = now - Date.parse(asOf);
  if (age < -60_000 || age > 24 * 3600_000) throw new Error("Portfolio snapshot must be within the last 24 hours and not future-dated");
}
/** Capped water filling, in cents. Unallocatable amounts remain cash. */
export function cappedAllocation(weights: {symbol: string; weight: number}[], budget: number, cap: number): Map<string, number> {
  const allocated = new Map(weights.map(w => [w.symbol, 0]));
  let remaining = budget;
  let active = [...weights];
  while (active.length && remaining > 0) {
    const sum = active.reduce((a, w) => a + w.weight, 0);
    const capped = active.filter(w => remaining * w.weight / sum >= cap);
    if (capped.length) {
      for (const w of capped) { allocated.set(w.symbol, cap); remaining -= cap; }
      const names = new Set(capped.map(w => w.symbol));
      active = active.filter(w => !names.has(w.symbol));
      continue;
    }
    const shares = active.map(w => ({...w, raw: remaining * w.weight / sum}));
    for (const w of shares) allocated.set(w.symbol, Math.floor(w.raw));
    let leftover = remaining - shares.reduce((a, w) => a + Math.floor(w.raw), 0);
    shares.sort((a,b) => (b.raw % 1) - (a.raw % 1) || a.symbol.localeCompare(b.symbol));
    for (const w of shares) if (leftover > 0 && allocated.get(w.symbol)! < cap) { allocated.set(w.symbol, allocated.get(w.symbol)! + 1); leftover--; }
    break;
  }
  return allocated;
}
export function previewPortfolio(raw: unknown, now = Date.now()) {
  const p = planSchema.parse(raw); requireRecentSnapshot(p.asOf, now);
  const cash = cents(p.cash), held = new Map(p.holdings.map(h => [h.symbol, cents(h.value)]));
  const equity = boundedTotal([cash, ...held.values()]);
  if (equity <= 0) throw new Error("A positive portfolio value is required");
  const targets = p.targets.filter(t => !p.policy.blocked.includes(t.symbol));
  const targetSymbols = new Set(targets.map(t => t.symbol));
  const untracked = p.holdings.filter(h => !targetSymbols.has(h.symbol));
  const protectedValue = boundedTotal(untracked.map(h => cents(h.value)));
  const buffer = Math.ceil(equity * p.policy.cashBufferPct / 100);
  const cap = Math.floor(equity * p.policy.maxPositionPct / 100);
  const allocations = cappedAllocation(targets, Math.max(0,equity-buffer-protectedValue),cap);
  const rows = targets.map(t => {
    const current = held.get(t.symbol) ?? 0, target = allocations.get(t.symbol) ?? 0;
    return {symbol:t.symbol,current:dollars(current),target:dollars(target),driftPct:(current-target)/equity*100,
      delta:target-current};
  });
  const min = cents(p.policy.minOrder), max = cents(p.policy.maxOrder);
  const proposals: {symbol:string;side:"buy"|"sell";amount:number}[] = [];
  let available = cash;
  // Sells are hypothetical: output must never be handed to execution without fresh broker checks.
  for (const r of rows) if (r.delta < 0 && Math.abs(r.driftPct) > p.policy.driftBandPct) {
    const amount = Math.min(-r.delta,max);
    if (amount >= min && amount > 0) { proposals.push({symbol:r.symbol,side:"sell",amount:dollars(amount)}); available += amount; }
  }
  const buys = rows.filter(r => r.delta > 0 && (p.mode === "allocate" || Math.abs(r.driftPct) > p.policy.driftBandPct))
    .map(r => ({symbol:r.symbol, amount:Math.min(r.delta,max)})).filter(r => r.amount>=min && r.amount>0);
  const totalBuy = buys.reduce((s,r)=>s+r.amount,0), spendable=Math.max(0,available-buffer);
  for (const r of buys) {
    const amount=Math.floor(r.amount * Math.min(1,totalBuy ? spendable/totalBuy : 0));
    if(amount>=min && amount>0){proposals.push({symbol:r.symbol,side:"buy",amount:dollars(amount)});available-=amount;}
  }
  return {authority:researchAuthority,asOf:p.asOf,currency:p.currency,equity:dollars(equity),cashBuffer:dollars(buffer),
    cashAfterHypotheticalFills:dollars(available),rows:rows.map(({delta,...r})=>r),proposals,untracked,
    blockedTargets:p.targets.filter(t=>p.policy.blocked.includes(t.symbol)).map(t=>t.symbol),
    note:"USD stock-value simulation from supplied holdings. Untracked/blocked holdings stay untouched. Fees, slippage, tax and actual fills are not included; buys depending on sells are conditional. Amounts below the minimum or above capacity stay in cash.",};
}
export function checkResearchBasket(raw: unknown, now=Date.now()) {
  const p=basketSchema.parse(raw);requireRecentSnapshot(p.asOf,now);
  const holdings=new Map(p.holdings.map(h=>[h.symbol,cents(h.value)]));let cash=cents(p.cash);
  const equity=boundedTotal([cash,...holdings.values()]),seen=new Set<string>();
  const buffer=Math.ceil(equity*p.policy.cashBufferPct/100),cap=Math.floor(equity*p.policy.maxPositionPct/100);
  const rows=p.orders.map(order=>{
    const amount=cents(order.amount), held=holdings.get(order.symbol)??0, reasons:string[]=[];
    const key=`${order.symbol}:${order.side}`;
    if(seen.has(key))reasons.push("Duplicate symbol and side in this basket");seen.add(key);
    if(amount<=0 || amount<cents(p.policy.minOrder) || amount>cents(p.policy.maxOrder))reasons.push("Order amount outside supplied limits");
    if(p.policy.blocked.includes(order.symbol))reasons.push("Symbol is blocked by the supplied policy");
    if(order.side==="buy" && cash-amount<buffer)reasons.push("Cumulative buys breach the cash buffer");
    if(order.side==="buy" && held+amount>cap)reasons.push("Cumulative position exceeds concentration cap");
    if(order.side==="sell" && amount>held)reasons.push("Sale exceeds supplied holding; short selling is not modelled");
    if(!reasons.length){cash+=order.side==="sell"?amount:-amount;holdings.set(order.symbol,held+(order.side==="buy"?amount:-amount));}
    return {...order,status:reasons.length?"BLOCKED":"WITHIN_SUPPLIED_LIMITS",reasons};
  });
  return {authority:researchAuthority,rows,cashAfterHypotheticalFills:dollars(cash),
    note:"This is a hypothetical basket check, not the Risk Governor's approval. Supplied limits do not change platform limits. Broker identity, contract sizing, reservations and all existing execution gates still apply."};
}
