export type SkillLevel =
  | "Beginner" | "Developing Trader" | "Disciplined Trader"
  | "Consistent Trader" | "Advanced Trader" | "Elite Trader";

export interface TraderSkillProfile {
  id: number;
  skillLevel: SkillLevel;
  totalScore: number;
  disciplineScore: number;
  executionScore: number;
  riskScore: number;
  emotionalControlScore: number;
  consistencyScore: number;
  planningScore: number;
  reviewScore: number;
  practiceScore: number;
  createdAt: string;
  updatedAt: string;
}
export interface SkillLevelHistory {
  id: number;
  previousLevel: string;
  newLevel: string;
  reason: string;
  createdAt: string;
}
export interface SkillSuggestion {
  area: string;
  score?: number;
  message: string;
}

export const LEVEL_TONE: Record<SkillLevel, string> = {
  "Beginner":           "border-slate-700 bg-slate-900/50 text-slate-200",
  "Developing Trader":  "border-amber-700 bg-amber-950/30 text-amber-100",
  "Disciplined Trader": "border-sky-700 bg-sky-950/30 text-sky-100",
  "Consistent Trader":  "border-violet-700 bg-violet-950/30 text-violet-100",
  "Advanced Trader":    "border-emerald-700 bg-emerald-950/30 text-emerald-100",
  "Elite Trader":       "border-yellow-600 bg-yellow-950/30 text-yellow-100",
};
export const LEVEL_THRESHOLDS: Record<SkillLevel, number> = {
  "Beginner": 0, "Developing Trader": 30, "Disciplined Trader": 45,
  "Consistent Trader": 60, "Advanced Trader": 75, "Elite Trader": 90,
};
