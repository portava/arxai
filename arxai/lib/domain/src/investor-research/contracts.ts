import { z } from "zod";
export const symbolSchema = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9.-]{0,9}$/);
export const moneySchema = z.number().finite().min(0).max(1e12);
export const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s, "Invalid calendar date");
export const timeSchema = z.string().datetime({ offset: true });
export const researchAuthority = {
  evidenceClass: "RESEARCH_ONLY", executionAllowed: false, direction: "NOT_ESTABLISHED",
  probability: null, sourceVerified: false,
  note: "Research calculations are not broker quotes, calibrated predictions or trade approval.",
} as const;
export const policySchema = z.object({
  cashBufferPct: z.number().min(0).max(100), maxPositionPct: z.number().positive().max(100),
  minOrder: moneySchema, maxOrder: moneySchema.positive(), driftBandPct: z.number().min(0).max(100),
  blocked: z.array(symbolSchema).max(500).default([]),
}).strict().refine(p => p.maxOrder >= p.minOrder, "Maximum order must be at least minimum order");
export const holdingSchema = z.object({ symbol: symbolSchema, value: moneySchema }).strict();
export const targetSchema = z.object({ symbol: symbolSchema, weight: z.number().finite().positive().max(100) }).strict();
export const planSchema = z.object({
  cash: moneySchema, holdings: z.array(holdingSchema).max(500), targets: z.array(targetSchema).min(1).max(500),
  policy: policySchema, asOf: timeSchema, currency: z.literal("USD"),
  mode: z.enum(["allocate", "rebalance"]),
}).strict().superRefine((p, ctx) => {
  for (const key of ["holdings", "targets"] as const) if (new Set(p[key].map(r => r.symbol)).size !== p[key].length)
    ctx.addIssue({ code: "custom", path: [key], message: "Duplicate symbols are not allowed" });
  if (p.mode === "allocate" && p.holdings.length) ctx.addIssue({ code: "custom", path: ["holdings"], message: "Use rebalance for existing holdings" });
});
export type PortfolioPlanInput = z.infer<typeof planSchema>;
export const orderSchema = z.object({ symbol: symbolSchema, side: z.enum(["buy", "sell"]), amount: moneySchema.positive() }).strict();
export const basketSchema = z.object({
  cash: moneySchema, holdings: z.array(holdingSchema).max(500), orders: z.array(orderSchema).min(1).max(500),
  policy: policySchema, asOf: timeSchema, currency: z.literal("USD"),
}).strict().refine(p => new Set(p.holdings.map(h => h.symbol)).size === p.holdings.length, "Duplicate holdings");
export const metricNames = ["revenue", "grossProfit", "grossMarginPct", "netIncome", "operatingIncome", "dilutedEps", "netMarginPct", "operatingMarginPct", "revenueGrowthPct"] as const;
export const screenSchema = z.object({
  companies: z.array(z.object({ symbol: symbolSchema, periodEnd: daySchema, filed: daySchema, periodKind: z.enum(["QUARTER", "ANNUAL", "UNKNOWN"]).default("UNKNOWN"),
    metrics: z.record(z.string(), z.number().finite().nullable()), sourceUrl: z.string().url(),
  }).strict()).min(1).max(500),
  rules: z.array(z.object({ metric: z.enum(metricNames), op: z.enum([">=", "<="]), value: z.number().finite() }).strict()).min(1).max(20),
  asOf: daySchema,
}).strict();
export const lotSchema = z.object({ id: z.string().min(1).max(80), symbol: symbolSchema, acquired: daySchema,
  shares: z.number().finite().positive().max(1e12), totalBasis: moneySchema,
}).strict();
export const lotPreviewSchema = z.object({
  lots: z.array(lotSchema).min(1).max(1000), symbol: symbolSchema, shares: z.number().finite().positive(),
  price: z.number().finite().positive().max(1e12), method: z.enum(["FIFO", "HIFO"]), saleDate: daySchema,
}).strict().refine(p => new Set(p.lots.map(l => l.id)).size === p.lots.length, "Duplicate lot IDs");
export const disclosureSchema = z.object({
  rows: z.array(z.object({ id: z.string().min(1).max(80), person: z.string().min(1).max(120), owner: z.string().min(1).max(80),
    symbol: symbolSchema.nullable(), assetType: z.enum(["shares", "options", "other"]), action: z.enum(["buy", "sell", "other"]),
    tradeDate: daySchema, filed: daySchema, amountMin: moneySchema, amountMax: moneySchema.nullable(), sourceUrl: z.string().url(),
  }).strict()).min(1).max(1000), asOf: daySchema,
}).strict();
export const holdingsDisclosureSchema = z.object({
  filer: z.string().min(1).max(120), periodEnd: daySchema, filed: daySchema, asOf: daySchema, sourceUrl: z.string().url(),
  rows: z.array(z.object({ id: z.string().min(1).max(80), symbol: symbolSchema.nullable(),
    value: moneySchema, securityType: z.enum(["shares", "put", "call", "other"]),
  }).strict()).min(1).max(10000),
}).strict();
export const alertPreviewSchema = z.object({
  now: timeSchema, observations: z.array(z.object({symbol: symbolSchema, price: z.number().finite().positive(), asOf: timeSchema,
    source: z.string().min(1).max(120), delayed: z.boolean(),
  }).strict()).max(500),
  rules: z.array(z.object({ id: z.string().min(1).max(80), symbol: symbolSchema,
    direction: z.enum(["above", "below"]), threshold: z.number().finite().positive(), alreadyTriggered: z.boolean(),
  }).strict()).max(500),
}).strict();
