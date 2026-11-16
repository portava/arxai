import { z } from "zod/v4";

// Trade Court Replay — after every trade, walk through the full decision
// chain, render each contributor's verdict as a "ruling", grade it
// against the realized outcome, and extract structured lessons.
//
// Self-contained: caller adapts their decision-record shape into the
// minimal ReplayableDecision type so any pipeline (agent-system,
// agent-cascade, intelligence-v2…) can be replayed.

export const RulingRoleSchema = z.enum(["AGENT", "JUDGE", "GOVERNOR", "MONITOR"]);
export type RulingRole = z.infer<typeof RulingRoleSchema>;

export const StanceSchema = z.enum(["APPROVED", "WARNED", "BLOCKED", "ABSTAINED", "NEUTRAL"]);
export type Stance = z.infer<typeof StanceSchema>;

export interface ReplayableContributor {
  contributorId: string;          // e.g. "TREND", "JUDGE", "GOV"
  contributorName: string;
  role: RulingRole;
  stance: Stance;
  direction: "BUY" | "SELL" | null;
  conviction: number;             // 0..100
  reasons: string[];
}

export interface ReplayableDecision {
  decisionId: string;
  symbol: string;
  proposedDirection: "BUY" | "SELL";
  contributors: ReplayableContributor[];
  recordedAt: string;
}

export interface ReplayableOutcome {
  pnlR: number;
  exitReason: string;
  closedAt: string;
}

export const VerdictGradeSchema = z.enum(["RIGHT", "WRONG", "ABSTAINED", "NEUTRAL"]);
export type VerdictGrade = z.infer<typeof VerdictGradeSchema>;

export interface AgentRuling {
  contributorId: string;
  contributorName: string;
  role: RulingRole;
  stance: Stance;
  grade: VerdictGrade;
  scoreDelta: number;             // -100..+100 contribution to cumulative grade
  reasons: string[];
}

export const LessonSeveritySchema = z.enum(["INFO", "WATCH", "WARN", "CRITICAL"]);
export type LessonSeverity = z.infer<typeof LessonSeveritySchema>;

export interface Lesson {
  lessonId: string;
  decisionId: string;
  contributorId: string | null;     // null = system-level lesson
  tag: string;                      // e.g. "OVERCONFIDENT_TREND_IN_CHOP"
  severity: LessonSeverity;
  message: string;
  recordedAt: string;
}

export interface CourtSession {
  decisionId: string;
  outcome: ReplayableOutcome;
  rulings: AgentRuling[];
  netGradeScore: number;            // sum of scoreDeltas; >0 = system was right on net
  reasons: string[];
}

export interface LessonStorePort {
  put(lesson: Lesson): Promise<void>;
  list(filter?: { contributorId?: string; severity?: LessonSeverity; since?: Date }): Promise<Lesson[]>;
}
