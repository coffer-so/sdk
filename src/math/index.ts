export * from "./fixedPoint";
export * from "./logExp";
export * from "./cubicMath";
export * from "./weightedMath";
export * from "./singleToken";
export * from "./slippage";
export * from "./maxSelloff";
export * from "./lpLoss";
// NOTE: "./surgeFee" is deliberately NOT star-exported — its
// calcSurgeFeePct/calcSurgeFeeAmount would shadow the same-named maxSelloff
// exports (an ambiguous star re-export silently drops the name, breaking
// existing consumers). The quote engine imports it by path; only the
// SurgeCurve type is re-exported from the package root.
