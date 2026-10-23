// Convert a captured evidence artifact into faithful test fixtures.
//
// The point is that nobody retypes a venue response by hand. Every fixture
// infidelity found in this workstream came from a human inventing a shape:
// a `sold` key Deriv does not send, an error frame delivered as a reply, a
// plain Error where the transport throws a typed one. A generated fixture
// carries the venue's actual bytes.
//
// FAIL CLOSED: an artifact this generator does not understand, or one whose
// frames are unreadable, produces NOTHING rather than a plausible guess. A
// wrong fixture is worse than a missing one — it certifies the wrong shape.

import { EvidenceRefusal, type EvidenceArtifact, type EvidenceProbe } from "./liveEvidence.js";

export interface GeneratedFixture {
  /** Probe this came from, so a reviewer can trace it back. */
  probe: string;
  /** How the real transport would deliver this to a caller. */
  delivery: "reply" | "throw";
  /** The venue's own reply body, verbatim from the recorded frame. */
  body: Record<string, unknown> | null;
  /** For a throw: the code the transport would build. */
  arxErrorCode: string | null;
  derivErrorCode: string | null;
  /** TypeScript source for the fixture, ready to paste into faultInjection.ts. */
  source: string;
}

/**
 * Which frame is the venue's answer to this probe?
 *
 * Correlated by the req_id ARX ISSUED, never by position or recency. Two
 * probes in flight together would otherwise be attributable to each other.
 */
function replyFrameFor(probe: EvidenceProbe): Record<string, unknown> | null {
  const out = probe.frames.find((f) => f.direction === "out");
  if (!out || out.reqId === null) return null;
  const inbound = probe.frames.find((f) => f.direction === "in" && f.reqId === out.reqId);
  if (!inbound) return null;
  try {
    const parsed = JSON.parse(inbound.raw) as unknown;
    return (parsed && typeof parsed === "object") ? parsed as Record<string, unknown> : null;
  } catch {
    // An unparseable frame is real evidence, but it is not a fixture body.
    return null;
  }
}

/**
 * Generate fixtures from an artifact.
 *
 * Refuses an artifact version it does not understand: a generator that guesses
 * at an unfamiliar format produces fixtures nobody can trust.
 */
export function generateFixtures(artifact: EvidenceArtifact): GeneratedFixture[] {
  if (artifact.artifactVersion !== 1) {
    throw new EvidenceRefusal(
      `unsupported evidence artifact version ${String(artifact.artifactVersion)}; refusing to guess`,
    );
  }
  const out: GeneratedFixture[] = [];
  for (const probe of artifact.probes) {
    // Only outcomes the venue actually adjudicated become fixtures. An UNKNOWN
    // has no venue shape to preserve, and inventing one would defeat the
    // purpose of generating from evidence.
    if (probe.outcome !== "VENUE_REPLY" && probe.outcome !== "VENUE_REJECTION") continue;
    const body = replyFrameFor(probe);
    if (body === null) continue;

    if (probe.outcome === "VENUE_REJECTION") {
      // The transport converts a venue error frame into a THROW. A fixture
      // that delivered it as a reply would exercise the wrong path — the
      // exact infidelity that let a suite pass while testing nothing.
      out.push({
        probe: probe.name, delivery: "throw", body,
        arxErrorCode: probe.arxErrorCode, derivErrorCode: probe.derivErrorCode,
        source: `  /** Captured from probe ${JSON.stringify(probe.name)}. */\n`
          + `  ${toIdent(probe.name)}: (): Reaction => ({\n`
          + `    kind: "throw",\n`
          + `    error: new DerivNewApiError(${JSON.stringify(probe.arxErrorCode ?? "DERIV_NEW_API_REQUEST_REJECTED")}, {\n`
          + `      derivCode: ${JSON.stringify(probe.derivErrorCode)},\n`
          + `      wireWritten: ${JSON.stringify(probe.wireWritten)},\n`
          + `    }),\n  }),`,
      });
      continue;
    }
    out.push({
      probe: probe.name, delivery: "reply", body,
      arxErrorCode: null, derivErrorCode: null,
      source: `  /** Captured from probe ${JSON.stringify(probe.name)}. */\n`
        + `  ${toIdent(probe.name)}: () => reply(${JSON.stringify(stripEnvelope(body))}),`,
    });
  }
  return out;
}

/** `req_id` is ARX's correlation field, not part of the venue's shape. */
function stripEnvelope(body: Record<string, unknown>): Record<string, unknown> {
  const { req_id: _reqId, echo_req: _echo, ...rest } = body;
  return rest;
}

function toIdent(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+(.)/g, (_m, c: string) => c.toUpperCase());
}

/** Render a paste-ready block, with provenance so a reviewer can trace every
 *  fixture back to the run that produced it. */
export function renderFixtureModule(artifact: EvidenceArtifact, fixtures: GeneratedFixture[]): string {
  return [
    "// GENERATED from a live evidence capture. Do not hand-edit shapes here —",
    "// regenerate instead, or the fixture stops matching the venue.",
    `// tier=${artifact.tier} account=…${artifact.accountSuffix ?? "?"} `
      + `capturedAtMs=${artifact.capturedAtMs} probes=${artifact.probes.length}`,
    "export const CAPTURED = {",
    ...fixtures.map((f) => f.source),
    "} as const;",
    "",
  ].join("\n");
}
