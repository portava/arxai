export type SessionType =
  | "DAILY_BRIEFING" | "PRE_MARKET_GUIDANCE" | "POST_TRADE_GUIDANCE"
  | "WEEKLY_RESET" | "RISK_WARNING" | "CONFIDENCE_REBUILD" | "DISCIPLINE_CHECK";

export interface MentorSession {
  id: number;
  sessionType: SessionType;
  skillLevel: string;
  mainFocus: string;
  mentorMessage: string;
  recommendedAction: string;
  relatedGoalId: number | null;
  relatedTradeId: number | null;
  relatedStrategyId: number | null;
  createdAt: string;
}
export interface MentorActionItem {
  id: number;
  mentorSessionId: number;
  actionTitle: string;
  actionDescription: string;
  status: "PENDING" | "IN_PROGRESS" | "DONE" | "SKIPPED";
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export const SESSION_TONE: Record<SessionType, string> = {
  DAILY_BRIEFING:      "border-sky-700 bg-sky-950/30 text-sky-100",
  PRE_MARKET_GUIDANCE: "border-emerald-700 bg-emerald-950/30 text-emerald-100",
  POST_TRADE_GUIDANCE: "border-violet-700 bg-violet-950/30 text-violet-100",
  WEEKLY_RESET:        "border-yellow-700 bg-yellow-950/30 text-yellow-100",
  RISK_WARNING:        "border-red-700 bg-red-950/30 text-red-100",
  CONFIDENCE_REBUILD:  "border-amber-700 bg-amber-950/30 text-amber-100",
  DISCIPLINE_CHECK:    "border-orange-700 bg-orange-950/30 text-orange-100",
};
