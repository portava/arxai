import {
  type AuditLesson, type TradeId, type VaultQuery,
  matchesEnvelope, applyLimit,
} from "./dataVault.types";

// ═══════════════════════════════════════════════════════════════════════════
// Audit Lesson Store — post-trade lessons. Each lesson carries an audit
// score 0..1 (1 = textbook execution, 0 = catastrophe), a category
// (entry / exit / size / rule / regime / execution), and a free-text
// lesson plus structured reasons.
//
// This store is the foundation for retrospective learning, calibration,
// and future training datasets.
// ═══════════════════════════════════════════════════════════════════════════

export interface AuditLessonStorePort {
  append(lesson: AuditLesson): Promise<void>;
  list(query?: VaultQuery): Promise<AuditLesson[]>;
  byTrade(tradeId: TradeId): Promise<AuditLesson[]>;
}

export function createInMemoryAuditLessonStore(): AuditLessonStorePort {
  const lessons: AuditLesson[] = [];
  const ids = new Set<string>();
  return {
    async append(lesson) {
      if (ids.has(lesson.lessonId)) {
        throw new Error(`lessonId ${lesson.lessonId} already exists — audit lessons are append-only`);
      }
      ids.add(lesson.lessonId);
      lessons.push(copy(lesson));
    },
    async list(query) {
      const q = query ?? {};
      const filtered = lessons.map(copy).filter((l) => matchesEnvelope(l, q));
      return applyLimit(filtered, q.limit);
    },
    async byTrade(tradeId) {
      return lessons.filter((l) => l.tradeId === tradeId).map(copy);
    },
  };
}

function copy(l: AuditLesson): AuditLesson {
  return { ...l, reasons: [...l.reasons] };
}
