/** Offline data hooks for the existing shared Scanner fixture. The stock JSON
 * is an immutable synthetic provider response normalized through the backend;
 * mutations below are client robustness probes, not new producer evidence. */
export function createStockProfileFixture(stock) {
  if (!stock?.fixtureOnly || stock.data?.symbol !== 'AAPL' || stock.data?.timeframe !== 'M15' || stock.data?.candles?.length !== 200) throw Error('Expected original offline AAPL M15 fixture');
  let variant = 'original', basisQualified = true;
  const variants = ['original','quantity','withdrawn','series','mismatch','clock','finality','forming'];
  return {
    initialSource: 'mt5_broker', initialIdentity: 'a'.repeat(64),
    async install(page) {
      await page.exposeFunction('__fixtureSetVariant', next => { if (!variants.includes(next)) throw Error('Unknown QA variant'); variant = next; return true; });
      await page.exposeFunction('__fixtureRevokeBasis', () => { basisQualified = false; return true; });
    },
    readResponse({path}) {
      if (path === '/api/me/assistant/conversations') return {conversations:[{id:900007,title:'Offline local chart commands',archivedAt:null}]};
      if (path === '/api/me/assistant/conversations/900007') return {conversation:{id:900007,title:'Offline local chart commands'},messages:[]};
      return undefined;
    },
    candleMetadata() { return {variant}; },
    candleResponse({symbol,timeframe,fallback}) {
      if (symbol !== 'AAPL') {
        // Explicitly constructed tick-only primary. This does not qualify a
        // live MT5 provider, UTC clock, traded volume or research coverage.
        const payload = structuredClone(fallback);
        payload.quality = 'clean'; payload.feedStatus.quality = 'clean';
        payload.candles = payload.candles.map((bar,i) => ({...bar,
          volumeEvidence:i%7===0?{kind:'unavailable',quantity:null,unit:null,reason:'Offline test missing count'}:{kind:'tick_count',quantity:i%5===0?0:10+i,unit:'ticks',reason:null},
          sourceMode:'demo',priceBasis:'BID',priceBasisEvidence:basisQualified?{kind:'producer_declared',basis:'BID',reason:null}:undefined,isForming:false,qualityFlags:[],
        }));
        return payload;
      }
      if (timeframe !== 'M15') return {symbol,displaySymbol:symbol,timeframe,source:'unknown',quality:'unavailable',aiUsable:false,candles:[],candleCount:0,feedStatus:{symbol,source:'unknown',quality:'unavailable',isLive:false,aiUsable:false,stale:true,message:'Offline fixture has no candles for this additional context'},marketEvidence:null};
      const payload = structuredClone(stock.data), middle = payload.candles[100];
      if (variant === 'quantity') { middle.volumeEvidence.quantity *= 2; middle.volume *= 2; }
      if (variant === 'withdrawn') middle.volumeEvidence = {kind:'unavailable',quantity:null,unit:null,reason:'Synthetic normalized-response withdrawal: quantity unqualified'};
      if (variant === 'series') for (const bar of payload.candles) if (bar.volumeEvidence?.kind === 'real_volume') bar.volumeEvidence.seriesIdentity = 'b'.repeat(64);
      if (variant === 'mismatch') payload.symbol = 'MSFT';
      if (variant === 'clock') for (const bar of payload.candles) delete bar.timeBasisEvidence;
      if (variant === 'finality') { middle.isComplete=false; middle.isFinal=false; middle.isForming=false; middle.qualityFlags=['FORMING_BAR']; }
      if (variant === 'forming') { const tail=payload.candles.at(-1); tail.isComplete=false; tail.isFinal=false; tail.isForming=false; tail.qualityFlags=['FORMING_BAR']; }
      return payload;
    },
  };
}
