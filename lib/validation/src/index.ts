// @workspace/validation — the null-calibrated validation factory.
//
// Turns the Deriv synthetics into a validation ORACLE with a measured
// false-discovery rate. Those instruments are GENERATED as driftless geometric
// Brownian motion, so a directional edge on them is impossible by construction —
// which means a factory that certifies one has demonstrated that it certifies
// noise. That is the calibration nothing on real market data can provide.
//
// Additive and standalone: nothing here places, sizes, or authorises a trade,
// and nothing imports the dispatch/gate path.

export * from "./stats.js";
export * from "./nullOracle.js";
export * from "./cpcv.js";
export * from "./deflatedSharpe.js";
export * from "./pbo.js";
export * from "./strategyFamilies.js";
export * from "./factory.js";
export * from "./conformal.js";
