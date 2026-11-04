/**
 * Trading School — content model and seeded course data.
 *
 * This is a PURE data + types module. It contains no business logic, no network
 * calls, and no app wiring. The 10-step course renders entirely from this file
 * so the feature works today without a backend; when the real
 * /api/trading-school endpoints exist, the same shapes can be fetched instead.
 *
 * Compliance: nothing here promises profit. Education only.
 */

import { DEFAULT_ASSISTANT_NAME } from "@workspace/domain/assistant-name";

export type RubyMode = "simple" | "normal" | "pro";

export interface RubyExplanation {
  simple: string; // "Explain like I'm 12"
  normal: string; // beginner-friendly
  pro: string;    // more technical
}

export interface QuizQuestion {
  id: string;
  kind: "beginner" | "applied" | "chart" | "risk" | "psychology";
  prompt: string;
  options: string[];
  answerIndex: number;
  /** Ruby's plain-English explanation shown when the user gets it wrong. */
  rubyWhy: string;
}

export interface VocabItem {
  term: string;
  meaning: string;
}

export interface LessonStep {
  id: string;            // stable slug, e.g. "step-1"
  number: number;        // 1..10
  title: string;
  subtitle: string;
  /** short one-liner for cards */
  blurb: string;
  /** the teaching body, in plain prose paragraphs */
  lesson: string[];
  ruby: RubyExplanation;
  vocab: VocabItem[];
  beginnerExample: string;
  arxTieIn: string;
  practiceLabId: string; // links to a Practice Lab (may be "coming next")
  quiz: QuizQuestion[];
}

export interface Badge {
  id: string;
  label: string;
  earnedAfterStep: number; // earned when this step's quiz passes
  note: string;            // education-only meaning
}

export interface GlossaryEntry {
  term: string;
  simple: string;
  example: string;
  relatedStep?: number;
}

export interface PracticeLab {
  id: string;
  title: string;
  blurb: string;
  status: "available" | "coming-next";
}

/* ------------------------------------------------------------------ */
/* COURSE CONTENT — 10 steps                                          */
/* ------------------------------------------------------------------ */

export function buildSteps(assistantName: string = DEFAULT_ASSISTANT_NAME): LessonStep[] {
  return [
  {
    id: "step-1",
    number: 1,
    title: "What Is Trading?",
    subtitle: "Markets, buyers, sellers, and why price moves",
    blurb: "The absolute basics: what a market is and why prices change.",
    lesson: [
      "Trading means buying or selling something with the goal of a result you planned for. In financial markets, people buy and sell things like currencies, gold, company shares, and indices.",
      "A market is simply a place where buyers and sellers meet. When more people want to buy than sell, price tends to rise. When more people want to sell than buy, price tends to fall. That tug-of-war is what moves price up and down all day.",
      "A broker is the company that gives you access to the market. Liquidity means how easy it is to buy or sell quickly. Volatility means how fast and how far price moves — calm markets move slowly, volatile markets jump around.",
    ],
    ruby: {
      simple: "Imagine 10 kids want the last slice of pizza. The price goes up because lots of people want it. If nobody wants it, the price drops. Markets work the same way.",
      normal: "Price moves because buyers and sellers are fighting for control. If buyers are stronger, price usually rises. If sellers are stronger, price usually falls.",
      pro: "Price is the live consensus between supply and demand. Order flow imbalances — more aggressive buyers lifting offers or sellers hitting bids — shift price until a new temporary equilibrium forms.",
    },
    vocab: [
      { term: "Market", meaning: "Where buyers and sellers meet to trade." },
      { term: "Broker", meaning: "The company that gives you access to the market." },
      { term: "Liquidity", meaning: "How easily you can buy or sell without moving price much." },
      { term: "Volatility", meaning: "How fast and far price moves." },
    ],
    beginnerExample: "If 10 kids want the last pizza slice, its price rises. If no one wants it, the price falls. Buyers and sellers set the price.",
    arxTieIn: "In ARX, the Scanner shows you many markets at once. You're watching that same buyer-vs-seller fight play out across Forex, Gold, and indices.",
    practiceLabId: "lab-market-basics",
    quiz: [
      { id: "s1q1", kind: "beginner", prompt: "What usually happens to price when many more people want to buy than sell?", options: ["Price falls", "Price rises", "Price never changes", "The market closes"], answerIndex: 1, rubyWhy: "More buyers than sellers means buyers compete and push price up. Think of the pizza slice everyone wants." },
      { id: "s1q2", kind: "beginner", prompt: "What is a broker?", options: ["A type of candle", "A government tax", "The company that gives you market access", "A trading robot"], answerIndex: 2, rubyWhy: "A broker is your doorway to the market — it's the company that lets you place buy and sell orders." },
      { id: "s1q3", kind: "beginner", prompt: "What does 'liquidity' mean?", options: ["How wet the market is", "How easily you can buy or sell quickly", "How much tax you pay", "The color of a candle"], answerIndex: 1, rubyWhy: "Liquidity is about ease of trading. High liquidity means you can enter and exit quickly without moving price much." },
      { id: "s1q4", kind: "beginner", prompt: "Volatility describes…", options: ["How fast and far price moves", "The broker's fees", "The number of traders", "The size of your screen"], answerIndex: 0, rubyWhy: "Volatility is movement. Calm markets drift; volatile markets jump. Neither is good or bad on its own." },
      { id: "s1q5", kind: "beginner", prompt: "Why does price move at all?", options: ["Random luck", "The buyer-vs-seller balance changes", "The broker decides each morning", "It follows the weather"], answerIndex: 1, rubyWhy: "Price reflects the live balance of buyers and sellers. When that balance shifts, price moves." },
      { id: "s1q6", kind: "applied", prompt: "Sellers suddenly become much more aggressive than buyers. What's most likely?", options: ["Price rises", "Price falls", "Price freezes", "Liquidity disappears forever"], answerIndex: 1, rubyWhy: "More aggressive selling pressure pushes price down until buyers step back in." },
      { id: "s1q7", kind: "applied", prompt: "A market barely moves all day. How would you describe it?", options: ["High volatility", "Low volatility", "High leverage", "A breakout"], answerIndex: 1, rubyWhy: "Small, slow movement is low volatility. Big fast swings would be high volatility." },
      { id: "s1q8", kind: "applied", prompt: "You can enter and exit a market instantly with tiny cost. That market has…", options: ["Low liquidity", "High liquidity", "No broker", "High taxes"], answerIndex: 1, rubyWhy: "Easy, cheap, fast trading is the sign of high liquidity." },
      { id: "s1q9", kind: "applied", prompt: "Two kids want one slice; eight kids want to give theirs away. Price will…", options: ["Rise", "Fall", "Stay exactly the same", "Double"], answerIndex: 1, rubyWhy: "Lots of sellers and few buyers means price falls — supply outweighs demand." },
      { id: "s1q10", kind: "chart", prompt: "On a chart, price moving steadily higher over time means…", options: ["Sellers are in control", "Buyers have generally been stronger", "The broker raised fees", "Nothing — charts are random"], answerIndex: 1, rubyWhy: "A rising chart reflects buyers being repeatedly willing to pay more — buyer strength over time." },
      { id: "s1q11", kind: "risk", prompt: "Before risking money, the first thing a beginner should do is…", options: ["Use maximum leverage", "Understand how price and risk work", "Copy a stranger online", "Trade their rent money"], answerIndex: 1, rubyWhy: "Understanding comes before risking real money. That's the whole point of this school." },
      { id: "s1q12", kind: "psychology", prompt: "You feel you 'must' trade right now or miss out. That feeling is…", options: ["A guaranteed signal", "Worth ignoring — urgency isn't a strategy", "A broker bonus", "Proof price will rise"], answerIndex: 1, rubyWhy: "Urgency and fear of missing out cloud judgment. A plan beats a feeling every time." },
    ],
  },
  {
    id: "step-2",
    number: 2,
    title: "Trading Products: What Can You Trade?",
    subtitle: "Forex, indices, commodities, crypto, synthetics and more",
    blurb: "The main things people trade and why each behaves differently.",
    lesson: [
      "There are many things you can trade. Stocks are tiny pieces of a company. Forex is one currency against another, like EUR/USD. Commodities include things like gold and oil. Indices like US30 track a basket of big companies. Crypto is digital currency. Synthetic or volatility indices are simulated markets that run all the time.",
      "Each market behaves differently. Forex moves with global news and trading sessions. Gold often moves when people are nervous. Indices move with big companies and the economy. Synthetics move on their own schedule with steady volatility.",
      "Leveraged products and CFDs let you control a larger position with a smaller amount of money. That can magnify gains AND losses — which is exactly why risk management (Step 7) matters so much.",
    ],
    ruby: {
      simple: "Different markets are like different sports. Forex, gold, and indices each have their own 'rules' for how they move. You learn one before juggling many.",
      normal: "Every market has its own personality — its busiest hours, what news moves it, and how jumpy it is. Knowing the personality helps you plan.",
      pro: "Asset classes differ in session liquidity, volatility regime, and sensitivity to macro drivers. Leveraged CFDs add margin mechanics that amplify both directions of P/L.",
    },
    vocab: [
      { term: "Forex", meaning: "Trading one currency against another, e.g. EUR/USD." },
      { term: "Index", meaning: "A basket of companies tracked as one number, e.g. US30." },
      { term: "Leverage", meaning: "Controlling a larger position with less money — magnifies wins and losses." },
      { term: "CFD", meaning: "A contract that tracks an asset's price without owning it." },
    ],
    beginnerExample: "Gold often rises when people feel nervous about the world. EUR/USD reacts to news from Europe and the US. Same idea, different triggers.",
    arxTieIn: "ARX supports Forex pairs, Gold, indices like US30, and (where enabled) Deriv synthetic/volatility markets. The Scanner lets you compare them side by side.",
    practiceLabId: "lab-products",
    quiz: [
      { id: "s2q1", kind: "beginner", prompt: "EUR/USD is an example of…", options: ["A stock", "A Forex pair", "A commodity", "A crypto coin"], answerIndex: 1, rubyWhy: "Forex pairs trade one currency against another. EUR/USD is the euro against the US dollar." },
      { id: "s2q2", kind: "beginner", prompt: "US30 is an example of…", options: ["A single company", "An index (basket of companies)", "A currency", "A type of candle"], answerIndex: 1, rubyWhy: "An index tracks many companies as one number. US30 follows 30 large US companies." },
      { id: "s2q3", kind: "beginner", prompt: "Leverage lets you…", options: ["Remove all risk", "Control a bigger position with less money", "Guarantee profit", "Avoid the broker"], answerIndex: 1, rubyWhy: "Leverage scales your position size up. It magnifies both gains and losses, so it needs respect." },
      { id: "s2q4", kind: "beginner", prompt: "Which often moves when people feel nervous about the world?", options: ["Gold", "Nothing", "Only crypto", "Only stocks"], answerIndex: 0, rubyWhy: "Gold is often treated as a 'safe haven', so it can move when there's uncertainty." },
      { id: "s2q5", kind: "beginner", prompt: "Synthetic/volatility indices are…", options: ["Real company shares", "Simulated markets with steady volatility", "Government bonds", "Bank savings accounts"], answerIndex: 1, rubyWhy: "Synthetics are simulated markets designed to run continuously with consistent volatility." },
      { id: "s2q6", kind: "applied", prompt: "You want a market that trades on weekends too. Best fit?", options: ["A stock index", "A synthetic/volatility index", "A single share", "None exist"], answerIndex: 1, rubyWhy: "Synthetic indices typically run continuously, unlike stock markets that close on weekends." },
      { id: "s2q7", kind: "applied", prompt: "Big economic news from Europe is most likely to move…", options: ["A US tech stock only", "EUR/USD", "Gold only", "Nothing"], answerIndex: 1, rubyWhy: "EUR/USD includes the euro, so European news is a natural driver." },
      { id: "s2q8", kind: "applied", prompt: "Why learn one market well before trading many?", options: ["It's a rule from brokers", "Each market has its own behavior to understand", "You can't trade two markets", "To pay less tax"], answerIndex: 1, rubyWhy: "Each market has a personality. Mastering one builds skills you can carry to others." },
      { id: "s2q9", kind: "chart", prompt: "Two markets on a chart: one drifts slowly, one swings wildly. The wild one has…", options: ["Higher volatility", "Lower liquidity always", "No broker", "Higher taxes"], answerIndex: 0, rubyWhy: "Bigger, faster swings mean higher volatility — important when planning your stop distance." },
      { id: "s2q10", kind: "chart", prompt: "An index chart rising over months suggests…", options: ["Its companies generally did well", "The broker changed", "Random noise only", "Sellers dominated"], answerIndex: 0, rubyWhy: "A rising index reflects its underlying companies generally gaining value over that period." },
      { id: "s2q11", kind: "risk", prompt: "Leverage is dangerous mainly because it…", options: ["Removes the chart", "Magnifies losses too", "Closes the market", "Hides the spread"], answerIndex: 1, rubyWhy: "Leverage cuts both ways. The same force that magnifies a gain magnifies a loss." },
      { id: "s2q12", kind: "psychology", prompt: "Trading 6 unfamiliar markets at once as a beginner usually leads to…", options: ["Mastery", "Overwhelm and mistakes", "Guaranteed profit", "Lower risk"], answerIndex: 1, rubyWhy: "Spreading yourself thin early causes confusion. Focus beats scatter when you're learning." },
    ],
  },
  {
    id: "step-3",
    number: 3,
    title: "Orders: How Trades Open and Close",
    subtitle: "Market, limit, stop, stop-loss and take-profit",
    blurb: "The buttons you actually press — and the safety ones you must use.",
    lesson: [
      "To buy means you expect price to rise. To sell (short) means you expect price to fall. A market order opens right now at the current price. A limit order waits to open at a better price you choose. A stop order opens once price reaches a level, often used for breakouts.",
      "Two orders protect you. A stop-loss automatically closes a losing trade at a price you set, capping your loss. A take-profit automatically closes a winning trade at your target. Setting both before you enter is the mark of a disciplined trader.",
      "The spread is the small gap between the buy and sell price — a cost of trading. Slippage is when your order fills at a slightly different price than expected, common in fast markets.",
    ],
    ruby: {
      simple: "A stop-loss is your seatbelt. You hope you never need it, but you always put it on before you drive.",
      normal: "A trade without a stop-loss is like driving without brakes. You might be fine for a while, but when something goes wrong, you need protection.",
      pro: "Entries can be market, limit, or stop orders depending on whether you want immediacy, price improvement, or momentum confirmation. Stop-loss and take-profit define your risk and reward boundaries before exposure begins.",
    },
    vocab: [
      { term: "Market order", meaning: "Opens a trade right now at current price." },
      { term: "Limit order", meaning: "Waits to open at a chosen better price." },
      { term: "Stop-loss", meaning: "Auto-closes a losing trade to cap the loss." },
      { term: "Take-profit", meaning: "Auto-closes a winning trade at your target." },
      { term: "Spread", meaning: "The small gap between buy and sell price — a trading cost." },
      { term: "Slippage", meaning: "Filling at a slightly different price than expected." },
    ],
    beginnerExample: "You buy at 100, set a stop-loss at 98 (max loss) and take-profit at 106 (target). The trade now manages itself within those limits.",
    arxTieIn: "ARX's trade ticket and confirmation modals ask you to confirm your order and protection before anything goes live. The Risk Governor can require a stop-loss.",
    practiceLabId: "lab-entry-sl-tp",
    quiz: [
      { id: "s3q1", kind: "beginner", prompt: "A market order…", options: ["Waits for a better price", "Opens right now at current price", "Is a type of candle", "Cancels your account"], answerIndex: 1, rubyWhy: "Market orders prioritize speed — they fill immediately at the current available price." },
      { id: "s3q2", kind: "beginner", prompt: "A stop-loss is used to…", options: ["Guarantee profit", "Cap how much you can lose", "Increase leverage", "Hide the spread"], answerIndex: 1, rubyWhy: "A stop-loss closes a losing trade at a level you chose, limiting the damage." },
      { id: "s3q3", kind: "beginner", prompt: "A take-profit…", options: ["Closes a winner at your target", "Opens a new trade", "Doubles your risk", "Pays the broker"], answerIndex: 0, rubyWhy: "Take-profit locks in a win by closing at your planned target price." },
      { id: "s3q4", kind: "beginner", prompt: "The spread is…", options: ["Free money", "The gap between buy and sell price", "A candle wick", "A news event"], answerIndex: 1, rubyWhy: "The spread is a small built-in cost — the difference between the buy and sell price." },
      { id: "s3q5", kind: "beginner", prompt: "To 'short' a market means you expect price to…", options: ["Rise", "Fall", "Freeze", "Disappear"], answerIndex: 1, rubyWhy: "Shorting (selling) profits if price falls. Buying (going long) profits if price rises." },
      { id: "s3q6", kind: "applied", prompt: "You want to buy ONLY if price drops to a better level first. Use a…", options: ["Market order", "Limit order", "Stop-loss", "Take-profit"], answerIndex: 1, rubyWhy: "A buy limit waits patiently for your chosen better (lower) price before opening." },
      { id: "s3q7", kind: "applied", prompt: "You buy at 100 with a stop at 98. Price hits 98. What happens?", options: ["Trade stays open", "Trade auto-closes for a small loss", "You profit", "Leverage doubles"], answerIndex: 1, rubyWhy: "The stop-loss does its job: it closes the trade at 98 so the loss can't grow." },
      { id: "s3q8", kind: "applied", prompt: "In a fast market your fill price differs slightly from expected. That's…", options: ["Spread", "Slippage", "Leverage", "A badge"], answerIndex: 1, rubyWhy: "Slippage happens when price moves between your click and the fill, common in fast conditions." },
      { id: "s3q9", kind: "chart", prompt: "On a chart, your stop-loss line should sit…", options: ["Where your trade idea is proven wrong", "At a random spot", "Above your entry for a buy", "Off the chart"], answerIndex: 0, rubyWhy: "A stop belongs where the idea is invalidated — the price that says 'I was wrong here.'" },
      { id: "s3q10", kind: "chart", prompt: "For a BUY, take-profit is usually placed…", options: ["Below entry", "Above entry at your target", "Exactly at entry", "Randomly"], answerIndex: 1, rubyWhy: "A buy profits as price rises, so the take-profit target sits above your entry." },
      { id: "s3q11", kind: "risk", prompt: "Entering a trade with NO stop-loss is risky because…", options: ["The spread vanishes", "Losses can grow without limit", "You can't take profit", "The chart hides"], answerIndex: 1, rubyWhy: "Without a stop, a losing trade has no automatic brake — losses can run far past comfort." },
      { id: "s3q12", kind: "psychology", prompt: "You're tempted to move your stop-loss further away as price drops. This is…", options: ["Smart discipline", "A common emotional mistake", "Required by brokers", "Guaranteed to work"], answerIndex: 1, rubyWhy: "Moving a stop to avoid being wrong turns a small planned loss into a big unplanned one." },
    ],
  },
  {
    id: "step-4",
    number: 4,
    title: "Candlesticks: Reading Market Body Language",
    subtitle: "Open, close, high, low, body and wick",
    blurb: "How a single candle tells the story of a buyer-vs-seller fight.",
    lesson: [
      "Each candle covers one period of time — one minute, one hour, one day. It has four prices: the open (where it started), the close (where it ended), the high (the top), and the low (the bottom).",
      "A bullish candle closes higher than it opened — buyers won that round. A bearish candle closes lower than it opened — sellers won. The body is the thick part between open and close. The wicks (or shadows) are the thin lines showing how far price stretched before snapping back.",
      "Single candles hint; clusters of candles tell stories. Long wicks can show rejection of a price. Big bodies show strong conviction. You read them together with structure, not alone.",
    ],
    ruby: {
      simple: "A candle is like a short clip of a tug-of-war. The body shows who won, and the wicks show how hard each side pulled before giving up.",
      normal: "A candle is a small story of a fight between buyers and sellers during one period of time.",
      pro: "Each OHLC candle encodes intraperiod auction dynamics. Wick-to-body ratios and close location signal rejection, absorption, or continuation depending on context.",
    },
    vocab: [
      { term: "Open", meaning: "The price where the candle started." },
      { term: "Close", meaning: "The price where the candle ended." },
      { term: "Body", meaning: "The thick part between open and close." },
      { term: "Wick", meaning: "The thin line showing the high/low stretch." },
      { term: "Bullish candle", meaning: "Closed higher than it opened — buyers won." },
      { term: "Bearish candle", meaning: "Closed lower than it opened — sellers won." },
    ],
    beginnerExample: "A candle opens at 100, dips to 97 (lower wick), but closes at 104. Buyers fought back hard — a bullish candle with a tail showing the failed drop.",
    arxTieIn: `Every chart in ARX — the Scanner panel and the native chart — is built from candles. ${assistantName}'s Chart Read describes what recent candles are saying.`,
    practiceLabId: "lab-candle-reading",
    quiz: [
      { id: "s4q1", kind: "beginner", prompt: "A bullish candle closes…", options: ["Lower than it opened", "Higher than it opened", "Exactly where it opened", "Off the chart"], answerIndex: 1, rubyWhy: "Bullish = buyers won the period, so it closes above where it opened." },
      { id: "s4q2", kind: "beginner", prompt: "The body of a candle is…", options: ["The thin line", "The thick part between open and close", "The volume", "The spread"], answerIndex: 1, rubyWhy: "The body spans open to close. The thin lines are the wicks." },
      { id: "s4q3", kind: "beginner", prompt: "A wick shows…", options: ["The broker fee", "How far price stretched before snapping back", "Your profit", "The trend name"], answerIndex: 1, rubyWhy: "Wicks mark the high and low reached during the candle — the stretch beyond the body." },
      { id: "s4q4", kind: "beginner", prompt: "The four prices in every candle are…", options: ["Open, close, high, low", "Buy, sell, hold, wait", "Red, green, big, small", "RSI, MACD, ATR, VWAP"], answerIndex: 0, rubyWhy: "Every candle is OHLC: open, high, low, close." },
      { id: "s4q5", kind: "beginner", prompt: "A bearish candle means…", options: ["Buyers won", "Sellers won that period", "Nothing happened", "The market closed"], answerIndex: 1, rubyWhy: "Bearish = sellers pushed the close below the open." },
      { id: "s4q6", kind: "applied", prompt: "A candle with a long lower wick and a close near the top suggests…", options: ["Buyers rejected lower prices", "Sellers took full control", "Nothing", "A broker error"], answerIndex: 0, rubyWhy: "Price dipped, then buyers pushed it back up — a long lower wick shows that rejection." },
      { id: "s4q7", kind: "applied", prompt: "A very large bullish body usually shows…", options: ["Weak interest", "Strong buyer conviction", "A guaranteed reversal", "Low liquidity"], answerIndex: 1, rubyWhy: "A big body means one side dominated decisively — here, strong buying." },
      { id: "s4q8", kind: "applied", prompt: "Should you trade off one candle alone?", options: ["Yes, always", "No — read it with structure and context", "Only on Mondays", "Only with max leverage"], answerIndex: 1, rubyWhy: "One candle hints; context confirms. Combine candles with trend and levels." },
      { id: "s4q9", kind: "chart", prompt: "On the chart, a candle's top wick reaches the…", options: ["Open", "Close", "High", "Low"], answerIndex: 2, rubyWhy: "The upper wick marks the highest price reached during that candle." },
      { id: "s4q10", kind: "chart", prompt: "Several big bearish candles in a row suggest…", options: ["Strong selling pressure", "A guaranteed bounce", "Buyers in control", "The chart is broken"], answerIndex: 0, rubyWhy: "A cluster of strong bearish candles shows sustained selling — sellers in control for now." },
      { id: "s4q11", kind: "risk", prompt: "A huge volatile candle means your stop distance should be…", options: ["Ignored", "Considered carefully — bigger swings need thought", "Always zero", "Set after entry"], answerIndex: 1, rubyWhy: "Bigger candles mean bigger swings; your stop and size must account for that volatility." },
      { id: "s4q12", kind: "psychology", prompt: "You see one green candle and feel you MUST buy immediately. Better to…", options: ["Chase it instantly", "Wait for context and a plan", "Use all your money", "Remove your stop"], answerIndex: 1, rubyWhy: "One candle is not a plan. Chasing single candles is how impulse trades go wrong." },
    ],
  },
  {
    id: "step-5",
    number: 5,
    title: "Trend, Support, and Resistance",
    subtitle: "Structure: the map of where price has reacted",
    blurb: "Uptrends, downtrends, ranges, and the zones price remembers.",
    lesson: [
      "An uptrend is a series of higher highs and higher lows — price stair-steps up. A downtrend is lower highs and lower lows — it stair-steps down. A range is sideways, bouncing between a floor and a ceiling.",
      "Support is a price zone where buying previously stopped a fall — a floor. Resistance is a zone where selling previously stopped a rise — a ceiling. These aren't magic lines; they're memory zones where price reacted before.",
      "A breakout is when price pushes through support or resistance and keeps going. A fakeout is when it pokes through, traps people, then snaps back. Telling them apart takes confirmation, not hope.",
    ],
    ruby: {
      simple: "Support is like a floor and resistance is like a ceiling. Price bounces between them until one finally breaks.",
      normal: "Support is a price zone where buyers showed up before. Resistance is where sellers showed up before. Price often reacts at these zones again.",
      pro: "I do not treat support and resistance like magic. I treat them like memory zones where order flow previously absorbed pressure, useful for entries, stops, and invalidation.",
    },
    vocab: [
      { term: "Uptrend", meaning: "Higher highs and higher lows — price rising over time." },
      { term: "Downtrend", meaning: "Lower highs and lower lows — price falling over time." },
      { term: "Range", meaning: "Sideways price between a floor and ceiling." },
      { term: "Support", meaning: "A floor zone where buyers appeared before." },
      { term: "Resistance", meaning: "A ceiling zone where sellers appeared before." },
      { term: "Breakout", meaning: "Price pushing through a level and continuing." },
      { term: "Fakeout", meaning: "A false break that snaps back, trapping traders." },
    ],
    beginnerExample: "Price bounces off 100 three times (support) and gets rejected at 110 three times (resistance). It's ranging between a floor and a ceiling.",
    arxTieIn: `${assistantName}'s Chart Read in ARX points out structure like trend direction and nearby reaction zones, so you can plan around them instead of guessing.`,
    practiceLabId: "lab-support-resistance",
    quiz: [
      { id: "s5q1", kind: "beginner", prompt: "An uptrend is made of…", options: ["Lower highs and lower lows", "Higher highs and higher lows", "Random spikes", "One candle"], answerIndex: 1, rubyWhy: "Uptrends stair-step up: each push makes a higher high, each dip a higher low." },
      { id: "s5q2", kind: "beginner", prompt: "Support acts like a…", options: ["Ceiling", "Floor", "Spread", "Wick"], answerIndex: 1, rubyWhy: "Support is a floor — a zone where buyers previously stopped the fall." },
      { id: "s5q3", kind: "beginner", prompt: "Resistance acts like a…", options: ["Floor", "Ceiling", "Broker", "Candle body"], answerIndex: 1, rubyWhy: "Resistance is a ceiling — where sellers previously stopped the rise." },
      { id: "s5q4", kind: "beginner", prompt: "A sideways market between a floor and ceiling is a…", options: ["Trend", "Range", "Breakout", "Wick"], answerIndex: 1, rubyWhy: "When price bounces sideways between levels, it's ranging." },
      { id: "s5q5", kind: "beginner", prompt: "A downtrend has…", options: ["Higher highs", "Lower highs and lower lows", "No movement", "Only wicks"], answerIndex: 1, rubyWhy: "Downtrends stair-step down with lower highs and lower lows." },
      { id: "s5q6", kind: "applied", prompt: "Price breaks above resistance and keeps rising. That's a…", options: ["Fakeout", "Breakout", "Range", "Stop-loss"], answerIndex: 1, rubyWhy: "Pushing through resistance and continuing is a breakout." },
      { id: "s5q7", kind: "applied", prompt: "Price pokes above resistance, traps buyers, then drops back. That's a…", options: ["Breakout", "Fakeout", "Uptrend", "Take-profit"], answerIndex: 1, rubyWhy: "A brief break that snaps back is a fakeout — it traps those who chased it." },
      { id: "s5q8", kind: "applied", prompt: "In a clear uptrend, traders often look to buy near…", options: ["Resistance", "Support / higher lows", "Random points", "The spread"], answerIndex: 1, rubyWhy: "Buying near support or a higher low in an uptrend aligns with the trend's structure." },
      { id: "s5q9", kind: "chart", prompt: "Three bounces off the same lower zone marks likely…", options: ["Resistance", "Support", "A wick", "Slippage"], answerIndex: 1, rubyWhy: "Repeated bounces from a lower zone define support — buyers keep defending it." },
      { id: "s5q10", kind: "chart", prompt: "Price making lower highs over time signals a…", options: ["Uptrend", "Downtrend pressure", "Guaranteed bounce", "Broker issue"], answerIndex: 1, rubyWhy: "Lower highs show sellers stepping in earlier each time — downtrend pressure." },
      { id: "s5q11", kind: "risk", prompt: "A logical stop for a buy at support sits…", options: ["Far above entry", "Just below the support zone", "At the resistance", "Nowhere"], answerIndex: 1, rubyWhy: "If price breaks below support, your reason is gone — so the stop sits just under it." },
      { id: "s5q12", kind: "psychology", prompt: "Price fakes out and hits your stop. The disciplined response is…", options: ["Revenge trade immediately", "Accept the planned loss and reassess", "Remove all stops forever", "Double your size"], answerIndex: 1, rubyWhy: "Fakeouts happen. Taking the planned loss calmly beats emotional revenge trading." },
    ],
  },
  {
    id: "step-6",
    number: 6,
    title: "Indicators Without Confusion",
    subtitle: "Moving averages, RSI, MACD and friends — used wisely",
    blurb: "What common indicators do, and the trap of stacking too many.",
    lesson: [
      "Indicators are math drawn on the chart to summarize price. A moving average smooths price to show direction. RSI measures whether price has moved too far, too fast. MACD compares momentum. Bollinger Bands show how stretched price is. ATR measures volatility. Volume and VWAP show activity and an average price by volume.",
      "Indicators describe what price already did — they lag. They are clues, not commands. A common beginner mistake is stacking five indicators that all say the same thing and calling it 'confirmation'.",
      "The skill is using one or two indicators to support what structure and candles are already telling you — never to replace your own reading of the chart.",
    ],
    ruby: {
      simple: "Indicators are helpers, like a calculator. Useful, but they don't decide for you. You still need to understand the chart.",
      normal: "An indicator is a clue, not a green light. I read it alongside structure and risk, never on its own.",
      pro: "Indicators are derived, lagging transforms of price. They add value as confluence with structure and momentum, but stacking correlated indicators creates false confidence, not edge.",
    },
    vocab: [
      { term: "Moving average", meaning: "A smoothed line showing general direction." },
      { term: "RSI", meaning: "Shows if price moved too far, too fast." },
      { term: "MACD", meaning: "Compares momentum between two averages." },
      { term: "ATR", meaning: "Measures how volatile price currently is." },
      { term: "VWAP", meaning: "Average price weighted by volume." },
    ],
    beginnerExample: "A 50-period moving average sloping up suggests the broader direction is up. It's a backdrop, not a buy button.",
    arxTieIn: `ARX charts can show indicators, and ${assistantName} weighs momentum and structure together rather than reacting to a single indicator flip.`,
    practiceLabId: "lab-indicators",
    quiz: [
      { id: "s6q1", kind: "beginner", prompt: "A moving average mainly helps you see…", options: ["The spread", "General direction", "Your profit", "The broker"], answerIndex: 1, rubyWhy: "Moving averages smooth out noise to reveal the broader direction of price." },
      { id: "s6q2", kind: "beginner", prompt: "RSI is designed to show…", options: ["If price moved too far, too fast", "Your account balance", "The candle color", "The spread"], answerIndex: 0, rubyWhy: "RSI measures momentum extremes — whether a move is overstretched." },
      { id: "s6q3", kind: "beginner", prompt: "ATR measures…", options: ["Volatility", "Profit", "Trend names", "Broker fees"], answerIndex: 0, rubyWhy: "ATR (Average True Range) gauges how much price typically moves — its volatility." },
      { id: "s6q4", kind: "beginner", prompt: "Indicators are based on…", options: ["Future prices", "Price that already happened (they lag)", "Random numbers", "Broker mood"], answerIndex: 1, rubyWhy: "Indicators are calculated from past price, so they naturally lag what's happening now." },
      { id: "s6q5", kind: "beginner", prompt: "An indicator should be treated as…", options: ["A command to trade", "A clue among others", "A profit guarantee", "A stop-loss"], answerIndex: 1, rubyWhy: "Indicators are supporting clues — never standalone commands." },
      { id: "s6q6", kind: "applied", prompt: "Stacking five indicators that all say the same thing gives you…", options: ["Real confirmation", "False confidence", "Lower risk", "A badge"], answerIndex: 1, rubyWhy: "Correlated indicators repeat one idea. That feels like confirmation but isn't real edge." },
      { id: "s6q7", kind: "applied", prompt: "Best practice is to use indicators to…", options: ["Replace chart reading", "Support structure and candles", "Hide the spread", "Avoid stops"], answerIndex: 1, rubyWhy: "Indicators add confluence to your chart reading; they don't replace it." },
      { id: "s6q8", kind: "applied", prompt: "A rising 50-MA in the background suggests…", options: ["Broad downtrend", "Broad uptrend backdrop", "Guaranteed reversal", "Nothing ever"], answerIndex: 1, rubyWhy: "An upward-sloping moving average reflects a generally rising backdrop." },
      { id: "s6q9", kind: "chart", prompt: "Price far above a moving average might mean it's…", options: ["Stretched / extended", "About to be free", "A new broker", "A wick"], answerIndex: 0, rubyWhy: "Large distance from a moving average can signal an extended, stretched move." },
      { id: "s6q10", kind: "chart", prompt: "RSI at an extreme high alone means you should…", options: ["Instantly sell", "Be cautious and seek context", "Use max leverage", "Ignore the chart"], answerIndex: 1, rubyWhy: "Extremes are a caution flag, not an automatic trade — context still rules." },
      { id: "s6q11", kind: "risk", prompt: "Trusting one indicator blindly can lead to…", options: ["Perfect trades", "Ignoring real risk and structure", "No spread", "Guaranteed wins"], answerIndex: 1, rubyWhy: "Blind trust in a single tool ignores the bigger risk picture and can burn you." },
      { id: "s6q12", kind: "psychology", prompt: "Adding more indicators because you feel unsure usually…", options: ["Removes doubt for good", "Adds clutter and confusion", "Guarantees profit", "Lowers volatility"], answerIndex: 1, rubyWhy: "Piling on indicators to soothe anxiety creates clutter, not clarity." },
    ],
  },
  {
    id: "step-7",
    number: 7,
    title: "Risk Management: The Part That Keeps You Alive",
    subtitle: "Position sizing, risk-per-trade, and risk-to-reward",
    blurb: "The most important step. How to lose small and survive to trade again.",
    lesson: [
      "Your balance is your money; equity is your balance including open trades. Margin is the deposit a leveraged trade needs; free margin is what's left. Drawdown is how far your account has dropped from its peak.",
      "Risk per trade is how much you're willing to lose on one idea — often a small percent like 1–2% of your account. Position size (lot size) is chosen so that if your stop-loss is hit, you only lose that planned amount. Risk-to-reward compares what you risk to what you aim to gain.",
      "A daily loss limit stops you trading after a bad run, protecting you from yourself. Good risk management is what lets you survive losing streaks — and every trader has them.",
    ],
    ruby: {
      simple: "Before asking how much you could win, ask how much you could lose if you're wrong. Plan the loss first, always.",
      normal: "A good trader does not ask 'How much can I make?' first. A good trader asks 'How much can I lose if I am wrong?'",
      pro: "This trade risks $X to attempt $Y. If price hits the stop-loss, the idea is invalidated. If it hits take-profit, the plan worked. The outcome is never guaranteed — only the risk is controlled.",
    },
    vocab: [
      { term: "Balance", meaning: "Your account money, not counting open trades." },
      { term: "Equity", meaning: "Balance including the value of open trades." },
      { term: "Drawdown", meaning: "How far your account dropped from its peak." },
      { term: "Risk per trade", meaning: "How much you'll lose if one trade is wrong." },
      { term: "Position size", meaning: "Trade size chosen to match your planned risk." },
      { term: "Risk-to-reward", meaning: "What you risk vs. what you aim to gain." },
    ],
    beginnerExample: "Account $100, risk 2% = $2. You size the trade so that if the stop-loss hits, you lose about $2 — not $40.",
    arxTieIn: "ARX's Risk Governor enforces caps like max lot size, max open trades, and can require a stop-loss. The Risk Simulator in this school lets you practice the math safely.",
    practiceLabId: "lab-risk-calculator",
    quiz: [
      { id: "s7q1", kind: "beginner", prompt: "Risk per trade is usually kept…", options: ["As high as possible", "Small, like 1–2% of the account", "At 100%", "Random"], answerIndex: 1, rubyWhy: "Keeping risk small per trade means no single loss can seriously hurt your account." },
      { id: "s7q2", kind: "beginner", prompt: "Equity is…", options: ["Only your cash", "Balance including open trades", "The spread", "A candle"], answerIndex: 1, rubyWhy: "Equity reflects your balance plus the live value of any open positions." },
      { id: "s7q3", kind: "beginner", prompt: "Drawdown measures…", options: ["Profit", "How far the account fell from its peak", "The trend", "Volume"], answerIndex: 1, rubyWhy: "Drawdown is the drop from your account's high point — a key risk measure." },
      { id: "s7q4", kind: "beginner", prompt: "Position size should be chosen so that…", options: ["You always win", "A stop-loss hit only costs your planned risk", "You never use a stop", "The spread is zero"], answerIndex: 1, rubyWhy: "Size the trade so a stopped-out loss equals your small planned risk — no surprises." },
      { id: "s7q5", kind: "beginner", prompt: "A daily loss limit helps by…", options: ["Guaranteeing profit", "Stopping you after a bad run", "Removing the spread", "Adding leverage"], answerIndex: 1, rubyWhy: "A daily loss limit protects you from spiraling after several losses — discipline on autopilot." },
      { id: "s7q6", kind: "applied", prompt: "Account $100, risk 2%. Your planned loss is…", options: ["$20", "$2", "$50", "$0"], answerIndex: 1, rubyWhy: "2% of $100 is $2. That's the most this trade should cost if you're wrong." },
      { id: "s7q7", kind: "applied", prompt: "Risk $2 to make $6 is a risk-to-reward of…", options: ["1:3", "3:1", "1:1", "2:6 only"], answerIndex: 0, rubyWhy: "Risking 1 unit to gain 3 is 1:3 — you aim to win three times what you risk." },
      { id: "s7q8", kind: "applied", prompt: "Wider stop distance means your position size should be…", options: ["Bigger", "Smaller, to keep the same dollar risk", "Unchanged", "Zero"], answerIndex: 1, rubyWhy: "A wider stop risks more per lot, so you size down to keep the same planned dollar loss." },
      { id: "s7q9", kind: "chart", prompt: "Your stop sits where the chart says…", options: ["You got lucky", "Your idea is wrong (invalidation)", "The spread widens", "Nothing"], answerIndex: 1, rubyWhy: "Place the stop at the price that proves your idea wrong — that defines your risk." },
      { id: "s7q10", kind: "chart", prompt: "A trade with target far closer than its stop has…", options: ["Great risk-to-reward", "Poor risk-to-reward", "No risk", "No spread"], answerIndex: 1, rubyWhy: "Risking a lot to gain a little is poor risk-to-reward — the math works against you." },
      { id: "s7q11", kind: "risk", prompt: "The FIRST question before a trade should be…", options: ["How rich will I get?", "How much can I lose if I'm wrong?", "What's the broker's mood?", "Which candle is prettiest?"], answerIndex: 1, rubyWhy: "Risk first. Knowing your downside is what keeps you in the game long-term." },
      { id: "s7q12", kind: "psychology", prompt: "After two losses you want to 'win it back fast' with a huge trade. This is…", options: ["Smart", "Revenge trading — dangerous", "Required", "Low risk"], answerIndex: 1, rubyWhy: "Sizing up to recover losses fast is revenge trading — it usually deepens the hole." },
    ],
  },
  {
    id: "step-8",
    number: 8,
    title: "Trading Styles: Scalping, Day, and Swing",
    subtitle: "Matching a style to your time, temperament, and risk",
    blurb: "Fast scalps to multi-day swings — and when not to trade at all.",
    lesson: [
      "Scalping aims for many small, fast moves with tight risk. Day trading opens and closes within a day. Swing trading holds for days to weeks, riding bigger moves. Position trading is even longer. Each demands different time, patience, and risk settings.",
      "Other approaches: trend trading follows direction, range trading fades a floor and ceiling, breakout trading enters on a level break, mean reversion bets on a snap-back. None is 'best' — the best is the one that fits you and that you can execute with discipline.",
      "Knowing when NOT to trade matters as much as knowing when to. No clean setup, major news incoming, or feeling tilted? Sitting out is a valid, professional decision.",
    ],
    ruby: {
      simple: "Scalping is a quick sprint; swing trading is a long walk. Pick the pace you can actually handle calmly.",
      normal: "This is a scalp idea, not a long trade. I'm looking for a quick move, tight risk, and a fast exit. If momentum slows, the scalp reason weakens.",
      pro: "Style selection is a function of holding horizon, volatility regime, and edge. A flame-scalp setup needs strong directional momentum, acceptable spread, defined structure, and a hard exit rule — momentum decay invalidates the thesis.",
    },
    vocab: [
      { term: "Scalping", meaning: "Many quick trades for small moves with tight risk." },
      { term: "Day trading", meaning: "Opening and closing within the same day." },
      { term: "Swing trading", meaning: "Holding for days to weeks for bigger moves." },
      { term: "Mean reversion", meaning: "Betting price snaps back to an average." },
      { term: "Flame scalp", meaning: "A fast-momentum scalp needing strong directional candles." },
    ],
    beginnerExample: "A flame scalp: strong fast candles in one direction, tight spread, a tight stop, and a quick exit when momentum fades — minutes, not days.",
    arxTieIn: "ARX's scanner highlights fast-momentum 'flame scalp' conditions, but still expects you to respect spread, structure, risk, and an exit rule.",
    practiceLabId: "lab-scalp-flame",
    quiz: [
      { id: "s8q1", kind: "beginner", prompt: "Scalping aims for…", options: ["Few huge multi-week trades", "Many small fast moves", "No trades at all", "Only news events"], answerIndex: 1, rubyWhy: "Scalping is about frequent small wins with tight risk and fast exits." },
      { id: "s8q2", kind: "beginner", prompt: "Swing trading typically holds for…", options: ["Seconds", "Days to weeks", "Years only", "Never holds"], answerIndex: 1, rubyWhy: "Swing trades ride larger moves over days to weeks." },
      { id: "s8q3", kind: "beginner", prompt: "Day trading means positions are…", options: ["Held for months", "Closed within the same day", "Never closed", "Only scalps"], answerIndex: 1, rubyWhy: "Day traders flatten positions by the day's end — nothing held overnight." },
      { id: "s8q4", kind: "beginner", prompt: "The 'best' trading style is…", options: ["Always scalping", "The one that fits you and you can execute", "Always swing", "Whatever a stranger says"], answerIndex: 1, rubyWhy: "Fit and discipline matter more than the label. The best style is the one you can run consistently." },
      { id: "s8q5", kind: "beginner", prompt: "A flame scalp needs…", options: ["Slow, flat candles", "Strong directional momentum", "No exit plan", "Max holding time"], answerIndex: 1, rubyWhy: "Flame scalps rely on strong, fast directional movement — and a quick exit." },
      { id: "s8q6", kind: "applied", prompt: "Momentum fades during your scalp. You should…", options: ["Hold for days", "Honor your exit rule", "Add more size", "Remove your stop"], answerIndex: 1, rubyWhy: "A scalp's reason is momentum. When it fades, the exit rule says it's time to go." },
      { id: "s8q7", kind: "applied", prompt: "Major news is seconds away and you have no edge. Best move?", options: ["Force a trade", "Consider not trading", "Use max leverage", "Remove stops"], answerIndex: 1, rubyWhy: "No edge plus high uncertainty equals a good time to stay out. Not trading is a position." },
      { id: "s8q8", kind: "applied", prompt: "You're calm, patient, and busy by day. A fitting style might be…", options: ["High-frequency scalping", "Swing trading", "Nothing works", "News scalping only"], answerIndex: 1, rubyWhy: "Swing trading suits those who can't watch screens all day and prefer fewer, larger setups." },
      { id: "s8q9", kind: "chart", prompt: "Strong fast candles in one direction favor a…", options: ["Mean-reversion fade", "Momentum/scalp idea", "No trade ever", "Range trade only"], answerIndex: 1, rubyWhy: "Powerful directional candles fit momentum and scalp ideas — with tight risk." },
      { id: "s8q10", kind: "chart", prompt: "Price stuck between a clear floor and ceiling suits…", options: ["Breakout entry only", "Range trading", "Position trading only", "No analysis"], answerIndex: 1, rubyWhy: "A defined floor and ceiling is range conditions — traders fade the edges with care." },
      { id: "s8q11", kind: "risk", prompt: "Scalping's fast pace makes which risk especially important?", options: ["Tight, pre-set stops and exits", "No stops", "Huge size", "Ignoring spread"], answerIndex: 0, rubyWhy: "Fast trades give little reaction time, so pre-set tight stops and exits are essential." },
      { id: "s8q12", kind: "psychology", prompt: "Overtrading — taking too many low-quality trades — usually comes from…", options: ["Patience", "Boredom or chasing action", "A solid plan", "Risk control"], answerIndex: 1, rubyWhy: "Overtrading is often boredom or FOMO in disguise. Quality beats quantity." },
    ],
  },
  {
    id: "step-9",
    number: 9,
    title: "Trading Psychology: How Traders Beat Themselves",
    subtitle: "Fear, greed, FOMO, revenge — and the journal that fixes them",
    blurb: "The market is hard; your emotions can make it harder. Here's the defense.",
    lesson: [
      "Fear makes you exit winners too early or skip good setups. Greed makes you oversize or hold too long. FOMO (fear of missing out) makes you chase moves that already happened. Revenge trading tries to 'win back' losses fast and usually deepens them.",
      "Other traps: overconfidence after a few wins, hesitation that misses planned entries, moving a stop-loss to avoid being wrong, and chasing candles after the move is gone.",
      "The cure is process: a written plan, pre-set risk, and a trading journal. Writing down why you entered, how you felt, and what happened turns emotional chaos into reviewable lessons.",
    ],
    ruby: {
      simple: "The hardest opponent isn't the market — it's your own feelings. A plan and a journal are how you win that fight.",
      normal: "The market is hard, but your own emotions can make it harder. A journal turns mistakes into lessons.",
      pro: "Behavioral biases — loss aversion, recency, overconfidence — systematically erode edge. A rules-based plan plus journaling externalizes decisions and creates a feedback loop for improvement.",
    },
    vocab: [
      { term: "FOMO", meaning: "Fear of missing out — chasing a move that already happened." },
      { term: "Revenge trading", meaning: "Trying to win back losses quickly, usually recklessly." },
      { term: "Overtrading", meaning: "Taking too many low-quality trades." },
      { term: "Trading journal", meaning: "A record of trades, reasons, and emotions for review." },
    ],
    beginnerExample: "You lose $2 on a planned trade, feel angry, and jump into a random $20 trade to 'get it back'. That's revenge trading — the journal would flag it.",
    arxTieIn: `ARX's Journal and Scalp Journal let you log trades and feelings. ${assistantName}'s coaching reads can point out patterns like overtrading without judging you.`,
    practiceLabId: "lab-psychology",
    quiz: [
      { id: "s9q1", kind: "beginner", prompt: "FOMO usually causes traders to…", options: ["Wait patiently", "Chase moves that already happened", "Use stops", "Journal more"], answerIndex: 1, rubyWhy: "FOMO pushes you to chase price after the good entry is gone — a classic trap." },
      { id: "s9q2", kind: "beginner", prompt: "Revenge trading is…", options: ["A solid strategy", "Trying to win back losses recklessly", "Using a stop-loss", "A type of candle"], answerIndex: 1, rubyWhy: "Revenge trading is emotional retaliation against a loss — it usually makes things worse." },
      { id: "s9q3", kind: "beginner", prompt: "A trading journal records…", options: ["Only profits", "Trades, reasons, and emotions", "The spread only", "Broker ads"], answerIndex: 1, rubyWhy: "A good journal captures what you did, why, and how you felt — fuel for improvement." },
      { id: "s9q4", kind: "beginner", prompt: "Greed often makes traders…", options: ["Cut winners early", "Oversize or hold too long", "Use small risk", "Journal trades"], answerIndex: 1, rubyWhy: "Greed tempts you to risk too much or overstay, turning wins into losses." },
      { id: "s9q5", kind: "beginner", prompt: "Moving your stop-loss further away to avoid a loss is…", options: ["Good discipline", "A dangerous emotional habit", "Required", "Risk-free"], answerIndex: 1, rubyWhy: "Dragging your stop turns a small planned loss into a big unplanned one." },
      { id: "s9q6", kind: "applied", prompt: "After 3 quick wins you feel unbeatable and size up huge. That's…", options: ["Overconfidence", "Discipline", "A journal entry", "Low risk"], answerIndex: 0, rubyWhy: "A hot streak breeds overconfidence — exactly when oversized trades tend to bite." },
      { id: "s9q7", kind: "applied", prompt: "You missed an entry and chase price 5 candles later. This is…", options: ["Patience", "FOMO / chasing", "Risk control", "A plan"], answerIndex: 1, rubyWhy: "Entering late because you couldn't bear to miss out is FOMO chasing." },
      { id: "s9q8", kind: "applied", prompt: "The best tool to reduce emotional trading is…", options: ["More leverage", "A written plan and journal", "Bigger size", "Removing stops"], answerIndex: 1, rubyWhy: "A plan decides in advance; a journal reviews honestly. Together they tame emotion." },
      { id: "s9q9", kind: "chart", prompt: "You feel you must trade every candle you see. Better to…", options: ["Trade them all", "Wait for your planned setup", "Use max size", "Remove stops"], answerIndex: 1, rubyWhy: "Not every candle is your setup. Waiting for your plan avoids overtrading." },
      { id: "s9q10", kind: "chart", prompt: "Price hit your stop exactly, then reversed. The right mindset is…", options: ["The stop was stupid", "Stops protect; one outcome isn't proof", "Never use stops again", "Revenge trade"], answerIndex: 1, rubyWhy: "A single stop-out that would've reversed doesn't make stops wrong — they protect you over many trades." },
      { id: "s9q11", kind: "risk", prompt: "Emotional trading most threatens…", options: ["Your discipline and risk rules", "The broker", "The spread", "The chart colors"], answerIndex: 0, rubyWhy: "Emotions push you to break your own risk rules — the very rules that keep you safe." },
      { id: "s9q12", kind: "psychology", prompt: "The healthiest response to a losing day is…", options: ["Trade bigger tomorrow to recover", "Review the journal and follow the plan", "Quit forever", "Blame the market"], answerIndex: 1, rubyWhy: "Calm review and sticking to your process beats emotional escalation every time." },
    ],
  },
  {
    id: "step-10",
    number: 10,
    title: "Build a Complete Trade Plan",
    subtitle: "Putting all 9 steps into one disciplined plan",
    blurb: `The capstone: assemble a full, written trade plan ${assistantName} can grade.`,
    lesson: [
      "A complete trade plan answers everything before you risk a cent: which market, which timeframe, and which direction. Then the precise levels: entry, stop-loss, and take-profit.",
      "Next, the risk: the dollar amount risked, the dollar reward aimed for, and the risk-to-reward ratio. Then the reasoning: why the trade makes sense, and — crucially — what would prove it wrong (your invalidation).",
      "Finally, the context: is it a scalp, day, or swing trade? What's your emotional state? Is there news risk? How confident are you, honestly? A plan you can write clearly is a plan you can follow calmly.",
    ],
    ruby: {
      simple: "A trade plan is your recipe before you cook. Write every ingredient down, and you won't panic halfway through.",
      normal: "A complete plan names the market, direction, entry, stop, target, risk, reward, reasoning, and what proves you wrong — before you click anything.",
      pro: "A robust plan specifies instrument, timeframe, thesis, entry trigger, invalidation, target, position size from fixed-fractional risk, R-multiple, regime classification, and a pre-committed management rule.",
    },
    vocab: [
      { term: "Entry", meaning: "The price where you plan to open the trade." },
      { term: "Invalidation", meaning: "The price/condition that proves the trade idea wrong." },
      { term: "R-multiple", meaning: "Reward expressed as multiples of the risk (e.g. 3R)." },
      { term: "Confidence rating", meaning: "Your honest read of how strong the setup is." },
    ],
    beginnerExample: "Market: EUR/USD. Direction: buy. Entry 1.1000, stop 1.0980 (risk 20 pips), target 1.1060 (reward 60 pips) = 1:3. Wrong if it closes below 1.0980. Style: day trade. Confidence: medium.",
    arxTieIn: `ARX's trade ticket mirrors this plan: symbol, direction, entry, stop, target. The final school project below has ${assistantName} grade a practice plan 0–100 — education only, not a profit promise.`,
    practiceLabId: "lab-trade-plan",
    quiz: [
      { id: "s10q1", kind: "beginner", prompt: "A trade plan should be written…", options: ["After the trade", "Before you open the trade", "Never", "Only if you lose"], answerIndex: 1, rubyWhy: "Planning before entry keeps emotion out of the decision. Writing it after is just a story." },
      { id: "s10q2", kind: "beginner", prompt: "Which belongs in a trade plan?", options: ["Entry, stop, target", "Only the entry", "Just a feeling", "The broker's logo"], answerIndex: 0, rubyWhy: "Entry, stop-loss, and take-profit are the backbone of any plan." },
      { id: "s10q3", kind: "beginner", prompt: "'Invalidation' means…", options: ["Where you take profit", "What proves the idea wrong", "The spread", "The trend"], answerIndex: 1, rubyWhy: "Invalidation is the price or condition that says 'this idea failed' — usually your stop." },
      { id: "s10q4", kind: "beginner", prompt: "Risk-to-reward in a plan compares…", options: ["Two brokers", "What you risk vs aim to gain", "Two candles", "Spread vs volume"], answerIndex: 1, rubyWhy: "R:R weighs the planned loss against the planned gain — core to plan quality." },
      { id: "s10q5", kind: "beginner", prompt: "Classifying a trade as scalp/day/swing helps set…", options: ["The right timeframe and expectations", "The broker fee", "The candle color", "Nothing"], answerIndex: 0, rubyWhy: "Style sets how long you hold and how you manage — it shapes the whole plan." },
      { id: "s10q6", kind: "applied", prompt: "Entry 100, stop 98, target 106. Risk-to-reward is…", options: ["1:3", "3:1", "1:1", "2:1"], answerIndex: 0, rubyWhy: "Risk is 2 (100→98), reward is 6 (100→106). That's 1:3." },
      { id: "s10q7", kind: "applied", prompt: "Your plan has no invalidation level. The plan is…", options: ["Complete", "Incomplete and risky", "Best practice", "Profitable"], answerIndex: 1, rubyWhy: "Without invalidation you don't know when you're wrong — a dangerous gap." },
      { id: "s10q8", kind: "applied", prompt: "You feel angry and rushed. Honest confidence should be…", options: ["Marked high", "Marked low / consider skipping", "Hidden", "Ignored"], answerIndex: 1, rubyWhy: "Emotional state belongs in the plan. Anger and rush lower real confidence — or mean don't trade." },
      { id: "s10q9", kind: "chart", prompt: "On the chart, your stop should align with…", options: ["A random pixel", "A structural invalidation level", "The screen edge", "The spread"], answerIndex: 1, rubyWhy: "Anchor the stop to structure — the level that genuinely proves the idea wrong." },
      { id: "s10q10", kind: "chart", prompt: "A plan's target should sit at a…", options: ["Random number", "Sensible level with room before resistance", "Negative price", "The entry"], answerIndex: 1, rubyWhy: "Targets work best at realistic levels the move can reach before hitting opposing pressure." },
      { id: "s10q11", kind: "risk", prompt: "Before the plan is done you must know your…", options: ["Dollar risk if wrong", "Lucky number", "Favorite candle", "The broker's address"], answerIndex: 0, rubyWhy: "Knowing your exact dollar risk is non-negotiable — it's what keeps you safe." },
      { id: "s10q12", kind: "psychology", prompt: "A plan you CAN'T explain simply usually means…", options: ["It's brilliant", "You don't fully understand the trade", "It will win", "The market is wrong"], answerIndex: 1, rubyWhy: "If you can't explain it plainly, the idea isn't clear yet — and unclear ideas are risky." },
    ],
  },
  ];
}

export const STEPS: LessonStep[] = buildSteps();

export const BADGES: Badge[] = [
  { id: "badge-market-basics", label: "Market Basics", earnedAfterStep: 1, note: "Completed the basics of how markets and price work." },
  { id: "badge-products", label: "Product Explorer", earnedAfterStep: 2, note: "Learned the main tradable markets and their behavior." },
  { id: "badge-order-master", label: "Order Master", earnedAfterStep: 3, note: "Understands order types and trade protection." },
  { id: "badge-candle-reader", label: "Candle Reader", earnedAfterStep: 4, note: "Can read basic candlestick body language." },
  { id: "badge-structure-reader", label: "Structure Reader", earnedAfterStep: 5, note: "Understands trend, support, and resistance." },
  { id: "badge-indicator-aware", label: "Indicator Aware", earnedAfterStep: 6, note: "Uses indicators as clues, not commands." },
  { id: "badge-risk-defender", label: "Risk Defender", earnedAfterStep: 7, note: "Understands position sizing and risk-to-reward." },
  { id: "badge-style-aware", label: "Style Aware", earnedAfterStep: 8, note: "Knows the main trading styles and when not to trade." },
  { id: "badge-psychology-discipline", label: "Psychology & Discipline", earnedAfterStep: 9, note: "Recognizes common emotional trading traps." },
  { id: "badge-trade-plan-builder", label: "Trade Plan Builder", earnedAfterStep: 10, note: "Can build a complete written trade plan." },
  { id: "badge-graduate", label: "ARX Trading School Graduate — Beginner", earnedAfterStep: 10, note: "Completed all 10 beginner steps. Education only — not a financial qualification or profit guarantee." },
];

export function buildPracticeLabs(assistantName: string = DEFAULT_ASSISTANT_NAME): PracticeLab[] {
  return [
  { id: "lab-risk-calculator", title: "Risk Calculator Lab", blurb: "Practice position sizing and risk-to-reward with live math.", status: "available" },
  { id: "lab-market-basics", title: "Market Basics Lab", blurb: "Spot buyer vs seller pressure in simple scenarios.", status: "coming-next" },
  { id: "lab-products", title: "Products Lab", blurb: "Match markets to their behavior and sessions.", status: "coming-next" },
  { id: "lab-entry-sl-tp", title: "Entry / SL / TP Drag Lab", blurb: "Drag entry, stop, and target onto a practice chart.", status: "coming-next" },
  { id: "lab-candle-reading", title: "Candle Reading Lab", blurb: "Identify bullish, bearish, and rejection candles.", status: "coming-next" },
  { id: "lab-support-resistance", title: "Support / Resistance Drawing Lab", blurb: "Draw reaction zones on a practice chart.", status: "coming-next" },
  { id: "lab-indicators", title: "Indicator Lab", blurb: "See how indicators react to price — without overloading.", status: "coming-next" },
  { id: "lab-scalp-flame", title: "Scalp Flame Lab", blurb: "Practice spotting fast-momentum scalp conditions.", status: "coming-next" },
  { id: "lab-psychology", title: "Psychology Mistake Lab", blurb: "Catch FOMO, revenge, and overtrading in scenarios.", status: "coming-next" },
  { id: "lab-trade-plan", title: "Full Trade Plan Lab", blurb: `Build a complete plan and have ${assistantName} grade it 0–100.`, status: "coming-next" },
  ];
}

export const PRACTICE_LABS: PracticeLab[] = buildPracticeLabs();

export const GLOSSARY: GlossaryEntry[] = [
  { term: "Ask", simple: "The price you can buy at right now.", example: "If the ask is 1.1002, that's what a buy costs.", relatedStep: 3 },
  { term: "Bid", simple: "The price you can sell at right now.", example: "If the bid is 1.1000, that's what a sell gets.", relatedStep: 3 },
  { term: "Spread", simple: "The small gap between the bid and ask — a trading cost.", example: "Ask 1.1002 − bid 1.1000 = 2 pip spread.", relatedStep: 3 },
  { term: "Pip", simple: "A standard small unit of price movement in Forex.", example: "1.1000 to 1.1001 is one pip.", relatedStep: 3 },
  { term: "Point", simple: "A small unit of price movement (often a fraction of a pip).", example: "Brokers may quote prices to an extra decimal point.", relatedStep: 3 },
  { term: "Tick", simple: "A single change in price, however small.", example: "Each time price updates, that's a tick.", relatedStep: 1 },
  { term: "Lot", simple: "A unit of trade size.", example: "0.01 lots is a small position.", relatedStep: 7 },
  { term: "Leverage", simple: "Controlling a bigger position with less money — magnifies wins and losses.", example: "Small deposit, larger market exposure.", relatedStep: 2 },
  { term: "Margin", simple: "The deposit a leveraged trade requires.", example: "Opening a trade locks some margin until you close.", relatedStep: 7 },
  { term: "Equity", simple: "Your balance including open trades.", example: "Balance $100 + open profit $5 = $105 equity.", relatedStep: 7 },
  { term: "Balance", simple: "Your account money, not counting open trades.", example: "After closing all trades, equity equals balance.", relatedStep: 7 },
  { term: "Drawdown", simple: "How far your account dropped from its peak.", example: "From $120 down to $100 is a $20 drawdown.", relatedStep: 7 },
  { term: "Candle", simple: "A bar showing open, high, low, and close for a period.", example: "One hourly candle covers one hour of price.", relatedStep: 4 },
  { term: "Wick", simple: "The thin line on a candle showing the high/low stretch.", example: "A long lower wick shows a rejected dip.", relatedStep: 4 },
  { term: "Support", simple: "A floor zone where buyers appeared before.", example: "Price bounced off 100 three times.", relatedStep: 5 },
  { term: "Resistance", simple: "A ceiling zone where sellers appeared before.", example: "Price got rejected at 110 repeatedly.", relatedStep: 5 },
  { term: "Breakout", simple: "Price pushing through a level and continuing.", example: "Closing firmly above resistance.", relatedStep: 5 },
  { term: "Fakeout", simple: "A false break that snaps back and traps traders.", example: "Pokes above resistance, then drops.", relatedStep: 5 },
  { term: "Trend", simple: "The general direction price is moving over time.", example: "Higher highs and higher lows = uptrend.", relatedStep: 5 },
  { term: "Range", simple: "Sideways price between a floor and ceiling.", example: "Bouncing between 100 and 110.", relatedStep: 5 },
  { term: "Liquidity", simple: "How easily you can buy or sell without moving price much.", example: "Major pairs are highly liquid.", relatedStep: 1 },
  { term: "Volatility", simple: "How fast and far price moves.", example: "News can spike volatility.", relatedStep: 1 },
  { term: "Slippage", simple: "Filling at a slightly different price than expected.", example: "Common in fast-moving markets.", relatedStep: 3 },
  { term: "Stop-loss", simple: "An order that auto-closes a losing trade to cap the loss.", example: "Buy at 100, stop at 98.", relatedStep: 3 },
  { term: "Take-profit", simple: "An order that auto-closes a winning trade at your target.", example: "Buy at 100, target at 106.", relatedStep: 3 },
  { term: "Risk-to-reward", simple: "What you risk compared to what you aim to gain.", example: "Risk $2 to make $6 = 1:3.", relatedStep: 7 },
  { term: "Scalping", simple: "Many quick trades for small moves with tight risk.", example: "In and out within minutes.", relatedStep: 8 },
  { term: "Day Trading", simple: "Opening and closing trades within the same day.", example: "Nothing held overnight.", relatedStep: 8 },
  { term: "Swing Trading", simple: "Holding trades for days to weeks.", example: "Riding a multi-day move.", relatedStep: 8 },
  { term: "News Event", simple: "A scheduled or surprise event that can move markets.", example: "Interest-rate announcements.", relatedStep: 9 },
  { term: "Economic Calendar", simple: "A schedule of upcoming market-moving events.", example: "Shows when big news is due.", relatedStep: 9 },
  { term: "Backtest", simple: "Testing an idea on past data.", example: "Checking how a setup would have done.", relatedStep: 6 },
  { term: "Forward Test", simple: "Testing an idea on live data going forward.", example: "Paper trading a setup in real time.", relatedStep: 6 },
  { term: "Entry", simple: "The price where you open a trade.", example: "Planned entry at 1.1000.", relatedStep: 10 },
  { term: "Exit", simple: "The price where you close a trade.", example: "Exit at target or stop.", relatedStep: 10 },
  { term: "Stop Order", simple: "An order that triggers once price reaches a level.", example: "Used to enter on breakouts.", relatedStep: 3 },
  { term: "Limit Order", simple: "An order that waits to fill at a chosen better price.", example: "Buy limit below current price.", relatedStep: 3 },
  { term: "Market Order", simple: "An order that fills right now at current price.", example: "Instant entry.", relatedStep: 3 },
  { term: "Position Size", simple: "How big your trade is, chosen to match your risk.", example: "Sized so a stop-out costs your planned risk.", relatedStep: 7 },
];

/** Education disclaimer shown across the school (woven in, not alarming). */
export function buildSchoolDisclaimer(assistantName: string = DEFAULT_ASSISTANT_NAME): string {
  return `Trading School teaches trading concepts for education only. It does not guarantee profit, income, or trading success. Trading involves risk, leverage can magnify losses, and past performance does not guarantee future results. Never trade money you cannot afford to lose. ${assistantName}'s lessons are for learning and decision support, not guaranteed financial outcomes.`;
}

export const SCHOOL_DISCLAIMER = buildSchoolDisclaimer();
