import {
  decorateOpportunitiesWithFinalRead, decorateOpportunitiesWithFvgRead,
  decorateOpportunitiesWithHistory, decorateOpportunitiesWithNewsRisk,
  decorateOpportunitiesWithTimingContext, rankScannerOpportunities, type ScannerOpportunity,
} from "./marketScanner.js";

/** The final market read shared by the Scanner cards and Profit Mission. */
export async function reviewScannerOpportunities(rows: ScannerOpportunity[]) {
  const history = await decorateOpportunitiesWithHistory(rows);
  const news = await decorateOpportunitiesWithNewsRisk(history);
  const timing = await decorateOpportunitiesWithTimingContext(news);
  const fvg = await decorateOpportunitiesWithFvgRead(timing);
  return decorateOpportunitiesWithFinalRead(rankScannerOpportunities(fvg));
}
