// Usage: node scripts/research/audit-paper-selection.mjs STUDY_DIRECTORY [funded|control]
// Read-only. Input is a frozen ARX paper study, with decisions and executable ticks.
import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { pathToFileURL } from "node:url";

const minute = 60_000;
const maxFillDelay = 3_000;

async function* rows(file) {
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    if (line.trim()) yield JSON.parse(line);
  }
}

function after(quotes, time) {
  let lo = 0, hi = quotes.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (quotes[mid].received <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function stopOrTarget(plan, q) {
  if (plan.direction === "BUY") return q.bid <= plan.stop ? "stop" : q.bid >= plan.target ? "target" : null;
  return q.ask >= plan.stop ? "stop" : q.ask <= plan.target ? "target" : null;
}

function nextQuoteOutcome(plan, quotes, signal, end) {
  const index = after(quotes, signal), q = quotes[index];
  if (!q || q.received > Math.min(end, signal + maxFillDelay)) return { outcome: "unfilled" };
  const buy = plan.direction === "BUY", sign = buy ? 1 : -1;
  const entry = buy ? q.ask : q.bid, risk = sign * (entry - plan.stop);
  if (risk <= 0 || sign * (plan.target - entry) <= 0) return { outcome: "unfilled" };
  for (let i = index; i < quotes.length && quotes[i].received <= end; i++) {
    const tick = quotes[i], outcome = stopOrTarget(plan, tick);
    if (outcome) return { outcome, netR: sign * ((buy ? tick.bid : tick.ask) - entry) / risk };
  }
  return { outcome: "open" };
}

export function compareEntries(plan, quotes, signal, end, level) {
  const first = nextQuoteOutcome(plan, quotes, signal, end);
  if (!Number.isFinite(level) || level <= 0) return { first, retest: { outcome: "no_pullback_level" } };
  const open = Math.ceil(signal / minute) * minute, close = open + minute;
  if (end < close) return { first, retest: { outcome: "open" } };
  let firstEpoch, lastEpoch, lastReceipt = signal, lastPrice, touched = false;
  const buy = plan.direction === "BUY";
  for (let i = after(quotes, signal); i < quotes.length && quotes[i].received <= close; i++) {
    const q = quotes[i];
    if (q.received - lastReceipt > 2 * maxFillDelay) return { first, retest: { outcome: "missing_ticks" } };
    lastReceipt = q.received;
    if (stopOrTarget(plan, q)) return { first, retest: { outcome: "expired" } };
    if (q.epoch * 1000 < open || q.epoch * 1000 >= close) continue;
    firstEpoch ??= q.epoch;
    lastEpoch = q.epoch;
    lastPrice = q.quote;
    touched ||= buy ? q.quote <= level : q.quote >= level;
  }
  if (firstEpoch == null || firstEpoch * 1000 - open > maxFillDelay || close - lastEpoch * 1000 > maxFillDelay) {
    return { first, retest: { outcome: "missing_ticks" } };
  }
  if (!touched || !(buy ? lastPrice > level : lastPrice < level)) return { first, retest: { outcome: "no_retest" } };
  return { first, retest: nextQuoteOutcome(plan, quotes, close, end) };
}

function summarize(samples) {
  const outcomes = {};
  let settled = 0, wins = 0, sumR = 0;
  for (const { outcome, netR } of samples) {
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    if (!Number.isFinite(netR)) continue;
    settled++;
    wins += Number(netR > 0);
    sumR += netR;
  }
  return { candidates: samples.length, outcomes, settled, wins,
    winRate: settled ? wins / settled : null, averageNetR: settled ? sumR / settled : null };
}

async function report(root, tag) {
  if (!["funded", "control", "legacy"].includes(tag)) throw Error("Unknown study arm");
  const read = (name) => JSON.parse(readFileSync(path.join(root, name), "utf8"));
  const end = Math.max(read("funded-watermark.json").time, ...["Scanner", "Mission", "Forecast"]
    .flatMap(e => read(tag+"-"+e+"-trades.json").map(t => t.exitTime)));
  const quotes = new Map();
  for await (const q of rows(path.join(root, "forward", "ticks.jsonl"))) {
    if (q.received > end || !Number.isFinite(q.quote) || !(q.bid > 0 && q.ask >= q.bid)
      || q.received < q.epoch * 1000 || q.received - q.epoch * 1000 > maxFillDelay) continue;
    if (!quotes.has(q.symbol)) quotes.set(q.symbol, []);
    const group = quotes.get(q.symbol);
    if (!group.length || group.at(-1).epoch < q.epoch) group.push(q);
  }
  const seen = new Set(), samples = [];
  for await (const d of rows(path.join(root, tag+"-decisions.jsonl"))) {
    const p = d.confirmed;
    if (!d.admit || !p || p.timeframe !== "M1") continue;
    const key = [p.symbol,p.direction,Math.floor(d.time / minute)].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    const id = /^V(\d+)(_1S)?$/.exec(p.symbol);
    if (!id) throw Error("Unmapped study market "+p.symbol);
    const tape = quotes.get(id[2] ? "1HZ"+id[1]+"V" : "R_"+id[1]) ?? [];
    const setup = d.scans.find(s => s.symbol === p.symbol && s.timeframe === p.timeframe);
    const selected = d.mission?.symbol === p.symbol && d.mission?.direction === p.direction && d.mission?.timeframe === p.timeframe;
    samples.push({ symbol:p.symbol, side:p.direction, signal:d.time, selected,
      ...compareEntries(p, tape, d.time, end, setup?.pullbackLevel) });
  }
  const levelCases = samples.filter(s => s.retest.outcome !== "no_pullback_level");
  return { arm:tag, end, selected:summarize(samples.filter(x=>x.selected).map(x=>x.first)),
    passed:summarize(samples.filter(x=>!x.selected).map(x=>x.first)),
    firstClose:summarize(levelCases.map(x=>x.first)), nextCandleRetest:summarize(levelCases.map(x=>x.retest)), samples };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw Error("Supply a completed ARX paper study directory");
  process.stdout.write(JSON.stringify(await report(process.argv[2], process.argv[3] ?? "funded"), null, 2)+"\n");
}
