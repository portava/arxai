import { resolveArxMarket } from "@workspace/domain/market";

/** An ATI canonical synthetic may appear in MT5 under an exact catalog name.
 * An explicitly requested native symbol stays exact, including broker suffixes. */
export function atiBrokerNames(symbol: string) {
  const market = resolveArxMarket(symbol);
  return market?.category === "synthetic" && market.canonicalSymbol === symbol
    ? [...new Set([symbol, ...market.mt5Aliases])] : [symbol];
}

/** A saved broker mapping cannot override a known difference in instrument identity. */
export function atiInstrumentConflict(requested: string, broker: unknown) {
  if (typeof broker !== "string") return false;
  const market = resolveArxMarket(requested), native = resolveArxMarket(broker);
  return market != null && native != null && market.canonicalSymbol !== native.canonicalSymbol;
}
