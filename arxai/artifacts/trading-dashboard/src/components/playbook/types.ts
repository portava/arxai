export interface PlaybookEntry {
  id: number;
  playbookId: number;
  entryType: string;
  title: string;
  description: string;
  confidenceScore: number;
  source: "MANUAL" | "AI" | "JOURNAL" | "DEBRIEF" | "REVIEW";
  isActive: number;
  createdAt: string;
  updatedAt: string;
}
export interface AISuggestion {
  entryType: string;
  title: string;
  description: string;
  confidenceScore: number;
  source: "AI";
  evidence: { tradeIds: number[]; debriefIds: number[]; reviewIds: number[] };
}
