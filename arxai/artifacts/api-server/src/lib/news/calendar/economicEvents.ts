export interface EconomicEvent {
  id: string;
  title: string;
  country: string;
  currency: string;
  impact: "low" | "medium" | "high";
  actual: string | null;
  forecast: string | null;
  previous: string | null;
  eventTime: string;
  affectedMarkets: string[];
  source: string;
}

const TEMPLATES: Array<Omit<EconomicEvent, "id" | "eventTime" | "actual"> & { hourOffsetFromMidnightUTC: number }> = [
  { title: "FOMC Rate Decision",    country: "US", currency: "USD", impact: "high",   forecast: "5.25%", previous: "5.25%", affectedMarkets: ["EURUSD","GBPUSD","USDJPY","US30","NAS100","SPX500"], source: "Mock", hourOffsetFromMidnightUTC: 18 },
  { title: "US CPI YoY",            country: "US", currency: "USD", impact: "high",   forecast: "3.2%",  previous: "3.4%",  affectedMarkets: ["EURUSD","GBPUSD","USDJPY","US30","NAS100"],         source: "Mock", hourOffsetFromMidnightUTC: 12 },
  { title: "US Non-Farm Payrolls",  country: "US", currency: "USD", impact: "high",   forecast: "175k",  previous: "150k",  affectedMarkets: ["EURUSD","GBPUSD","USDJPY","US30","NAS100"],         source: "Mock", hourOffsetFromMidnightUTC: 12 },
  { title: "Fed Chair Speech",      country: "US", currency: "USD", impact: "medium", forecast: null,    previous: null,    affectedMarkets: ["EURUSD","USDJPY","US30","NAS100"],                  source: "Mock", hourOffsetFromMidnightUTC: 14 },
  { title: "US Unemployment Rate",  country: "US", currency: "USD", impact: "medium", forecast: "3.8%",  previous: "3.9%",  affectedMarkets: ["EURUSD","USDJPY"],                                  source: "Mock", hourOffsetFromMidnightUTC: 12 },
  { title: "US GDP QoQ",            country: "US", currency: "USD", impact: "high",   forecast: "2.1%",  previous: "1.6%",  affectedMarkets: ["EURUSD","USDJPY","US30","NAS100"],                  source: "Mock", hourOffsetFromMidnightUTC: 12 },
  { title: "US Retail Sales MoM",   country: "US", currency: "USD", impact: "medium", forecast: "0.4%",  previous: "0.7%",  affectedMarkets: ["US30","NAS100","EURUSD"],                          source: "Mock", hourOffsetFromMidnightUTC: 12 },
  { title: "ECB Rate Decision",     country: "EU", currency: "EUR", impact: "high",   forecast: "4.25%", previous: "4.25%", affectedMarkets: ["EURUSD","EURJPY"],                                   source: "Mock", hourOffsetFromMidnightUTC: 12 },
  { title: "BoE Rate Decision",     country: "UK", currency: "GBP", impact: "high",   forecast: "5.00%", previous: "5.00%", affectedMarkets: ["GBPUSD","GBPJPY"],                                   source: "Mock", hourOffsetFromMidnightUTC: 11 },
  { title: "BoJ Policy Statement",  country: "JP", currency: "JPY", impact: "high",   forecast: "0.10%", previous: "0.10%", affectedMarkets: ["USDJPY","EURJPY","GBPJPY"],                          source: "Mock", hourOffsetFromMidnightUTC: 3 },
  { title: "AAPL Earnings",         country: "US", currency: "USD", impact: "high",   forecast: "$1.51", previous: "$1.46", affectedMarkets: ["AAPL"],                                              source: "Mock", hourOffsetFromMidnightUTC: 21 },
  { title: "TSLA Earnings",         country: "US", currency: "USD", impact: "high",   forecast: "$0.62", previous: "$0.85", affectedMarkets: ["TSLA"],                                              source: "Mock", hourOffsetFromMidnightUTC: 21 },
];

export function getMockEvents(daysAhead = 7): EconomicEvent[] {
  const out: EconomicEvent[] = [];
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);

  for (let day = 0; day < daysAhead; day++) {
    // Pick a deterministic subset per day so it doesn't flicker
    const subset = TEMPLATES.filter((_, i) => (i + day) % 3 !== 2);
    for (const t of subset) {
      const eventDate = new Date(todayUtc.getTime() + day * 86400000);
      eventDate.setUTCHours(t.hourOffsetFromMidnightUTC, 30, 0, 0);
      const isPast = eventDate.getTime() < Date.now();
      out.push({
        id: `${t.title.replace(/\s+/g, "_")}_${eventDate.toISOString().slice(0, 10)}`,
        title: t.title,
        country: t.country,
        currency: t.currency,
        impact: t.impact,
        forecast: t.forecast,
        previous: t.previous,
        actual: isPast ? t.forecast : null,
        eventTime: eventDate.toISOString(),
        affectedMarkets: t.affectedMarkets,
        source: t.source,
      });
    }
  }
  return out.sort((a, b) => a.eventTime.localeCompare(b.eventTime));
}
