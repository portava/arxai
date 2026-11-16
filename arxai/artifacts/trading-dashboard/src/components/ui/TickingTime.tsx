import { useEffect, useState } from "react";

/** Relative-time text owns its clock so a one-second label update never needs
 * to rerender a chart or analysis panel. Invalid stamps never start a timer. */
export function TickingTime({ timestamp, format }: {
  timestamp: string; format: (timestamp: string, now: number) => string;
}) {
  const [, refresh] = useState(0);
  const valid = Number.isFinite(Date.parse(timestamp));
  useEffect(() => {
    if (!valid) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = () => refresh(t => t + 1);
    const stop = () => { if (timer !== null) clearInterval(timer); timer = null; };
    const resume = () => { stop(); if (!document.hidden) { tick(); timer = setInterval(tick, 1000); } };
    if (!document.hidden) timer = setInterval(tick, 1000);
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    return () => { stop(); document.removeEventListener("visibilitychange", resume); window.removeEventListener("focus", resume); };
  }, [valid]);
  return <>{valid ? format(timestamp, Date.now()) : "Time unavailable"}</>;
}
