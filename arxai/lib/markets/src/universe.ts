// Canonical ARX Top 250 market universe (Task #412).
//
// The directory MUST be exactly this list. It is the single source of truth
// for every regular-user market surface and is NEVER derived from broker or
// provider output. Provider/broker discovery is only ever intersected
// against this list. Ranks are assigned sequentially (1–250) in the order
// the asset-class groups are declared below.

import type { ArxMarket, ArxAssetClass } from "./types.js";

interface Seed {
  standardSymbol: string;
  displayName: string;
  aliases?: string[];
  brokerAliases?: string[];
  providerSymbols?: string[];
}

function slug(standardSymbol: string): string {
  return standardSymbol
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

let rankCounter = 0;
function group(assetClass: ArxAssetClass, seeds: Seed[]): ArxMarket[] {
  return seeds.map((s) => {
    rankCounter += 1;
    return {
      id: slug(s.standardSymbol),
      standardSymbol: s.standardSymbol,
      displayName: s.displayName,
      assetClass,
      approved: true as const,
      rank: rankCounter,
      aliases: (s.aliases ?? []).map((a) => a.toLowerCase().trim()),
      brokerAliases: s.brokerAliases ?? [],
      providerSymbols: s.providerSymbols ?? [s.standardSymbol],
      hidden: false,
    };
  });
}

// ── forex_major (1–7) ──────────────────────────────────────────────────────
const FOREX_MAJOR = group("forex_major", [
  { standardSymbol: "EURUSD", displayName: "EUR/USD", aliases: ["euro dollar", "fiber", "euro"], providerSymbols: ["EURUSD", "EUR/USD"] },
  { standardSymbol: "GBPUSD", displayName: "GBP/USD", aliases: ["cable", "pound dollar", "sterling"], providerSymbols: ["GBPUSD", "GBP/USD"] },
  { standardSymbol: "USDJPY", displayName: "USD/JPY", aliases: ["dollar yen", "ninja"], providerSymbols: ["USDJPY", "USD/JPY"] },
  { standardSymbol: "USDCHF", displayName: "USD/CHF", aliases: ["swissy", "dollar swiss"], providerSymbols: ["USDCHF", "USD/CHF"] },
  { standardSymbol: "AUDUSD", displayName: "AUD/USD", aliases: ["aussie", "aussie dollar"], providerSymbols: ["AUDUSD", "AUD/USD"] },
  { standardSymbol: "NZDUSD", displayName: "NZD/USD", aliases: ["kiwi", "kiwi dollar"], providerSymbols: ["NZDUSD", "NZD/USD"] },
  { standardSymbol: "USDCAD", displayName: "USD/CAD", aliases: ["loonie", "dollar canada"], providerSymbols: ["USDCAD", "USD/CAD"] },
]);

// ── forex_cross (8–28) ─────────────────────────────────────────────────────
const FOREX_CROSS = group(
  "forex_cross",
  [
    { standardSymbol: "EURJPY", displayName: "EUR/JPY", aliases: ["euro yen"] },
    { standardSymbol: "GBPJPY", displayName: "GBP/JPY", aliases: ["beast", "geppy", "pound yen"] },
    { standardSymbol: "AUDJPY", displayName: "AUD/JPY", aliases: ["aussie yen"] },
    { standardSymbol: "NZDJPY", displayName: "NZD/JPY", aliases: ["kiwi yen"] },
    { standardSymbol: "CADJPY", displayName: "CAD/JPY" },
    { standardSymbol: "CHFJPY", displayName: "CHF/JPY" },
    { standardSymbol: "EURGBP", displayName: "EUR/GBP", aliases: ["chunnel", "euro pound"] },
    { standardSymbol: "EURCHF", displayName: "EUR/CHF" },
    { standardSymbol: "EURAUD", displayName: "EUR/AUD" },
    { standardSymbol: "EURNZD", displayName: "EUR/NZD" },
    { standardSymbol: "EURCAD", displayName: "EUR/CAD" },
    { standardSymbol: "GBPAUD", displayName: "GBP/AUD" },
    { standardSymbol: "GBPNZD", displayName: "GBP/NZD" },
    { standardSymbol: "GBPCAD", displayName: "GBP/CAD" },
    { standardSymbol: "GBPCHF", displayName: "GBP/CHF" },
    { standardSymbol: "AUDNZD", displayName: "AUD/NZD" },
    { standardSymbol: "AUDCAD", displayName: "AUD/CAD" },
    { standardSymbol: "AUDCHF", displayName: "AUD/CHF" },
    { standardSymbol: "NZDCAD", displayName: "NZD/CAD" },
    { standardSymbol: "NZDCHF", displayName: "NZD/CHF" },
    { standardSymbol: "CADCHF", displayName: "CAD/CHF" },
  ].map((s) => ({
    ...s,
    providerSymbols: [s.standardSymbol, `${s.standardSymbol.slice(0, 3)}/${s.standardSymbol.slice(3)}`],
  })),
);

// ── forex_exotic (29–55) ───────────────────────────────────────────────────
const FOREX_EXOTIC = group(
  "forex_exotic",
  [
    "USDTRY", "EURTRY", "GBPTRY", "USDZAR", "EURZAR", "GBPZAR", "USDSEK", "EURSEK",
    "USDNOK", "EURNOK", "USDMXN", "EURMXN", "USDPLN", "EURPLN", "USDHUF", "EURHUF",
    "USDCNH", "USDHKD", "USDSGD", "EURSGD", "GBPSGD", "AUDSGD", "USDTHB", "USDILS",
    "USDCLP", "USDINR", "USDKRW",
  ].map((sym) => ({
    standardSymbol: sym,
    displayName: `${sym.slice(0, 3)}/${sym.slice(3)}`,
    providerSymbols: [sym, `${sym.slice(0, 3)}/${sym.slice(3)}`],
  })),
);

// ── metal (56–65) ──────────────────────────────────────────────────────────
const METAL = group("metal", [
  { standardSymbol: "XAUUSD", displayName: "Gold (XAU/USD)", aliases: ["gold", "xau", "gold usd"], providerSymbols: ["XAUUSD", "XAU/USD"] },
  { standardSymbol: "XAGUSD", displayName: "Silver (XAG/USD)", aliases: ["silver", "xag", "silver usd"], providerSymbols: ["XAGUSD", "XAG/USD"] },
  { standardSymbol: "XPTUSD", displayName: "Platinum (XPT/USD)", aliases: ["platinum", "xpt"], providerSymbols: ["XPTUSD", "XPT/USD"] },
  { standardSymbol: "XPDUSD", displayName: "Palladium (XPD/USD)", aliases: ["palladium", "xpd"], providerSymbols: ["XPDUSD", "XPD/USD"] },
  { standardSymbol: "XAUEUR", displayName: "Gold (XAU/EUR)", aliases: ["gold euro"], providerSymbols: ["XAUEUR", "XAU/EUR"] },
  { standardSymbol: "XAGEUR", displayName: "Silver (XAG/EUR)", aliases: ["silver euro"], providerSymbols: ["XAGEUR", "XAG/EUR"] },
  { standardSymbol: "XAUGBP", displayName: "Gold (XAU/GBP)", aliases: ["gold pound"], providerSymbols: ["XAUGBP", "XAU/GBP"] },
  { standardSymbol: "XAUJPY", displayName: "Gold (XAU/JPY)", aliases: ["gold yen"], providerSymbols: ["XAUJPY", "XAU/JPY"] },
  { standardSymbol: "XAUCHF", displayName: "Gold (XAU/CHF)", providerSymbols: ["XAUCHF", "XAU/CHF"] },
  { standardSymbol: "XAUAUD", displayName: "Gold (XAU/AUD)", providerSymbols: ["XAUAUD", "XAU/AUD"] },
]);

// ── energy (66–72) ─────────────────────────────────────────────────────────
const ENERGY = group("energy", [
  { standardSymbol: "USOIL", displayName: "WTI Crude Oil (USOIL)", aliases: ["oil", "crude", "crude oil", "us oil", "wti oil"], providerSymbols: ["USOIL", "WTICOUSD", "CL"] },
  { standardSymbol: "UKOIL", displayName: "Brent Crude Oil (UKOIL)", aliases: ["oil", "crude", "crude oil", "uk oil", "brent oil"], providerSymbols: ["UKOIL", "BCOUSD", "BRN"] },
  { standardSymbol: "BRENT", displayName: "Brent Crude (BRENT)", aliases: ["brent"], providerSymbols: ["BRENT", "BCOUSD"] },
  { standardSymbol: "WTI", displayName: "WTI Crude (WTI)", aliases: ["wti"], providerSymbols: ["WTI", "WTICOUSD"] },
  { standardSymbol: "NATGAS", displayName: "Natural Gas", aliases: ["natural gas", "nat gas", "gas", "ngas"], providerSymbols: ["NATGAS", "NGAS", "NG"] },
  { standardSymbol: "GASOLINE", displayName: "Gasoline", aliases: ["gasoline", "rbob"], providerSymbols: ["GASOLINE", "RBOB"] },
  { standardSymbol: "HEATINGOIL", displayName: "Heating Oil", aliases: ["heating oil"], providerSymbols: ["HEATINGOIL", "HO"] },
]);

// ── index (73–90) ──────────────────────────────────────────────────────────
const INDEX = group("index", [
  { standardSymbol: "US30", displayName: "Dow Jones (US30)", aliases: ["dow", "djia", "dow jones", "us 30", "wall street", "dj30"], providerSymbols: ["US30", "DJI", "US30.cash"] },
  { standardSymbol: "US100", displayName: "Nasdaq 100 (US100)", aliases: ["nasdaq", "nas100", "ustec", "nas", "ndx", "us tech 100", "nasdaq 100", "tech 100"], providerSymbols: ["US100", "NAS100", "USTEC", "NDX", "US100.cash"] },
  { standardSymbol: "US500", displayName: "S&P 500 (US500)", aliases: ["spx", "sp500", "s&p", "s and p", "s&p 500", "spx500", "sp 500", "es"], providerSymbols: ["US500", "SPX500", "SPX", "US500.cash"] },
  { standardSymbol: "US2000", displayName: "Russell 2000 (US2000)", aliases: ["russell", "russell 2000", "rut"], providerSymbols: ["US2000", "RUT", "US2000.cash"] },
  { standardSymbol: "GER40", displayName: "DAX 40 (GER40)", aliases: ["dax", "ger 40", "germany 40", "de40", "dax 40"], providerSymbols: ["GER40", "DE40", "DAX", "GER40.cash"] },
  { standardSymbol: "UK100", displayName: "FTSE 100 (UK100)", aliases: ["ftse", "ftse 100", "footsie"], providerSymbols: ["UK100", "FTSE", "UK100.cash"] },
  { standardSymbol: "FRA40", displayName: "CAC 40 (FRA40)", aliases: ["cac", "cac 40", "france 40"], providerSymbols: ["FRA40", "CAC40", "FRA40.cash"] },
  { standardSymbol: "EU50", displayName: "Euro Stoxx 50 (EU50)", aliases: ["stoxx", "euro stoxx", "estx50", "eurostoxx"], providerSymbols: ["EU50", "STOXX50E", "EUSTX50"] },
  { standardSymbol: "JPN225", displayName: "Nikkei 225 (JPN225)", aliases: ["nikkei", "nikkei 225", "jp225", "japan 225"], providerSymbols: ["JPN225", "JP225", "NI225", "JPN225.cash"] },
  { standardSymbol: "AUS200", displayName: "ASX 200 (AUS200)", aliases: ["asx", "asx 200", "aus 200", "australia 200"], providerSymbols: ["AUS200", "ASX200", "AUS200.cash"] },
  { standardSymbol: "HK50", displayName: "Hang Seng (HK50)", aliases: ["hang seng", "hsi", "hong kong 50"], providerSymbols: ["HK50", "HSI", "HK50.cash"] },
  { standardSymbol: "CHINA50", displayName: "China A50 (CHINA50)", aliases: ["china a50", "a50", "china 50"], providerSymbols: ["CHINA50", "CN50", "A50"] },
  { standardSymbol: "SPA35", displayName: "IBEX 35 (SPA35)", aliases: ["ibex", "ibex 35", "spain 35"], providerSymbols: ["SPA35", "IBEX35", "ES35"] },
  { standardSymbol: "ITA40", displayName: "FTSE MIB (ITA40)", aliases: ["mib", "ftse mib", "italy 40"], providerSymbols: ["ITA40", "IT40", "MIB"] },
  { standardSymbol: "SWI20", displayName: "SMI 20 (SWI20)", aliases: ["smi", "swiss 20", "switzerland 20"], providerSymbols: ["SWI20", "CH20", "SMI"] },
  { standardSymbol: "NETH25", displayName: "AEX 25 (NETH25)", aliases: ["aex", "netherlands 25", "holland 25"], providerSymbols: ["NETH25", "NL25", "AEX"] },
  { standardSymbol: "SG30", displayName: "Straits Times (SG30)", aliases: ["straits times", "singapore 30", "sti"], providerSymbols: ["SG30", "STI"] },
  { standardSymbol: "INDIA50", displayName: "Nifty 50 (INDIA50)", aliases: ["nifty", "nifty 50", "india 50"], providerSymbols: ["INDIA50", "NIFTY", "IN50"] },
]);

// ── stock (91–170) ─────────────────────────────────────────────────────────
const STOCK = group(
  "stock",
  [
    ["AAPL", "Apple", "apple"],
    ["MSFT", "Microsoft", "microsoft"],
    ["NVDA", "NVIDIA", "nvidia"],
    ["AMZN", "Amazon", "amazon"],
    ["META", "Meta", "meta", "facebook", "fb"],
    ["GOOGL", "Alphabet Class A", "alphabet", "google"],
    ["GOOG", "Alphabet Class C", "alphabet c", "google c"],
    ["TSLA", "Tesla", "tesla"],
    ["AMD", "AMD", "advanced micro devices"],
    ["INTC", "Intel", "intel"],
    ["NFLX", "Netflix", "netflix"],
    ["AVGO", "Broadcom", "broadcom"],
    ["ORCL", "Oracle", "oracle"],
    ["CRM", "Salesforce", "salesforce"],
    ["ADBE", "Adobe", "adobe"],
    ["IBM", "IBM", "international business machines"],
    ["QCOM", "Qualcomm", "qualcomm"],
    ["MU", "Micron", "micron"],
    ["TXN", "Texas Instruments", "texas instruments"],
    ["CSCO", "Cisco", "cisco"],
    ["JPM", "JPMorgan Chase", "jpmorgan", "jp morgan"],
    ["BAC", "Bank of America", "bank of america", "bofa"],
    ["GS", "Goldman Sachs", "goldman sachs", "goldman"],
    ["MS", "Morgan Stanley", "morgan stanley"],
    ["WFC", "Wells Fargo", "wells fargo"],
    ["C", "Citigroup", "citigroup", "citi"],
    ["V", "Visa", "visa"],
    ["MA", "Mastercard", "mastercard"],
    ["AXP", "American Express", "american express", "amex"],
    ["PYPL", "PayPal", "paypal"],
    ["COIN", "Coinbase", "coinbase"],
    ["BLK", "BlackRock", "blackrock"],
    ["SCHW", "Charles Schwab", "charles schwab", "schwab"],
    ["CME", "CME Group", "cme group"],
    ["ICE", "Intercontinental Exchange", "intercontinental exchange"],
    ["WMT", "Walmart", "walmart"],
    ["COST", "Costco", "costco"],
    ["TGT", "Target", "target"],
    ["HD", "Home Depot", "home depot"],
    ["LOW", "Lowe's", "lowes", "lowe's"],
    ["MCD", "McDonald's", "mcdonalds", "mcdonald's"],
    ["SBUX", "Starbucks", "starbucks"],
    ["NKE", "Nike", "nike"],
    ["DIS", "Disney", "disney"],
    ["UBER", "Uber", "uber"],
    ["ABNB", "Airbnb", "airbnb"],
    ["SHOP", "Shopify", "shopify"],
    ["BABA", "Alibaba", "alibaba"],
    ["JD", "JD.com", "jd.com"],
    ["PDD", "PDD Holdings", "pinduoduo", "pdd holdings"],
    ["BA", "Boeing", "boeing"],
    ["CAT", "Caterpillar", "caterpillar"],
    ["DE", "Deere", "deere", "john deere"],
    ["GE", "General Electric", "general electric"],
    ["GM", "General Motors", "general motors"],
    ["F", "Ford", "ford"],
    ["RIVN", "Rivian", "rivian"],
    ["LCID", "Lucid", "lucid"],
    ["XOM", "ExxonMobil", "exxon", "exxonmobil"],
    ["CVX", "Chevron", "chevron"],
    ["COP", "ConocoPhillips", "conocophillips", "conoco"],
    ["SLB", "Schlumberger", "schlumberger"],
    ["HAL", "Halliburton", "halliburton"],
    ["OXY", "Occidental", "occidental"],
    ["ENPH", "Enphase", "enphase"],
    ["JNJ", "Johnson & Johnson", "johnson and johnson", "j&j"],
    ["PFE", "Pfizer", "pfizer"],
    ["MRK", "Merck", "merck"],
    ["ABBV", "AbbVie", "abbvie"],
    ["LLY", "Eli Lilly", "eli lilly", "lilly"],
    ["UNH", "UnitedHealth", "unitedhealth"],
    ["CVS", "CVS Health", "cvs", "cvs health"],
    ["TMO", "Thermo Fisher", "thermo fisher"],
    ["ISRG", "Intuitive Surgical", "intuitive surgical"],
    ["MRNA", "Moderna", "moderna"],
    ["KO", "Coca-Cola", "coca cola", "coke", "coca-cola"],
    ["PEP", "PepsiCo", "pepsi", "pepsico"],
    ["PG", "Procter & Gamble", "procter and gamble", "p&g"],
    ["MO", "Altria", "altria"],
    ["PM", "Philip Morris", "philip morris"],
  ].map(([sym, name, ...aliases]) => ({
    standardSymbol: sym,
    displayName: `${name} (${sym})`,
    aliases,
    providerSymbols: [sym],
  })),
);

// ── etf (171–190) ──────────────────────────────────────────────────────────
const ETF = group(
  "etf",
  [
    ["SPY", "S&P 500 ETF (SPY)", "spy"],
    ["QQQ", "Nasdaq 100 ETF (QQQ)", "qqq"],
    ["DIA", "Dow Jones ETF (DIA)", "dia"],
    ["IWM", "Russell 2000 ETF (IWM)", "iwm"],
    ["VOO", "Vanguard S&P 500 ETF (VOO)", "voo"],
    ["VTI", "Vanguard Total Market ETF (VTI)", "vti"],
    ["XLK", "Technology Sector ETF (XLK)", "xlk"],
    ["XLF", "Financial Sector ETF (XLF)", "xlf"],
    ["XLE", "Energy Sector ETF (XLE)", "xle"],
    ["XLY", "Consumer Discretionary ETF (XLY)", "xly"],
    ["XLP", "Consumer Staples ETF (XLP)", "xlp"],
    ["XLI", "Industrial Sector ETF (XLI)", "xli"],
    ["XLV", "Health Care Sector ETF (XLV)", "xlv"],
    ["XLU", "Utilities Sector ETF (XLU)", "xlu"],
    ["XLB", "Materials Sector ETF (XLB)", "xlb"],
    ["XLC", "Communication Services ETF (XLC)", "xlc"],
    ["ARKK", "ARK Innovation ETF (ARKK)", "arkk", "ark"],
    ["TQQQ", "ProShares UltraPro QQQ (TQQQ)", "tqqq"],
    ["SQQQ", "ProShares UltraPro Short QQQ (SQQQ)", "sqqq"],
    ["UVXY", "ProShares Ultra VIX ETF (UVXY)", "uvxy"],
  ].map(([sym, name, ...aliases]) => ({
    standardSymbol: sym,
    displayName: name,
    aliases,
    providerSymbols: [sym],
  })),
);

// ── crypto (191–220) ───────────────────────────────────────────────────────
const CRYPTO = group(
  "crypto",
  [
    ["BTCUSD", "Bitcoin (BTC/USD)", "btc", "bitcoin"],
    ["ETHUSD", "Ethereum (ETH/USD)", "eth", "ether", "ethereum"],
    ["SOLUSD", "Solana (SOL/USD)", "sol", "solana"],
    ["XRPUSD", "XRP (XRP/USD)", "xrp", "ripple"],
    ["BNBUSD", "BNB (BNB/USD)", "bnb", "binance coin"],
    ["ADAUSD", "Cardano (ADA/USD)", "ada", "cardano"],
    ["DOGEUSD", "Dogecoin (DOGE/USD)", "doge", "dogecoin"],
    ["AVAXUSD", "Avalanche (AVAX/USD)", "avax", "avalanche"],
    ["LINKUSD", "Chainlink (LINK/USD)", "link", "chainlink"],
    ["DOTUSD", "Polkadot (DOT/USD)", "dot", "polkadot"],
    ["LTCUSD", "Litecoin (LTC/USD)", "ltc", "litecoin"],
    ["BCHUSD", "Bitcoin Cash (BCH/USD)", "bch", "bitcoin cash"],
    ["XLMUSD", "Stellar (XLM/USD)", "xlm", "stellar"],
    ["TRXUSD", "TRON (TRX/USD)", "trx", "tron"],
    ["MATICUSD", "Polygon (MATIC/USD)", "matic", "polygon"],
    ["NEARUSD", "NEAR Protocol (NEAR/USD)", "near"],
    ["ATOMUSD", "Cosmos (ATOM/USD)", "atom", "cosmos"],
    ["UNIUSD", "Uniswap (UNI/USD)", "uni", "uniswap"],
    ["AAVEUSD", "Aave (AAVE/USD)", "aave"],
    ["FILUSD", "Filecoin (FIL/USD)", "fil", "filecoin"],
    ["ICPUSD", "Internet Computer (ICP/USD)", "icp", "internet computer"],
    ["ETCUSD", "Ethereum Classic (ETC/USD)", "etc", "ethereum classic"],
    ["ARBUSD", "Arbitrum (ARB/USD)", "arb", "arbitrum"],
    ["OPUSD", "Optimism (OP/USD)", "optimism"],
    ["SUIUSD", "Sui (SUI/USD)", "sui"],
    ["APTUSD", "Aptos (APT/USD)", "apt", "aptos"],
    ["INJUSD", "Injective (INJ/USD)", "inj", "injective"],
    ["RNDRUSD", "Render (RNDR/USD)", "rndr", "render"],
    ["FETUSD", "Fetch.ai (FET/USD)", "fet", "fetch", "fetch.ai"],
    ["PEPEUSD", "Pepe (PEPE/USD)", "pepe"],
  ].map(([sym, name, ...aliases]) => {
    const base = sym.replace(/USD$/, "");
    return {
      standardSymbol: sym,
      displayName: name,
      aliases,
      providerSymbols: [sym, `${base}USDT`, `${base}/USD`, `${base}/USDT`],
    };
  }),
);

// ── synthetic (221–244) ────────────────────────────────────────────────────
// standardSymbol = full Deriv display name. providerSymbols carry the short
// code + Deriv WS id + parenthesised broker variant so discovery intersects.
const SYNTHETIC = group(
  "synthetic",
  [
    ["Volatility 10 Index", "V10", "R_10", ["v10", "vol 10", "volatility 10"]],
    ["Volatility 10 1s Index", "V10_1S", "1HZ10V", ["v10 1s", "vol 10 1s", "volatility 10 1s"]],
    ["Volatility 25 Index", "V25", "R_25", ["v25", "vol 25", "volatility 25"]],
    ["Volatility 25 1s Index", "V25_1S", "1HZ25V", ["v25 1s", "vol 25 1s", "volatility 25 1s"]],
    ["Volatility 50 Index", "V50", "R_50", ["v50", "vol 50", "volatility 50"]],
    ["Volatility 50 1s Index", "V50_1S", "1HZ50V", ["v50 1s", "vol 50 1s", "volatility 50 1s"]],
    ["Volatility 75 Index", "V75", "R_75", ["v75", "vol 75", "volatility 75"]],
    ["Volatility 75 1s Index", "V75_1S", "1HZ75V", ["v75 1s", "vol 75 1s", "volatility 75 1s"]],
    ["Volatility 100 Index", "V100", "R_100", ["v100", "vol 100", "volatility 100"]],
    ["Volatility 100 1s Index", "V100_1S", "1HZ100V", ["v100 1s", "vol 100 1s", "volatility 100 1s"]],
    ["Volatility 150 1s Index", "V150_1S", "1HZ150V", ["v150 1s", "vol 150 1s", "volatility 150 1s"]],
    ["Volatility 250 1s Index", "V250_1S", "1HZ250V", ["v250 1s", "vol 250 1s", "volatility 250 1s"]],
    ["Boom 300 Index", "BOOM300", "BOOM300N", ["boom 300"]],
    ["Boom 500 Index", "BOOM500", "BOOM500N", ["boom 500"]],
    ["Boom 1000 Index", "BOOM1000", "BOOM1000N", ["boom 1000"]],
    ["Crash 300 Index", "CRASH300", "CRASH300N", ["crash 300"]],
    ["Crash 500 Index", "CRASH500", "CRASH500N", ["crash 500"]],
    ["Crash 1000 Index", "CRASH1000", "CRASH1000N", ["crash 1000"]],
    ["Jump 10 Index", "JUMP10", "JD10", ["jump 10"]],
    ["Jump 25 Index", "JUMP25", "JD25", ["jump 25"]],
    ["Jump 50 Index", "JUMP50", "JD50", ["jump 50"]],
    ["Jump 75 Index", "JUMP75", "JD75", ["jump 75"]],
    ["Jump 100 Index", "JUMP100", "JD100", ["jump 100"]],
    ["Step Index", "STEP", "stpRNG", ["step", "step index"]],
  ].map(([name, code, derivId, aliases]) => {
    const display = name as string;
    const brokerParen = display.replace(/ 1s Index$/, " (1s) Index");
    const brokerAliases = brokerParen !== display ? [brokerParen] : [];
    return {
      standardSymbol: display,
      displayName: display,
      aliases: aliases as string[],
      brokerAliases,
      providerSymbols: [display, code as string, derivId as string, ...brokerAliases],
    };
  }),
);

// ── commodity (245–250) ────────────────────────────────────────────────────
const COMMODITY = group("commodity", [
  { standardSymbol: "COPPER", displayName: "Copper", aliases: ["copper", "hg"], providerSymbols: ["COPPER", "HG", "XCUUSD"] },
  { standardSymbol: "COCOA", displayName: "Cocoa", aliases: ["cocoa"], providerSymbols: ["COCOA", "CC"] },
  { standardSymbol: "COFFEE", displayName: "Coffee", aliases: ["coffee"], providerSymbols: ["COFFEE", "KC"] },
  { standardSymbol: "SUGAR", displayName: "Sugar", aliases: ["sugar"], providerSymbols: ["SUGAR", "SB"] },
  { standardSymbol: "WHEAT", displayName: "Wheat", aliases: ["wheat"], providerSymbols: ["WHEAT", "ZW"] },
  { standardSymbol: "CORN", displayName: "Corn", aliases: ["corn"], providerSymbols: ["CORN", "ZC"] },
]);

/** The canonical, fixed approved universe — exactly 250 markets. */
export const ARX_TOP_250: ArxMarket[] = [
  ...FOREX_MAJOR,
  ...FOREX_CROSS,
  ...FOREX_EXOTIC,
  ...METAL,
  ...ENERGY,
  ...INDEX,
  ...STOCK,
  ...ETF,
  ...CRYPTO,
  ...SYNTHETIC,
  ...COMMODITY,
];
