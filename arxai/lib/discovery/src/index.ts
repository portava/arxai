// @workspace/discovery — pre-registered hypothesis testing with family-wide
// false-discovery control, terminating in an INERT candidate.
//
// The pipeline can propose. It cannot promote: its terminal artefact is a
// `learning_model_versions` row at the DATA/WALK_FORWARD stage with
// liveAllowed=false, shadowValidated=false, adminApproved=false, and there is no
// code path here that sets any of them. Reaching live still requires the human
// SHADOW and ADMIN stages that already exist.
//
// Imports `node:crypto` and nothing else — not `lib/risk` (shadow size is
// injected precisely so it can never be confused with live size), not
// `@workspace/db`, and nothing on the order path.

export * from "./fdr.js";
export * from "./pipeline.js";
