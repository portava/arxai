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
  DAILY_BRIEFING:      "border-ruby/40 bg-ruby/30 text-ruby",
  PRE_MARKET_GUIDANCE: "border-success/40 bg-success/30 text-success",
  POST_TRADE_GUIDANCE: "border-premium/40 bg-premium/30 text-premium",
  WEEKLY_RESET:        "border-warning/40 bg-warning/30 text-warning",
  RISK_WARNING:        "border-danger/40 bg-danger/30 text-danger",
  CONFIDENCE_REBUILD:  "border-warning/40 bg-warning/30 text-warning",
  DISCIPLINE_CHECK:    "border-warning/40 bg-warning/30 text-warning",
};
