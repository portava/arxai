/** User-authored text only. No HTML, Markdown, signal or trade interpretation. */
export const MAX_NOTE_LENGTH = 240;
export const MAX_NOTE_PARAGRAPHS = 6;
export const NOTE_FONT = "12px sans-serif";
export const NOTE_LINE_HEIGHT = 16;
export const NOTE_PADDING = 8;
export const NOTE_HEADER_HEIGHT = 18;
export const NOTE_MAX_WIDTH = 220;

export function normalizeNoteText(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_NOTE_LENGTH) return null;
  const text = value.replace(/\r\n?/g, "\n").trim();
  // Keep visible plain text and line breaks; reject invisible control/bidi
  // overrides rather than letting imported notes disguise their contents.
  if (!text || /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u.test(text)
    || text.split("\n").length > MAX_NOTE_PARAGRAPHS) return null;
  return text;
}

export interface NoteLayout { lines: readonly string[]; width: number; height: number }
export type MeasureNoteText = (text: string) => number;
let context: CanvasRenderingContext2D | null = null;
const layouts = new Map<string, NoteLayout>();
function measureNoteText(text: string): number {
  context ??= typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (context) { context.font = NOTE_FONT; return context.measureText(text).width; }
  // No canvas means there is no visible chart; keep non-browser callers bounded.
  return Array.from(text).length * 12;
}

/** Shared by the renderer and hit testing, so every visible note is selectable.
 * The bounded cache avoids measuring unchanged text on each pan/zoom frame. */
export function layoutTextNote(value: string, width: number, measure: MeasureNoteText = measureNoteText): NoteLayout | null {
  const text = normalizeNoteText(value);
  if (text == null || !Number.isFinite(width) || width < 40) return null;
  const boxWidth = Math.min(NOTE_MAX_WIDTH, Math.floor(width));
  const cacheKey = `${boxWidth}:${text}`;
  if (measure === measureNoteText && layouts.has(cacheKey)) return layouts.get(cacheKey)!;
  const available = boxWidth - NOTE_PADDING * 2;
  const lines: string[] = [];
  // Segmenter keeps combining marks and emoji sequences together while wrapping.
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const paragraph of text.split("\n")) {
    if (measure(paragraph) <= available) { lines.push(paragraph); continue; }
    let line = "";
    for (const { segment } of segmenter.segment(paragraph)) {
      const next = line + segment;
      if (line && measure(next) > available) {
        const wordBreak = line.lastIndexOf(" ");
        if (wordBreak > 0) { lines.push(line.slice(0, wordBreak + 1)); line = line.slice(wordBreak + 1) + segment; }
        else { lines.push(line); line = segment; }
      }
      else line = next;
    }
    lines.push(line);
  }
  const result = { lines: Object.freeze(lines), width: boxWidth, height: NOTE_PADDING * 2 + NOTE_HEADER_HEIGHT + lines.length * NOTE_LINE_HEIGHT };
  if (measure === measureNoteText) {
    if (layouts.size >= 128) layouts.delete(layouts.keys().next().value!);
    layouts.set(cacheKey, result);
  }
  return result;
}
