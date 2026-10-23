import type { Lesson, LessonStorePort } from "./tradeCourt.types";

export function createInMemoryLessonStore(): LessonStorePort {
  const lessons: Lesson[] = [];
  return {
    async put(lesson) { lessons.push({ ...lesson }); },
    async list(filter) {
      let arr = [...lessons];
      if (filter?.contributorId !== undefined) {
        arr = arr.filter((l) => l.contributorId === filter.contributorId);
      }
      if (filter?.severity) {
        arr = arr.filter((l) => l.severity === filter.severity);
      }
      if (filter?.since) {
        const t = filter.since.getTime();
        arr = arr.filter((l) => Date.parse(l.recordedAt) >= t);
      }
      return arr;
    },
  };
}
