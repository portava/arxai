// Eleanor grounding: the runtime verifier.
//
// The production chat route streams the model's text through a ClaimGate. The
// gate holds text until a sentence (or line) is complete. It then checks that
// segment against THIS turn's evidence and releases a verified version. That
// means no number, ticket, time or "it executed" statement reaches the user
// before it has been checked. Each finding is handled in a fixed way:
//
//   FABRICATION               the claim stays but is marked inline: 1.0850 [unverified]
//   WRONG_NUMBER              the sentence is removed and a notice says why
//   STALE_AS_LIVE             the sentence is removed and a notice says why
//   UNCALIBRATED_PROBABILITY  the sentence is removed and a notice says why
//   EXECUTION_UNCONFIRMED     the sentence is removed and a notice says why
//
// If the checker itself throws, the gate fails closed: the segment is withheld
// and replaced by a notice, never shown unchecked.

import { buildEvidenceIndex, type EvidenceIndex, type ToolOutput } from "./evidence.js";
import { checkSegment, isAbbrev, type Finding, type FindingKind, type Segment } from "./claimsChecker.js";

export const UNVERIFIED_MARK = " [unverified]";
export const VERIFIER_NOTICES: Record<Exclude<FindingKind, "FABRICATION">, string> = {
  WRONG_NUMBER: "[Removed by the ARX verifier: a figure here did not match ARX data for this turn.]",
  STALE_AS_LIVE: "[Removed by the ARX verifier: that price came from stale data and was presented as live.]",
  UNCALIBRATED_PROBABILITY: "[Removed by the ARX verifier: a figure was presented as a probability or edge that ARX has not measured. Raw scores are not probabilities, and a base rate is not an edge.]",
  EXECUTION_UNCONFIRMED: "[Removed by the ARX verifier: no executed result came back from ARX this turn, so I can't say the order executed.]",
};
export const VERIFIER_FAILED_NOTICE = "[Withheld: the ARX verifier could not check this part of the answer.]";
export const verifierFooter = (n: number): string =>
  `\n\n_ARX verifier: ${n} claim${n === 1 ? "" : "s"} in this answer could not be matched to this turn's ARX data and ${n === 1 ? "is" : "are"} marked or removed._`;

const REMOVE_KINDS = new Set<FindingKind>(["WRONG_NUMBER", "STALE_AS_LIVE", "UNCALIBRATED_PROBABILITY", "EXECUTION_UNCONFIRMED"]);

export interface VerifiedSegment {
  original: string;
  text: string;
  findings: Finding[];
}

/** Rewrite one segment so no ungrounded claim is shown as fact. */
export function verifySegment(seg: Segment, idx: EvidenceIndex): VerifiedSegment {
  const { findings } = checkSegment(seg, idx);
  if (findings.length === 0) return { original: seg.text, text: seg.text, findings };
  const remove = findings.find((f) => REMOVE_KINDS.has(f.kind));
  if (remove) {
    const lead = seg.text.match(/^\s*(?:[-*•]\s+|\d+[.)]\s+)?/)?.[0] ?? "";
    const trail = seg.text.endsWith("\n") ? "\n" : seg.text.match(/\s*$/)?.[0] ?? "";
    return { original: seg.text, text: `${lead}${VERIFIER_NOTICES[remove.kind as Exclude<FindingKind, "FABRICATION">]}${trail}`, findings };
  }
  // Only fabrications: mark each ungrounded claim right after it.
  let text = seg.text;
  const marks = findings.map((f) => f.claim.end - seg.start).sort((a, b) => b - a);
  for (const at of [...new Set(marks)]) text = text.slice(0, at) + UNVERIFIED_MARK + text.slice(at);
  return { original: seg.text, text, findings };
}

export interface VerifyReport {
  text: string;
  findings: Finding[];
  segments: VerifiedSegment[];
  failedClosed: boolean;
}

/** Whole-answer form (used by the eval harness and anywhere text is not streamed). */
export function verifyAnswer(answer: string, outputs: ToolOutput[], userText = ""): VerifyReport {
  const gate = new ClaimGate(buildEvidenceIndex(outputs, userText));
  const text = gate.push(answer) + gate.end();
  return { text: text + gate.footer(), findings: gate.findings, segments: gate.segments, failedClosed: gate.failedClosed };
}

/**
 * Streaming gate. push() returns only verified text for completed segments;
 * end() flushes the rest. `released` counts characters handed out, so a caller
 * that later discovers the turn was preamble can clear exactly that many.
 */
export class ClaimGate {
  private buf = "";
  private offset = 0;
  released = 0;
  findings: Finding[] = [];
  segments: VerifiedSegment[] = [];
  failedClosed = false;

  constructor(private readonly idx: EvidenceIndex) {}

  push(delta: string): string {
    this.buf += delta;
    let out = "";
    for (;;) {
      const cut = completeSegmentEnd(this.buf);
      if (cut < 0) break;
      out += this.release(this.buf.slice(0, cut));
      this.buf = this.buf.slice(cut);
    }
    return out;
  }

  end(): string {
    const rest = this.buf;
    this.buf = "";
    return rest ? this.release(rest) : "";
  }

  /** Footer to append once at the end of the final answer (empty when clean). */
  footer(): string {
    const n = this.findings.length;
    return n > 0 ? verifierFooter(n) : "";
  }

  private release(text: string): string {
    const seg: Segment = { text, start: this.offset, end: this.offset + text.length };
    this.offset += text.length;
    let v: VerifiedSegment;
    try {
      v = verifySegment(seg, this.idx);
    } catch {
      this.failedClosed = true;
      v = { original: text, text: text.trim() ? `${VERIFIER_FAILED_NOTICE}${text.endsWith("\n") ? "\n" : " "}` : text, findings: [] };
    }
    this.segments.push(v);
    this.findings.push(...v.findings);
    this.released += v.text.length;
    return v.text;
  }
}

/** End offset of the first complete segment in buf, or -1 if none is complete yet. */
function completeSegmentEnd(buf: string): number {
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c === "\n") return i + 1;
    if ((c === "." || c === "!" || c === "?") && i + 1 < buf.length) {
      const next = buf[i + 1];
      if ((next === " " || next === "\n") && !isAbbrev(buf, i)) return i + 1;
    }
  }
  return -1;
}
