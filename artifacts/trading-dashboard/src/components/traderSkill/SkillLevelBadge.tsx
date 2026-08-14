import { LEVEL_TONE, type SkillLevel } from "./types";

export function SkillLevelBadge({ level, total, size = "md" }:
  { level: SkillLevel; total?: number; size?: "sm"|"md"|"lg" }) {
  const tone = LEVEL_TONE[level];
  const sz = size === "lg" ? "px-4 py-2 text-base"
           : size === "sm" ? "px-1.5 py-0.5 text-[10px]"
           : "px-2.5 py-1 text-xs";
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border font-bold uppercase tracking-wide ${tone} ${sz}`}>
      <span>{level}</span>
      {total !== undefined && <span className="font-mono text-[0.85em] opacity-80">· {Math.round(total)}/100</span>}
    </span>
  );
}
