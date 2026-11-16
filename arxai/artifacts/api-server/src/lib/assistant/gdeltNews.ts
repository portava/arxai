import type { NewsItem } from "./marketProvider.js";

// Public DOC API: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/
export const GDELT_DOC_URL = "https://api.gdeltproject.org/api/v2/doc/doc";
export const gdeltEnabled = () => process.env.ARX_GDELT_ENABLED === "true";
export interface GdeltNewsResult {
  connected: boolean; items: NewsItem[]; provider: "gdelt";
  fetchedAt: string | null; error: string | null;
}
const broad = /^(markets?|general|global|economy|forex|business|news)?$/i;
export function gdeltQuery(input: string): string {
  const clean = input.trim().replace(/[^a-zA-Z0-9 .\/-]/g, " ").replace(/\s+/g, " ").slice(0, 80);
  return broad.test(clean)
    ? '("central bank" OR "interest rates" OR inflation OR "foreign exchange" OR "stock market" OR "oil prices") sourcelang:english'
    : `"${clean || "financial markets"}" (finance OR economy OR market) sourcelang:english`;
}
function seenAt(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{8}T\d{6}Z$/.test(value)) return null;
  const iso = `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T${value.slice(9,11)}:${value.slice(11,13)}:${value.slice(13,15)}.000Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && new Date(ms).toISOString() === iso ? iso : null;
}
export function normalizeGdeltNews(payload: unknown, nowMs: number): NewsItem[] {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as {articles?:unknown}).articles)) throw new Error("GDELT_INVALID_PAYLOAD");
  const articles = (payload as {articles: unknown[]}).articles;
  const items: NewsItem[] = []; const urls = new Set<string>();
  for (const row of articles) {
    if (!row || typeof row !== "object") continue;
    const a = row as Record<string, unknown>;
    if (typeof a.title !== "string" || !a.title.trim() || typeof a.url !== "string") continue;
    let url: URL; try { url = new URL(a.url); } catch { continue; }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;
    const observedAt = seenAt(a.seendate);
    if (!observedAt || Date.parse(observedAt) > nowMs + 60_000 || nowMs-Date.parse(observedAt) > 26*3600_000) continue;
    url.hash = ""; if (urls.has(url.href)) continue; urls.add(url.href);
    items.push({headline:a.title.trim().slice(0,1000),url:url.href,publishedAt:"",source:url.hostname,
      observedAt,timeBasis:"provider_first_seen",aggregator:"gdelt"});
  }
  if (articles.length && !items.length) throw new Error("GDELT_NO_VALID_ARTICLES");
  return items.sort((a,b)=>b.observedAt!.localeCompare(a.observedAt!));
}
export function createGdeltNewsClient(fetcher: typeof fetch = (...args)=>fetch(...args), clock = Date.now) {
  const cache = new Map<string,{at:number;result:GdeltNewsResult}>();
  const inflight = new Map<string,Promise<GdeltNewsResult>>();
  let nextRequestAt = 0; let busy = false;
  const unavailable = (error:string):GdeltNewsResult=>({connected:false,items:[],provider:"gdelt",fetchedAt:null,error});
  return async (query:string,limit=12):Promise<GdeltNewsResult> => {
    const q=gdeltQuery(query); const count=Math.max(1,Math.min(50,Number.isFinite(limit)?Math.floor(limit):12));
    const cacheKey=q+":"+count; const prior=cache.get(cacheKey); const now=clock();
    if(prior && now-prior.at>=0 && now-prior.at<300_000) return prior.result;
    const pending=inflight.get(cacheKey); if(pending) return pending;
    if(busy || now<nextRequestAt) return unavailable("GDELT_BACKOFF");
    busy=true; nextRequestAt=now+6_000;
    const task=(async()=>{
      try {
        const url=new URL(GDELT_DOC_URL);
        for(const [k,v] of Object.entries({query:q,mode:"artlist",format:"json",timespan:"24h",sort:"datedesc",maxrecords:String(count)})) url.searchParams.set(k,v);
        const response=await fetcher(url.href,{signal:AbortSignal.timeout(12_000)});
        if(!response.ok){
          const retry=response.headers.get("retry-after"); const numeric=retry===null?NaN:Number(retry);
          const retryMs=Number.isFinite(numeric)?numeric*1000:retry?Date.parse(retry)-clock():0;
          nextRequestAt=clock()+Math.max(response.status===429?600_000:60_000,Number.isFinite(retryMs)?retryMs:0);
          return unavailable(`GDELT_HTTP_${response.status}`);
        }
        const items=normalizeGdeltNews(await response.json(),clock()).slice(0,count);
        const at=clock(); const result:GdeltNewsResult={connected:true,items,provider:"gdelt",fetchedAt:new Date(at).toISOString(),error:null};
        cache.set(cacheKey,{at,result}); if(cache.size>64) cache.delete(cache.keys().next().value!);
        return result;
      } catch { nextRequestAt=clock()+60_000; return unavailable("GDELT_REQUEST_OR_PAYLOAD_FAILED"); }
      finally { busy=false; inflight.delete(cacheKey); }
    })();
    inflight.set(cacheKey,task); return task;
  };
}
let client=createGdeltNewsClient();
export const getGdeltNews=(query:string,limit?:number)=>client(query,limit);
export const resetGdeltNewsForTests=()=>{client=createGdeltNewsClient();};
