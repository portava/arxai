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
  "Beginner":           "border-border bg-muted/50 text-foreground",
  "Developing Trader":  "border-warning/40 bg-warning/30 text-warning",
  "Disciplined Trader": "border-ruby/40 bg-ruby/30 text-ruby",
  "Consistent Trader":  "border-premium/40 bg-premium/30 text-premium",
  "Advanced Trader":    "border-success/40 bg-success/30 text-success",
  "Elite Trader":       "border-warning bg-warning/30 text-warning",
};
export const LEVEL_THRESHOLDS: Record<SkillLevel, number> = {
  "Beginner": 0, "Developing Trader": 30, "Disciplined Trader": 45,
  "Consistent Trader": 60, "Advanced Trader": 75, "Elite Trader": 90,
};
