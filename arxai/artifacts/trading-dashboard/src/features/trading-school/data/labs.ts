/**
 * Trading School — Practice Lab content.
 *
 * PURE static data. Every price series here is MADE-UP PRACTICE DATA drawn to
 * teach one idea; none of it is live or historical market data, and the UI
 * labels it that way. No network, no randomness: the same lab always shows
 * the same scenarios so grading is reproducible.
 */
import type { Direction, PlacementScenarioRules, TargetZone } from "../lib/labMath";

/** One candle: [open, high, low, close]. */
export type Candle = readonly [number, number, number, number];

export interface LowerPane {
  label: string;
  values: number[];
  min: number;
  max: number;
  /** horizontal guide lines, e.g. 30 / 70 */
  levels?: number[];
}

export interface ScenarioChart {
  candles: Candle[];
  /** candle indices to highlight */
  highlight?: number[];
  /** overlay a simple moving average of closes with this period */
  smaPeriod?: number;
  lowerPane?: LowerPane;
  levels?: { price: number; label: string }[];
}

export interface LabScenario {
  id: string;
  prompt: string;
  chart?: ScenarioChart;
  options: string[];
  answerIndex: number;
  explanation: string;
}

export interface ScenarioLab {
  labId: string;
  intro: string;
  scenarios: LabScenario[];
}

/**
 * Build candles deterministically from a static list of closes: each candle
 * opens at the previous close and gets a fixed wick on both ends.
 */
export function candlesFromCloses(closes: number[], wick = 0.25, firstOpen?: number): Candle[] {
  let open = firstOpen ?? closes[0];
  return closes.map((c) => {
    const o = open;
    open = c;
    const r = (n: number) => Math.round(n * 100) / 100;
    return [r(o), r(Math.max(o, c) + wick), r(Math.min(o, c) - wick), r(c)] as const;
  });
}

/* ------------------------------------------------------------------ */
/* Market Basics                                                       */
/* ------------------------------------------------------------------ */

const MARKET_BASICS: ScenarioLab = {
  labId: "lab-market-basics",
  intro: "Read who is pushing harder — buyers or sellers — from simple practice charts and quotes.",
  scenarios: [
    {
      id: "mb1",
      prompt: "Each candle closes higher and each dip stops above the last one. Who is in control?",
      chart: { candles: [[100, 101.2, 99.8, 101], [101, 102, 100.6, 101.8], [101.8, 102.4, 101.2, 101.5], [101.5, 103, 101.4, 102.8], [102.8, 103.6, 102.3, 103.4], [103.4, 103.8, 102.9, 103.1], [103.1, 104.6, 103, 104.4], [104.4, 105.2, 104, 105]] },
      options: ["Buyers", "Sellers", "Nobody — it's random", "The broker"],
      answerIndex: 0,
      explanation: "Higher highs and higher lows mean buyers keep paying more and stepping in earlier on dips. That is buyer pressure.",
    },
    {
      id: "mb2",
      prompt: "Price pokes up to about 105 three times and gets pushed back down each time (long upper wicks). What does that suggest?",
      chart: {
        candles: [[102, 103, 101.8, 102.8], [102.8, 105.2, 102.6, 103.2], [103.2, 103.6, 102.4, 102.7], [102.7, 104, 102.5, 103.8], [103.8, 105.1, 103.5, 103.9], [103.9, 104.2, 103, 103.2], [103.2, 104.4, 103, 104.2], [104.2, 105.2, 104, 104.3]],
        highlight: [1, 4, 7],
        levels: [{ price: 105, label: "105" }],
      },
      options: ["Buyers are unstoppable", "Sellers are defending the 105 area", "Price will break 105 for sure", "There is no information here"],
      answerIndex: 1,
      explanation: "Long upper wicks show price went up but could not stay there — sellers pushed it back. Repeated rejections at one level mean sellers are active there (for now).",
    },
    {
      id: "mb3",
      prompt: "A quote shows bid 1.1000 and ask 1.1002. You press Buy at market. Which price do you get (before slippage)?",
      options: ["1.1000 (the bid)", "1.1002 (the ask)", "1.1001 (the middle)", "Whatever you type in"],
      answerIndex: 1,
      explanation: "You buy from sellers at the ask and sell to buyers at the bid. A market buy fills at the ask.",
    },
    {
      id: "mb4",
      prompt: "Same quote: bid 1.1000, ask 1.1002. How big is the spread on this EUR/USD-style pair?",
      options: ["0.2 pips", "2 pips", "20 pips", "There is no spread"],
      answerIndex: 1,
      explanation: "For most FX pairs one pip is 0.0001. 1.1002 − 1.1000 = 0.0002, which is 2 pips. That is the cost you start every trade with.",
    },
    {
      id: "mb5",
      prompt: "Price chops between about 99.5 and 101 with no clear higher highs or lower lows. Best description?",
      chart: { candles: [[100, 100.8, 99.6, 100.5], [100.5, 100.9, 99.7, 99.9], [99.9, 100.7, 99.5, 100.6], [100.6, 100.9, 99.8, 100], [100, 100.8, 99.6, 100.4], [100.4, 100.9, 99.7, 99.8], [99.8, 100.6, 99.5, 100.3], [100.3, 100.8, 99.7, 100.1]] },
      options: ["Strong uptrend", "Strong downtrend", "Balance — neither side is in control", "A crash is starting"],
      answerIndex: 2,
      explanation: "Overlapping candles inside a box mean buyers and sellers are roughly matched. Many traders wait for a break out of the range instead of guessing.",
    },
    {
      id: "mb6",
      prompt: "After a quiet stretch, one large candle drops and closes right at its low. What happened in that candle?",
      chart: { candles: [[104, 104.4, 103.6, 104.1], [104.1, 104.5, 103.8, 104.2], [104.2, 104.6, 103.9, 104], [104, 104.3, 103.7, 104.1], [104.1, 104.2, 101.2, 101.3]], highlight: [4] },
      options: ["Sellers took control into the close", "Buyers won the candle", "Nothing — size doesn't matter", "The market closed early"],
      answerIndex: 0,
      explanation: "A big body closing at the low means sellers pushed the whole period and buyers could not bring it back. It shows strong seller pressure — not a guarantee of what comes next.",
    },
  ],
};

/* ------------------------------------------------------------------ */
/* Products                                                            */
/* ------------------------------------------------------------------ */

const PRODUCTS: ScenarioLab = {
  labId: "lab-products",
  intro: "Match markets to how they usually behave and when they are most active. General patterns, not rules.",
  scenarios: [
    {
      id: "pr1",
      prompt: "When is EUR/USD usually most active, with the tightest spreads?",
      options: ["Weekends", "The London / New York overlap", "Only at midnight UTC", "It is the same all day"],
      answerIndex: 1,
      explanation: "Both European and US participants are trading during the overlap, so volume is high and spreads are usually tight.",
    },
    {
      id: "pr2",
      prompt: "Gold (XAU/USD) often makes big moves around…",
      options: ["US dollar and interest-rate news", "Football results", "Nothing — gold never moves", "Only crypto news"],
      answerIndex: 0,
      explanation: "Gold is priced in dollars and is sensitive to rates and risk mood, so USD data and central-bank news often move it sharply.",
    },
    {
      id: "pr3",
      prompt: "A US stock index like the S&P 500 is usually busiest during…",
      options: ["The Tokyo session", "The New York cash session", "Sunday evening", "It never trades"],
      answerIndex: 1,
      explanation: "US indices see most of their volume while US stock exchanges are open.",
    },
    {
      id: "pr4",
      prompt: "Which of these markets typically trades 24/7, including weekends?",
      options: ["EUR/USD", "Bitcoin", "The S&P 500 cash index", "Gold futures"],
      answerIndex: 1,
      explanation: "Major crypto markets run around the clock. FX and indices close for the weekend, which can leave gaps on Monday.",
    },
    {
      id: "pr5",
      prompt: "A yen pair like USD/JPY often wakes up first during…",
      options: ["The Asian / Tokyo session", "Only the New York close", "Weekends", "Never"],
      answerIndex: 0,
      explanation: "Japanese participants are active in the Asian session, so yen pairs tend to see earlier activity than many other pairs.",
    },
    {
      id: "pr6",
      prompt: "Which usually swings the most in percentage terms on a normal day?",
      options: ["A major FX pair like EUR/USD", "A small, thinly traded crypto coin", "They always move the same", "A savings account"],
      answerIndex: 1,
      explanation: "Smaller, thinner markets can move many percent in a day; major FX pairs usually move far less. Bigger swings mean you need smaller size for the same risk.",
    },
  ],
};

/* ------------------------------------------------------------------ */
/* Candle Reading                                                      */
/* ------------------------------------------------------------------ */

const CANDLE_READING: ScenarioLab = {
  labId: "lab-candle-reading",
  intro: "Identify bullish, bearish, rejection and indecision candles. The highlighted candle is the one to read.",
  scenarios: [
    {
      id: "cr1",
      prompt: "What kind of candle is highlighted?",
      chart: { candles: [[100.4, 100.7, 100, 100.2], [100.2, 100.5, 99.8, 100], [100, 102.4, 99.9, 102.3]], highlight: [2] },
      options: ["Bullish — closed well above its open", "Bearish — closed below its open", "Doji — open equals close", "Not a candle"],
      answerIndex: 0,
      explanation: "A tall body that closes near the high, above the open, is a bullish candle: buyers won that period.",
    },
    {
      id: "cr2",
      prompt: "After a drop, this candle has a tiny body and a long lower wick. What does it show?",
      chart: { candles: [[104, 104.2, 103, 103.2], [103.2, 103.4, 102.2, 102.4], [102.4, 102.6, 101.4, 101.6], [101.6, 101.9, 99.4, 101.7]], highlight: [3] },
      options: ["Sellers are fully in control", "Lower prices were rejected — buyers pushed back", "Indecision at the top", "Nothing useful"],
      answerIndex: 1,
      explanation: "Price went much lower but closed back near the top. That long lower wick is a rejection of lower prices — a possible sign sellers are tiring. It still needs confirmation.",
    },
    {
      id: "cr3",
      prompt: "At the top of a rise, this candle has a long upper wick and closes near its low. What is it telling you?",
      chart: { candles: [[100, 101, 99.8, 100.9], [100.9, 101.9, 100.7, 101.8], [101.8, 102.8, 101.6, 102.7], [102.7, 105, 102.5, 102.6]], highlight: [3] },
      options: ["Higher prices were rejected", "Buyers are getting stronger", "A guaranteed reversal", "It's a doji"],
      answerIndex: 0,
      explanation: "Buyers pushed to 105 but could not hold it; sellers drove it back down. A long upper wick near a high is a bearish rejection — a warning, not a certainty.",
    },
    {
      id: "cr4",
      prompt: "Open and close are almost the same, with wicks on both sides. What is this?",
      chart: { candles: [[100, 101, 99.8, 100.9], [100.9, 102, 100.8, 102], [102, 103, 101, 102.02]], highlight: [2] },
      options: ["Strong bullish candle", "Strong bearish candle", "Doji — indecision", "A gap"],
      answerIndex: 2,
      explanation: "When open ≈ close, neither side won. A doji shows indecision; what happens next matters more than the doji itself.",
    },
    {
      id: "cr5",
      prompt: "After three up candles, the highlighted candle opens above the last close and closes below the last open. Name it.",
      chart: { candles: [[100, 101, 99.8, 100.9], [100.9, 101.9, 100.7, 101.8], [101.8, 102.5, 101.6, 102.3], [102.5, 102.7, 101.2, 101.4]], highlight: [3] },
      options: ["Bullish engulfing", "Bearish engulfing", "Hammer", "Inside bar"],
      answerIndex: 1,
      explanation: "Its body fully covers the previous body and closes lower — sellers overwhelmed the last buyers. That is a bearish engulfing pattern.",
    },
    {
      id: "cr6",
      prompt: "A big up candle with almost no wicks at all. What does the lack of wicks mean?",
      chart: { candles: [[100.6, 100.9, 100.1, 100.3], [100.3, 100.6, 99.9, 100], [100, 102.05, 99.98, 102]], highlight: [2] },
      options: ["Buyers controlled the whole period", "Sellers controlled the whole period", "Nobody traded", "The candle is broken"],
      answerIndex: 0,
      explanation: "It opened near the low and closed near the high with no pullback. That is buyer control from start to finish (often called a marubozu).",
    },
  ],
};

/* ------------------------------------------------------------------ */
/* Indicators                                                          */
/* ------------------------------------------------------------------ */

const INDICATORS: ScenarioLab = {
  labId: "lab-indicators",
  intro: "See how a moving average and a momentum oscillator react to price. Indicators follow price — they don't predict it.",
  scenarios: [
    {
      id: "in1",
      prompt: "Price stays above a rising 5-period moving average (dashed line). Best read?",
      chart: { candles: candlesFromCloses([100, 100.6, 101.1, 100.9, 101.6, 102.2, 102, 102.8, 103.4, 103.2, 104, 104.6, 104.4, 105.2]), smaPeriod: 5 },
      options: ["Uptrend bias — the average supports buyers", "Downtrend — sell now", "The MA guarantees more upside", "The MA is meaningless"],
      answerIndex: 0,
      explanation: "Price above a rising average describes an uptrend. It is a bias that helps you choose direction — not a promise the trend continues.",
    },
    {
      id: "in2",
      prompt: "After a rise, price rolls over and closes below the moving average. What's a sensible reaction?",
      chart: { candles: candlesFromCloses([100, 101, 101.8, 102.5, 103, 103.4, 103.5, 103.2, 102.6, 101.9, 101.2, 100.6]), smaPeriod: 5 },
      options: ["It's a certain crash — sell everything", "The uptrend may be weakening; wait for structure to confirm", "Ignore it, nothing changed", "Buy more immediately"],
      answerIndex: 1,
      explanation: "A close below the average is an early warning. Many traders wait for a lower high or a broken level before treating it as a new downtrend.",
    },
    {
      id: "in3",
      prompt: "Price keeps climbing and the momentum oscillator (lower panel) sits above 70. What does that mean?",
      chart: {
        candles: candlesFromCloses([100, 100.8, 101.7, 102.5, 103.4, 104.1, 105, 105.6, 106.5, 107.2]),
        lowerPane: { label: "RSI (practice values)", values: [55, 60, 66, 71, 74, 76, 78, 77, 79, 80], min: 0, max: 100, levels: [30, 70] },
      },
      options: ["Overbought — you must sell now", "Momentum is strong; 'overbought' alone is not a sell signal", "The indicator is broken", "Price must fall back to 30"],
      answerIndex: 1,
      explanation: "In strong trends RSI can stay above 70 for a long time. It tells you momentum is strong, not that price has to turn.",
    },
    {
      id: "in4",
      prompt: "Price makes a higher high, but the oscillator makes a lower high. What is this called, and what does it hint?",
      chart: {
        candles: candlesFromCloses([100, 101.5, 103, 102, 101.2, 102.5, 103.8, 103.5]),
        lowerPane: { label: "RSI (practice values)", values: [50, 62, 74, 60, 52, 60, 66, 63], min: 0, max: 100, levels: [30, 70] },
        highlight: [2, 6],
      },
      options: ["Bearish divergence — momentum is fading", "Bullish confirmation", "A guaranteed reversal", "Nothing — they always disagree"],
      answerIndex: 0,
      explanation: "Price pushed higher with less momentum behind it. Divergence is a caution flag to protect profits or be pickier with new buys — not an automatic sell.",
    },
    {
      id: "in5",
      prompt: "The moving average is flat and price whips back and forth across it. How useful are MA crossover signals here?",
      chart: { candles: candlesFromCloses([100, 100.8, 99.9, 100.7, 100, 100.9, 99.8, 100.6, 100.1, 100.8, 99.9, 100.5]), smaPeriod: 5 },
      options: ["Very reliable", "Unreliable — this is a range, crossovers will whipsaw", "Only reliable on Fridays", "They predict the breakout"],
      answerIndex: 1,
      explanation: "Trend tools like moving averages give many false signals in a range. Recognising the range is the useful read.",
    },
    {
      id: "in6",
      prompt: "Your chart has RSI, Stochastic, MACD, CCI and a Momentum line all at once. What's the main problem?",
      options: ["None — more is always better", "They mostly measure the same thing, so you get clutter, not extra information", "You need at least ten", "Indicators replace a trade plan"],
      answerIndex: 1,
      explanation: "Most oscillators are built from the same prices and say similar things. One or two you understand well beat five that confuse you.",
    },
  ],
};

/* ------------------------------------------------------------------ */
/* Scalp Flame                                                         */
/* ------------------------------------------------------------------ */

const FLAME_CHART: Candle[] = [[100, 100.3, 99.8, 100.1], [100.1, 100.4, 99.9, 100.2], [100.2, 101.2, 100.15, 101.15], [101.15, 102.2, 101.1, 102.1], [102.1, 103.1, 102.05, 103.05]];

const SCALP_FLAME: ScenarioLab = {
  labId: "lab-scalp-flame",
  intro: "Practice spotting fast-momentum scalp conditions — and the many times to sit out.",
  scenarios: [
    {
      id: "sf1",
      prompt: "Three strong up candles with small wicks. Spread is tight (about 1 pip) and no news is due. What do you see?",
      chart: { candles: FLAME_CHART, highlight: [2, 3, 4] },
      options: ["Flame-style momentum — a scalp could be considered with a tight stop and a fast exit rule", "A range — sit out", "A reason to risk 20% on one trade", "A guaranteed winner"],
      answerIndex: 0,
      explanation: "Strong same-direction candles, small wicks and low costs are the flame conditions. You still need a planned stop, size and exit.",
    },
    {
      id: "sf2",
      prompt: "Same candles, but the spread has jumped to 6 pips (normally 1). What now?",
      chart: { candles: FLAME_CHART, highlight: [2, 3, 4] },
      options: ["Enter anyway — momentum is momentum", "Skip it — the cost eats most of a small scalp", "Double the size to cover the spread", "Use no stop"],
      answerIndex: 1,
      explanation: "Scalps target small moves, so a wide spread can wipe out the edge. Wide spreads often mean thin liquidity or news.",
    },
    {
      id: "sf3",
      prompt: "You bought on candle 2. Since then the candles are shrinking and the upper wicks are growing. What does that tell you?",
      chart: { candles: [[100, 101, 99.95, 100.95], [100.95, 101.9, 100.9, 101.85], [101.85, 102.6, 101.6, 102.3], [102.3, 102.9, 101.9, 102.45], [102.45, 102.9, 102.1, 102.5]], highlight: [2, 3, 4] },
      options: ["Momentum is fading — the scalp reason is weakening, follow your exit rule", "Momentum is accelerating", "Move your stop further away", "Add to the position"],
      answerIndex: 0,
      explanation: "A scalp exists because of momentum. Smaller bodies and rejection wicks mean it is slowing — the moment to take profit or tighten per your plan.",
    },
    {
      id: "sf4",
      prompt: "You spot strong momentum, but a high-impact news release is due in 2 minutes. Best choice?",
      options: ["Jump in before the news", "Wait until after the release and let spreads settle", "Remove your stop for the news", "Trade the biggest size you can"],
      answerIndex: 1,
      explanation: "News can spike price both ways and widen spreads. Waiting a few minutes is a professional decision, not a missed chance.",
    },
    {
      id: "sf5",
      prompt: "Small candles alternate up and down with long wicks either side. Any flame here?",
      chart: { candles: candlesFromCloses([100, 100.3, 99.9, 100.2, 99.95, 100.25, 99.9, 100.15], 0.35) },
      options: ["Yes, strong flame", "No — choppy, no direction; sitting out is valid", "Yes, short it hard", "Yes, buy and hold for weeks"],
      answerIndex: 1,
      explanation: "No directional momentum means no flame scalp. Most of the time the right scalp is no scalp.",
    },
    {
      id: "sf6",
      prompt: "Where does a scalp stop usually belong?",
      options: ["Just beyond the last small swing — tight and structural", "100 pips away to be safe", "No stop; scalps are quick", "Exactly at entry"],
      answerIndex: 0,
      explanation: "A tight stop just past the last micro swing fits a short-lived idea. If price gets there, the momentum reason is gone.",
    },
  ],
};

/* ------------------------------------------------------------------ */
/* Psychology                                                          */
/* ------------------------------------------------------------------ */

const PSYCHOLOGY: ScenarioLab = {
  labId: "lab-psychology",
  intro: "Catch the emotional trap in each situation before it costs you. All scenarios are made up for practice.",
  scenarios: [
    {
      id: "ps1",
      prompt: "Price has already run three times its usual daily move. You didn't plan it, but you feel you must get in now. What is this?",
      options: ["FOMO — fear of missing out", "Good discipline", "Revenge trading", "Risk management"],
      answerIndex: 0,
      explanation: "Chasing an unplanned move because others are 'winning' is FOMO. Wait for a setup your plan actually describes.",
    },
    {
      id: "ps2",
      prompt: "You lost two trades this morning. You decide to double your size on the next one to 'win it back'. What's the trap?",
      options: ["Patience", "Revenge trading", "Diversification", "Scaling in correctly"],
      answerIndex: 1,
      explanation: "Raising size to recover losses is revenge trading. A daily loss limit and a short break are the usual fixes.",
    },
    {
      id: "ps3",
      prompt: "It's noon and you've taken 15 trades. None of them matched your written plan. What's going on?",
      options: ["Overtrading", "A great strategy", "Normal scalping discipline", "Proper journaling"],
      answerIndex: 0,
      explanation: "Lots of trades outside the plan is overtrading — often boredom or chasing. Fewer, planned trades are easier to learn from.",
    },
    {
      id: "ps4",
      prompt: "Price is moving toward your stop, so you drag the stop further away 'to give it room'. What's really happening?",
      options: ["Smart flexibility", "Refusing to accept a planned loss", "Taking profit", "Hedging"],
      answerIndex: 1,
      explanation: "Moving a stop away turns a small planned loss into a bigger unplanned one. Decide the stop before entry and respect it.",
    },
    {
      id: "ps5",
      prompt: "Your plan targets 30 pips. At +5 pips you close in a panic because 'it might come back'. Which emotion drove that?",
      options: ["Greed", "Fear of giving back profit", "Boredom", "Confidence"],
      answerIndex: 1,
      explanation: "Cutting winners tiny while letting losers run full size wrecks your R:R. If you manage early, use a rule you wrote in advance.",
    },
    {
      id: "ps6",
      prompt: "After five wins in a row you feel unbeatable and raise risk from 1% to 10% per trade. What's the trap?",
      options: ["Overconfidence", "Correct position sizing", "FOMO", "Nothing — you earned it"],
      answerIndex: 0,
      explanation: "Streaks happen by chance too. Keeping risk fixed protects you when the next losing streak arrives — and it always does.",
    },
  ],
};

export const SCENARIO_LABS: Record<string, ScenarioLab> = {
  [MARKET_BASICS.labId]: MARKET_BASICS,
  [PRODUCTS.labId]: PRODUCTS,
  [CANDLE_READING.labId]: CANDLE_READING,
  [INDICATORS.labId]: INDICATORS,
  [SCALP_FLAME.labId]: SCALP_FLAME,
  [PSYCHOLOGY.labId]: PSYCHOLOGY,
};

/* ------------------------------------------------------------------ */
/* Entry / SL / TP drag lab                                            */
/* ------------------------------------------------------------------ */

export interface PlacementScenario extends PlacementScenarioRules {
  id: string;
  title: string;
  market: string;
  brief: string;
  candles: Candle[];
  priceMin: number;
  priceMax: number;
  /** index of the swing candle to mark on the chart */
  swingIndex: number;
  /** where the three lines start (deliberately not a passing placement) */
  start: { entry: number; stop: number; target: number };
  digits: number;
}

export const PLACEMENT_SCENARIOS: PlacementScenario[] = [
  {
    id: "long-pullback",
    title: "Buy the pullback",
    market: "Practice pair (EUR/USD-style)",
    direction: "long" as Direction,
    brief: "Uptrend, then a pullback that held a swing low at 1.0959. Price is turning back up near 1.0987. Plan a buy: entry near the last close, stop beyond the swing low, target at least 2× the risk.",
    candles: [[1.0905, 1.0912, 1.0902, 1.0908], [1.0908, 1.0922, 1.0907, 1.0919], [1.0919, 1.0927, 1.0914, 1.0925], [1.0925, 1.093, 1.0924, 1.093], [1.093, 1.0947, 1.0925, 1.0943], [1.0943, 1.0947, 1.0941, 1.0947], [1.0947, 1.096, 1.0944, 1.0955], [1.0955, 1.0962, 1.0951, 1.0961], [1.0961, 1.0974, 1.0959, 1.0969], [1.0969, 1.0979, 1.0968, 1.0974], [1.0974, 1.0985, 1.0969, 1.0981], [1.0981, 1.0997, 1.0979, 1.0992], [1.0992, 1.0993, 1.0977, 1.0982], [1.0982, 1.0988, 1.0975, 1.0979], [1.0979, 1.0985, 1.0971, 1.0976], [1.0976, 1.0978, 1.0971, 1.0973], [1.0973, 1.0976, 1.0964, 1.0964], [1.0964, 1.0974, 1.0959, 1.0968], [1.0968, 1.0978, 1.0963, 1.0976], [1.0976, 1.0987, 1.0972, 1.0987]],
    priceMin: 1.089,
    priceMax: 1.1095,
    swingIndex: 17,
    swingPrice: 1.0959,
    idealEntry: 1.0987,
    entryTolerancePips: 12,
    minRR: 2,
    maxStopBeyondSwingPips: 20,
    pipSize: 0.0001,
    digits: 4,
    start: { entry: 1.0987, stop: 1.0968, target: 1.1006 },
  },
  {
    id: "short-rally",
    title: "Sell the rally",
    market: "Practice pair (GBP/USD-style)",
    direction: "short" as Direction,
    brief: "Downtrend, then a weak bounce that topped at a swing high of 1.2737. Price is rolling over near 1.2712. Plan a sell: entry near the last close, stop beyond the swing high, target at least 2× the risk.",
    candles: [[1.282, 1.2824, 1.2801, 1.2806], [1.2806, 1.2809, 1.2794, 1.2796], [1.2796, 1.2799, 1.2788, 1.2789], [1.2789, 1.279, 1.278, 1.278], [1.278, 1.2784, 1.2767, 1.2768], [1.2768, 1.2774, 1.2753, 1.2756], [1.2756, 1.2757, 1.2746, 1.2747], [1.2747, 1.2752, 1.2738, 1.2741], [1.2741, 1.2744, 1.2729, 1.2731], [1.2731, 1.2736, 1.2718, 1.272], [1.272, 1.2724, 1.2709, 1.2713], [1.2713, 1.2716, 1.2702, 1.2704], [1.2704, 1.271, 1.27, 1.2704], [1.2704, 1.272, 1.2702, 1.2716], [1.2716, 1.272, 1.2716, 1.2719], [1.2719, 1.2729, 1.2713, 1.2725], [1.2725, 1.2737, 1.2724, 1.2734], [1.2734, 1.2736, 1.272, 1.2725], [1.2725, 1.2726, 1.2718, 1.2722], [1.2722, 1.2728, 1.271, 1.2712]],
    priceMin: 1.2615,
    priceMax: 1.2835,
    swingIndex: 16,
    swingPrice: 1.2737,
    idealEntry: 1.2712,
    entryTolerancePips: 12,
    minRR: 2,
    maxStopBeyondSwingPips: 20,
    pipSize: 0.0001,
    digits: 4,
    start: { entry: 1.2712, stop: 1.273, target: 1.2694 },
  },
];

/* ------------------------------------------------------------------ */
/* Support / Resistance drawing lab                                    */
/* ------------------------------------------------------------------ */

export interface ZoneScenario {
  id: string;
  title: string;
  brief: string;
  candles: Candle[];
  priceMin: number;
  priceMax: number;
  digits: number;
  pipSize: number;
  /** tolerance in pips either side of a target zone */
  tolerancePips: number;
  maxPlacements: number;
  targets: TargetZone[];
}

export const ZONE_SCENARIO: ZoneScenario = {
  id: "range-box",
  title: "Find the range floor and ceiling",
  brief: "Price bounced between a ceiling and a floor several times. Tap the chart to place a zone at each level where price clearly reacted. Tap a placed zone again to remove it.",
  candles: [[1.099, 1.1, 1.0988, 1.0995], [1.0995, 1.1012, 1.0993, 1.1011], [1.1011, 1.1017, 1.1009, 1.1014], [1.1014, 1.1028, 1.1011, 1.1022], [1.1022, 1.104, 1.1017, 1.1035], [1.1035, 1.1043, 1.1034, 1.1042], [1.1042, 1.1046, 1.1026, 1.1029], [1.1029, 1.1031, 1.1019, 1.102], [1.102, 1.1025, 1.1008, 1.1008], [1.1008, 1.101, 1.0992, 1.0994], [1.0994, 1.0998, 1.0978, 1.0983], [1.0983, 1.0987, 1.097, 1.0971], [1.0971, 1.0974, 1.0959, 1.0961], [1.0961, 1.097, 1.0958, 1.0968], [1.0968, 1.0982, 1.0964, 1.098], [1.098, 1.0998, 1.0979, 1.0995], [1.0995, 1.1012, 1.0992, 1.1006], [1.1006, 1.1018, 1.1003, 1.1013], [1.1013, 1.1034, 1.101, 1.103], [1.103, 1.1043, 1.1026, 1.104], [1.104, 1.1045, 1.103, 1.1032], [1.1032, 1.1036, 1.1018, 1.102], [1.102, 1.1023, 1.1001, 1.1003], [1.1003, 1.1005, 1.0992, 1.0994], [1.0994, 1.0999, 1.0981, 1.0986], [1.0986, 1.0987, 1.0968, 1.0973], [1.0973, 1.0973, 1.0959, 1.0961], [1.0961, 1.097, 1.0961, 1.0969], [1.0969, 1.0985, 1.0967, 1.0979], [1.0979, 1.0991, 1.0978, 1.0987], [1.0987, 1.0994, 1.0984, 1.0991], [1.0991, 1.1, 1.0985, 1.0999]],
  priceMin: 1.093,
  priceMax: 1.107,
  digits: 4,
  pipSize: 0.0001,
  tolerancePips: 8,
  maxPlacements: 5,
  targets: [
    { id: "resistance", label: "Resistance (ceiling) near 1.1043", price: 1.1043 },
    { id: "support", label: "Support (floor) near 1.0960", price: 1.096 },
  ],
};
