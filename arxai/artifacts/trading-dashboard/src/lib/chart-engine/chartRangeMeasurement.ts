import type { ChartAnchor } from "./chartWorkspace";

/** Anchor prices are canonical price coordinates even on transformed displays.
 * Calendar time is not a bar count: weekends and missing history still count. */
export function rangeMeasurement(start: ChartAnchor, end: ChartAnchor) {
  if (![start.time,end.time,start.price,end.price].every(Number.isFinite)
    || start.time <= 0 || end.time <= 0 || start.price <= 0 || end.price <= 0) return null;
  const priceChange = end.price - start.price;
  const ratio = priceChange / start.price * 100;
  return { priceChange, percentChange: Number.isFinite(ratio) ? ratio : null, elapsedSeconds: Math.abs(end.time-start.time), backwards: end.time < start.time };
}

const signed = (value:number) => `${value > 0 ? "+" : ""}${Number(value.toPrecision(8))}`;
export function measurementLabels(start: ChartAnchor, end: ChartAnchor): string[] {
  const value=rangeMeasurement(start,end); if (!value) return [];
  let remaining=value.elapsedSeconds;
  const parts:string[]=[];
  for (const [seconds,label] of [[86400,"d"],[3600,"h"],[60,"m"]] as const) {
    const amount=Math.floor(remaining/seconds);remaining-=amount*seconds;
    if(amount)parts.push(`${amount}${label}`);
  }
  if(remaining || !parts.length)parts.push(`${Number(remaining.toFixed(3))}s`);
  return [`Price ${signed(value.priceChange)} (${value.percentChange === null ? "percentage unavailable" : signed(value.percentChange)+"%"})`,
    `${parts.join(" ")} elapsed${value.backwards ? " · earlier" : ""}`];
}
