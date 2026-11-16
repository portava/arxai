// Eleanor voice: the speech claim gate.
//
// Spoken answers pass the SAME claims checker as text answers
// (grounding/claimsChecker.ts): numbers, tickets, clock times, dates, "it
// executed" statements and probabilities. Speech is stricter than text in one
// way: text can show a claim with an inline "[unverified]" mark, but a listener
// cannot see a mark. So any spoken sentence with a finding is NOT read aloud. It
// is replaced by one short spoken notice.
//
// A sentence is spoken as-is only when:
//   1. it contains no checkable claim, or every claim in it is grounded in this
//      turn's evidence (tool outputs + the user's own words), or
//   2. it appears verbatim (after normalising markdown/whitespace) in text the
//      ARX text verifier already released to this user (the speech ledger, or
//      the user's persisted assistant messages). That text was checked against
//      the tool outputs of its own turn, so it is not re-checked against an
//      empty evidence set and stripped.
//
// Text the text verifier marked or removed ("[unverified]", "[Removed by the
// ARX verifier ...]", the footer) is never read aloud either.
//
// Pure and synchronous: the same function runs in CI on scripted transcripts and
// at runtime in the voice routes and the TTS route.

import { buildEvidenceIndex, type ToolOutput } from "../grounding/evidence.js";
import { checkSegment, splitSegments, type Finding } from "../grounding/claimsChecker.js";
import {
  UNVERIFIED_MARK,
  VERIFIER_FAILED_NOTICE,
  VERIFIER_NOTICES,
  verifyAnswer,
} from "../grounding/runtimeVerifier.js";

/** Spoken in place of one or more sentences whose claims could not be checked. */
export const SPOKEN_WITHHELD_NOTICE =
  "I've left out a figure I couldn't check against ARX data. The text chat shows the checked numbers.";
/** Spoken in place of a sentence that says an order was placed, filled or confirmed. */
export const SPOKEN_NO_EXECUTION_NOTICE =
  "I can't place, change or confirm orders by voice, and nothing was executed. Use the Trade Action Center to review and confirm a trade.";

/** Minimum normalised length for a sentence to be matched against already-verified text. */
const MIN_TRUSTED_MATCH_CHARS = 12;

const VERIFIER_MARKUP: readonly string[] = [
  UNVERIFIED_MARK.trim(),
  VERIFIER_FAILED_NOTICE,
  ...Object.values(VERIFIER_NOTICES),
  "ARX verifier:",
];

/** Lower-case, strip markdown/list markers and collapse whitespace. */
export function normalizeForSpeechMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, " ")
    .replace(/[`*_#>|~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type SpeechSegmentVerdict = "spoken_checked" | "spoken_trusted" | "withheld_claim" | "withheld_execution" | "withheld_markup";

export interface SpeechSegment {
  original: string;
  verdict: SpeechSegmentVerdict;
  findings: Finding[];
}

export interface SpeechGateInput {
  text: string;
  /** This turn's tool outputs. Voice has no tools, so usually []. */
  outputs?: ToolOutput[];
  /** What the user said/typed this turn (echoing their own figures is allowed). */
  userText?: string;
  /** Text the ARX text verifier already released to this user. */
  trusted?: readonly string[];
}

export interface SpeechGateResult {
  /** What may be read aloud. */
  speech: string;
  findings: Finding[];
  segments: SpeechSegment[];
  /** Number of sentences not read aloud. */
  withheld: number;
  /** True when every sentence is read aloud unchanged. */
  clean: boolean;
}

function hasVerifierMarkup(seg: string): boolean {
  return VERIFIER_MARKUP.some((m) => seg.includes(m));
}

export function gateSpeech(input: SpeechGateInput): SpeechGateResult {
  const idx = buildEvidenceIndex(input.outputs ?? [], input.userText ?? "");
  const trusted = (input.trusted ?? []).flatMap(t => splitSegments(t).map(s => normalizeForSpeechMatch(s.text))).filter((t) => t.length > 0);
  const segments: SpeechSegment[] = [];
  const findings: Finding[] = [];
  const out: string[] = [];
  let pendingNotice: string | null = null;
  const flushNotice = () => {
    if (pendingNotice) out.push(pendingNotice);
    pendingNotice = null;
  };

  // A verifier notice ends in ".]", which the sentence splitter does not treat
  // as a boundary; break after it so the next sentence is judged on its own.
  const text = input.text.replace(/(\[(?:Removed by the ARX verifier|Withheld:)[^\]]*\])[ \t]*/g, "$1\n");
  for (const seg of splitSegments(text)) {
    const raw = seg.text;
    if (!raw.trim()) { out.push(raw); continue; }
    if (hasVerifierMarkup(raw)) {
      segments.push({ original: raw, verdict: "withheld_markup", findings: [] });
      pendingNotice ??= SPOKEN_WITHHELD_NOTICE;
      continue;
    }
    const norm = normalizeForSpeechMatch(raw);
    if (norm.length >= MIN_TRUSTED_MATCH_CHARS && trusted.some((t) => t === norm)) {
      flushNotice();
      segments.push({ original: raw, verdict: "spoken_trusted", findings: [] });
      out.push(raw);
      continue;
    }
    let segFindings: Finding[];
    try {
      segFindings = checkSegment(seg, idx).findings;
    } catch {
      // Fail closed: a sentence the checker cannot check is not read aloud.
      segments.push({ original: raw, verdict: "withheld_claim", findings: [] });
      pendingNotice ??= SPOKEN_WITHHELD_NOTICE;
      continue;
    }
    if (segFindings.length === 0) {
      flushNotice();
      segments.push({ original: raw, verdict: "spoken_checked", findings: [] });
      out.push(raw);
      continue;
    }
    findings.push(...segFindings);
    const execution = segFindings.some((f) => f.kind === "EXECUTION_UNCONFIRMED");
    segments.push({ original: raw, verdict: execution ? "withheld_execution" : "withheld_claim", findings: segFindings });
    // The execution notice wins over the generic one within a run.
    if (execution) pendingNotice = SPOKEN_NO_EXECUTION_NOTICE;
    else pendingNotice ??= SPOKEN_WITHHELD_NOTICE;
  }
  flushNotice();

  const withheld = segments.filter((s) => s.verdict.startsWith("withheld")).length;
  const speech = out.map((s) => s.trim()).filter(Boolean).join(" ");
  return { speech, findings, segments, withheld, clean: withheld === 0 };
}

export interface VoiceTurnGateResult {
  /** The text shown in the chat bubble (text-verifier form, with marks/notices). */
  display: string;
  /** The text that may be read aloud. */
  speech: string;
  /** True when the model's own audio may be played unchanged. */
  audioMayPlay: boolean;
  findings: Finding[];
  withheld: number;
}

/**
 * Gate one complete spoken model turn (gpt-audio or realtime). Voice runs no
 * tools, so the evidence is the user's own words only: any figure, ticket, time,
 * execution or probability claim the model adds is withheld from speech and
 * marked/removed in the displayed text exactly as the text verifier does.
 */
export function gateVoiceTurn(rawTranscript: string, userText: string, outputs: ToolOutput[] = []): VoiceTurnGateResult {
  const shown = verifyAnswer(rawTranscript, outputs, userText);
  const spoken = gateSpeech({ text: rawTranscript, outputs, userText });
  return {
    display: shown.text,
    speech: spoken.speech,
    audioMayPlay: spoken.clean && !shown.failedClosed && shown.findings.length === 0,
    findings: spoken.findings,
    withheld: spoken.withheld,
  };
}
