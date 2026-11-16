import { drawingSegments, type ChartDrawing } from "./chartWorkspace";
import { fibonacciProposalDrawing, type ChartFibonacciProposal } from "./chartAutoFibonacci";
import { chartNumber } from "./chartDescriptiveStats";
import { formatSourceChartTime } from "./chartClockEvidence";

// Neither a proposal nor archived drawing stores qualified original UTC
// evidence. Do not borrow today's chart authority for these source anchors.
const time=(seconds:number)=>{const date=new Date(seconds*1000);return Number.isFinite(date.getTime())?formatSourceChartTime(seconds,false,"UTC",{seconds:true}):"unavailable timestamp";};
function geometry(drawing:ChartDrawing):string {
  const start=drawing.start,end=drawing.end!;
  return `The range ${end.price>start.price?"rises":end.price<start.price?"falls":"is flat"} from ${chartNumber(start.price)} at ${time(start.time)} to ${chartNumber(end.price)} at ${time(end.time)}. 0% is the first anchor and 100% is the second. ${drawingSegments(drawing).map(level=>`${level.label.replace("Fib ","")}: ${chartNumber(level.start.price)}`).join("; ")}. Prices use the chart reader’s rounded display formatting. These are measured distances between the anchors, not reversal probabilities or price targets.`;
}
export function explainFibonacciProposal(proposal:ChartFibonacciProposal,state:"prepared"|"shown"|"hidden"):string {
  const p=proposal.origin;
  return `${state==="prepared"?"Prepared an unaccepted Fibonacci preview":state==="hidden"?"The current unaccepted Fibonacci preview is hidden":"The current unaccepted Fibonacci preview is applied"} on the selected ${p.symbol} ${p.timeframe} chart. ${state==="prepared"?"The preview has been requested; this reply does not confirm that it is visible yet. ":""}${geometry(fibonacciProposalDrawing(proposal,"explanation-only",true))} The selected pivots were confirmed by two observed closed bars on each side, with the later confirmation at ${time(p.confirmedAt)}. Source: ${p.source}; source identity ${p.sourceIdentity}. Window: ${time(p.windowFrom)} to ${time(p.windowTo)} (${p.closedBars} closed bars). ${proposal.note} Source OHLC is used even when display candles are transformed. Time labels preserve chart source coordinates; this tool does not independently establish their UTC clock provenance. Use Keep and edit Fibonacci to save your own editable drawing, or dismiss it. Nothing was saved or traded. This is a local receipt at request time; refresh the explanation after the chart changes.`;
}
export function explainSelectedFibonacci(drawing:ChartDrawing,symbol:string,timeframe:string):string {
  const origin=drawing.fibonacciOrigin;
  return `Selected manual Fibonacci drawing on the selected ${symbol} ${timeframe} chart${drawing.hidden?" (hidden)":""}. Its current editable anchors are your annotation, not an automatic current-market finding. ${geometry(drawing)} ${origin?`Its archived automatic proposal originally used ${chartNumber(origin.start.price)} at ${time(origin.start.time)} and ${chartNumber(origin.end.price)} at ${time(origin.end.time)}, confirmed ${time(origin.confirmedAt)}, source ${origin.source}, identity ${origin.sourceIdentity}. That archived source is not revalidated as current advice.`:"No automatic source provenance is attached to this manual drawing."} No anchors were changed, saved or traded by this explanation. Time labels preserve chart source coordinates, not independently proven UTC provenance. This local receipt describes the selection at request time.`;
}
