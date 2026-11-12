interface BuildIdentity {
  revision: string | null;
  sourceState: "clean" | "modified" | "unknown";
}
declare const __ARX_BUILD_IDENTITY__: BuildIdentity | undefined;

/** Describes source embedded by our bundler; not a signed release attestation. */
export function getBuildIdentity(): BuildIdentity {
  return typeof __ARX_BUILD_IDENTITY__ === "undefined"
    ? { revision: null, sourceState: "unknown" }
    : { ...__ARX_BUILD_IDENTITY__ };
}
