/** Versioned synchronous CTrade evidence; no broker-history/deal aggregation. */
export type TerminalOutcome = "LIVE_FILLED" | "LIVE_PARTIALLY_FILLED" | "LIVE_ACKNOWLEDGED" | "LIVE_UNKNOWN" | "LIVE_REJECTED";
export type TerminalResultEvidence = Record<string, string | number | boolean | null>;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const positive = (n: unknown): n is number => finite(n) && n > 0;
const ticket = (n: unknown): n is string => typeof n === "string" && /^[1-9]\d{0,19}$/.test(n) && BigInt(n) <= 18446744073709551615n;
const definiteReject = (c: number) => [10004,10006,10007,10026,10027,10030,10032,10033,10034,10035,10038].includes(c) || (c>=10013&&c<=10022) || (c>=10040&&c<=10046);
// Exactly the market-entry actions v154 dispatches to HandleOpenMarket, plus the
// authoritative live type. Pending/bulk/reverse actions stay outside this guarantee.
export const TERMINAL_ENTRY_COMMAND_TYPES: readonly string[] = ["PLACE_LIVE_MARKET_ORDER","OPEN_MARKET","PLACE_MARKET_ORDER","DEMO_MARKET_ORDER"];
export function terminalResultKind(commandType: string): "ENTRY" | "CLOSE" | "MODIFY" | null {
  return TERMINAL_ENTRY_COMMAND_TYPES.includes(commandType) ? "ENTRY" :
    ["CLOSE_LIVE_POSITION","CLOSE_POSITION"].includes(commandType) ? "CLOSE" :
    ["MODIFY_LIVE_SLTP","MODIFY_POSITION","MODIFY_POSITION_PROTECTION","MOVE_SL","MOVE_TP"].includes(commandType) ? "MODIFY" : null;
}
export function normalizeTerminalResultEvidence(raw: Record<string, unknown>, commandType: string, requestedVolume: number | null, expectedPositionTicket?: string | null) {
  if (!Object.hasOwn(raw,"resultEvidenceVersion")) return null; // explicit legacy compatibility, not certification
  const kind=terminalResultKind(commandType), code=raw.mt5Retcode, actual=raw.resultVolume, price=raw.resultPrice;
  // Fixed primitive allowlist: never persist arbitrary result payloads/secrets here.
  const evidence: TerminalResultEvidence = {};
  for(const key of ["resultEvidenceVersion","resultKind","tradeCallSucceeded","resultDeal","resultOrder","resultVolume","resultPrice","requestedVolume","mt5Retcode","positionTicket","mt5PositionTicket"]){
    const value=raw[key];evidence[key]=typeof value==="string"?value.slice(0,80):typeof value==="boolean"?value:finite(value)?value:null;
  }
  evidence.volumeBasis="SYNCHRONOUS_REQUEST_RESULT";
  let outcome:TerminalOutcome="LIVE_UNKNOWN";
  if(raw.resultEvidenceVersion===1 && kind && raw.resultKind===kind && finite(code) && Number.isInteger(code)){
    if(definiteReject(code)) {
      if(raw.resultDeal==="0" && actual===0)outcome="LIVE_REJECTED";
    } else if(raw.tradeCallSucceeded===true){
      if(code===10008 && raw.resultDeal==="0")outcome="LIVE_ACKNOWLEDGED";
      else if(kind==="MODIFY" && code===10009 && raw.resultDeal==="0" && actual===0)outcome="LIVE_FILLED";
      else if(kind!=="MODIFY" && [10009,10010].includes(code) && ticket(raw.resultDeal) && (kind!=="ENTRY" || ticket(raw.resultOrder)) && positive(requestedVolume) && raw.requestedVolume===requestedVolume && positive(actual) && actual<=requestedVolume && positive(price))outcome=code===10010||actual<requestedVolume?"LIVE_PARTIALLY_FILLED":"LIVE_FILLED";
    }
  }
  const positions=[raw.positionTicket,raw.mt5PositionTicket].filter(v=>v!==undefined && v!=="0");
  const brokerTicket=kind==="ENTRY"?raw.resultOrder:positions[0];
  if (["LIVE_FILLED","LIVE_PARTIALLY_FILLED"].includes(outcome) && (!ticket(brokerTicket) ||
      (kind!=="ENTRY" && (positions.some(v=>v!==brokerTicket) || (expectedPositionTicket!=null && brokerTicket!==expectedPositionTicket))))) outcome="LIVE_UNKNOWN";
  const filled=kind!=="MODIFY" && ["LIVE_FILLED","LIVE_PARTIALLY_FILLED"].includes(outcome);
  return {outcome,brokerTicket:ticket(brokerTicket)?brokerTicket:null,executedVolume:filled?actual as number:null,fillPrice:filled?price as number:null,evidence};
}
