import { afterEach, describe, expect, it, vi } from "vitest";
import { layoutTextNote, MAX_NOTE_LENGTH, normalizeNoteText } from "./chartTextNote";
import { drawingNotes, drawingHandles, hitTestDrawings } from "./chartDrawingPrimitive";
import { validateDrawings, type ChartDrawing } from "./chartWorkspace";

const note: ChartDrawing = { id: "note", kind: "text", start: { time: 100, price: 10 }, color: "#ffffff", text: "Wait for the next candle" };
const measure = (text: string) => Array.from(text).length * 7;
afterEach(() => vi.restoreAllMocks());

describe("validated user text notes", () => {
  it("round-trips a literal plain-text note with its real anchor, color and lock", () => {
    const raw = { ...note, text: "  <img src=x onerror=alert(1)>\r\nMy own observation  ", locked: true, end: { time: 200, price: 20 }, html: "<b>ignored</b>" };
    const valid = validateDrawings([raw]);
    expect(valid).toEqual([{ ...note, text: "<img src=x onerror=alert(1)>\nMy own observation", locked: true }]);
    expect(validateDrawings(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
    expect(validateDrawings([{ ...note, kind: "horizontal" }])[0]).not.toHaveProperty("text");
  });
  it.each([null, {}, 123, "", "   ", "\n", "x".repeat(MAX_NOTE_LENGTH + 1), "a\u0000b", "a\tb", "a\u202Eb", "a\u2066b", "1\n2\n3\n4\n5\n6\n7"])("refuses invalid imported note contents %j", text => {
    expect(normalizeNoteText(text)).toBeNull();
    expect(validateDrawings([{ ...note, text }])).toEqual([]);
  });
  it("refuses nonfinite or missing anchors and keeps the existing 40-object cap", () => {
    for (const start of [null, { time: NaN, price: 10 }, { time: 100, price: Infinity }, { time: 0, price: 10 }]) expect(validateDrawings([{ ...note, start }])).toEqual([]);
    expect(validateDrawings(Array.from({ length: 41 }, (_, i) => ({ ...note, id: `note-${i}` })))).toHaveLength(40);
  });
  it("wraps Unicode graphemes without losing or splitting text, including explicit newlines", () => {
    const text = "e\u0301 👩🏽‍💻中文\nsecond";
    const layout = layoutTextNote(text, 40, measure)!;
    expect(layout.lines.join("")).toBe(text.replace("\n", ""));
    expect(layout.lines.some(line => line.includes("👩🏽‍💻"))).toBe(true);
    expect(layout.lines.some(line => line.startsWith("\u0301"))).toBe(false);
    expect(layout.width).toBe(40);
    expect(layoutTextNote("hello", NaN, measure)).toBeNull();
    expect(layoutTextNote("hello", 39, measure)).toBeNull();
    expect(layoutTextNote("one two three", 72, measure)?.lines).toEqual(["one two ", "three"]);
  });
});

describe("candle-bound text geometry", () => {
  it("bounds a long note to a small pane and exposes a continuation instead of silently clipping it",()=>{
    const long={...note,text:"a".repeat(240)};
    const card=drawingNotes([long],()=>({x:50,y:100}),100,200,measure)[0]!;
    expect(card.truncated).toBe(true);expect(card.compact).toBe(false);
    expect(card.lines.join("").length).toBeLessThan(240);
    expect(card.y+card.height).toBeLessThanOrEqual(200);
    expect(card.x+card.width).toBeLessThanOrEqual(100);
    expect(long.text).toHaveLength(240);
    const badge=drawingNotes([long],()=>({x:50,y:20}),100,40,measure)[0]!;
    expect(badge.compact).toBe(true);expect(badge.truncated).toBe(true);expect(badge.lines).toEqual([]);
    expect(badge.y+badge.height).toBeLessThanOrEqual(40);
    expect(drawingNotes([long],()=>({x:50,y:10}),100,20,measure)).toEqual([]);
  });
  it("moves with projected time and price, fits a visible card, and disappears with its anchor", () => {
    const first = drawingNotes([note], a => ({ x: a.time, y: a.price }), 300, 200, measure)[0]!;
    expect(first.anchor).toEqual({ x: 100, y: 10 });
    expect(first.x + first.width).toBeLessThanOrEqual(300);
    const moved = drawingNotes([note], a => ({ x: a.time - 50, y: a.price + 50 }), 300, 200, measure)[0]!;
    expect(moved.anchor).toEqual({ x: 50, y: 60 });
    expect(moved.y).not.toBe(first.y);
    for (const project of [() => null, () => ({ x: -1, y: 10 }), () => ({ x: 100, y: -1 }), () => ({ x: 301, y: 10 }), () => ({ x: NaN, y: 10 })]) expect(drawingNotes([note], project, 300, 200, measure)).toEqual([]);
    expect(drawingNotes([{ ...note, text: "" }], () => ({ x: 100, y: 10 }), 300, 200, measure)).toEqual([]);
  });
  it("hit-tests the actual card, respects stacking and retains an editable anchor", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ measureText: (text: string) => ({ width: measure(text) }) } as any);
    const project = () => ({ x: 100, y: 50 });
    const notes = [note, { ...note, id: "top", locked: true }];
    expect(hitTestDrawings(notes, null, project, 300, 200, { x: 150, y: 80 })).toEqual({ id: "top", part: "body" });
    expect(hitTestDrawings(notes, "note", project, 300, 200, { x: 100, y: 50 })).toEqual({ id: "note", part: "start" });
    expect(hitTestDrawings([note], null, project, 300, 200, { x: 0, y: 180 })).toBeNull();
    expect(drawingHandles(note, project, 300, 200)).toEqual([{ part: "start", point: { x: 100, y: 50 } }]);
    expect(hitTestDrawings([note], null, () => null, 300, 200, { x: 150, y: 80 })).toBeNull();
    const long={...note,text:"a".repeat(240)}, narrow=()=>({x:50,y:100});
    const clipped=drawingNotes([long],narrow,100,200)[0]!;
    expect(hitTestDrawings([long],null,narrow,100,200,{x:20,y:clipped.y+clipped.height-8})).toEqual({id:"note",part:"body"});
    expect(hitTestDrawings([long],null,narrow,100,200,{x:20,y:clipped.y+clipped.height+1})).toBeNull();
  });
});
