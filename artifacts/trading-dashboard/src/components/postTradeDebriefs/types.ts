export type ChecklistAnswer = "YES" | "NO" | "UNSURE";
export interface ChecklistItem { id: string; answer: ChecklistAnswer; note?: string }
export interface DebriefDraft {
  tradeId: number;
  checklist: ChecklistItem[];
  traderEmotionAfter?: string;
  biggestMistake?: string;
  biggestStrength?: string;
  lessonLearned?: string;
}
