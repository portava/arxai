import type { ChartEngineCandle } from "../../../artifacts/trading-dashboard/src/lib/chart-engine/types";
import type { ChartStudy } from "../../../artifacts/trading-dashboard/src/lib/chart-engine/chartStudies";

/** Isolated adapter workload, never loaded by the application entry. Evidence
 * below is constructed test metadata, not a provider qualification receipt. */
export function installVolumeProfileProbe(Adapter: new () => any) {
  const authority = "twelve-data:time-series:common-stock:regular-unadjusted:v1";
  const identity = "c".repeat(64);
  const root = document.createElement("main");
  root.style.cssText = "padding:12px;background:#090d14;color:#e2e8f0;min-height:100vh";
  const heading = document.createElement("p");
  heading.textContent = "OFFLINE ADAPTER BENCHMARK — constructed bars and evidence; no API, provider, broker or market qualification";
  const chart = document.createElement("div");
  chart.dataset.testid = "arx-native-canvas";
  chart.style.cssText = "width:1100px;max-width:95vw;height:600px";
  root.append(heading, chart); document.body.append(root);
  const adapter = new Adapter();
  adapter.init({container:chart,height:600});
  let bars: ChartEngineCandle[] = [];
  let rows = 32;
  let companions: ChartStudy[] = [];
  const config = (): ChartStudy => ({
    id:"offline-profile",kind:"volume_profile",period:1,color:"#38bdf8",
    profileRows:rows,profileValueAreaPercent:70,
    profileRange:{kind:"observed_range",fromTime:bars[0]!.time,toTime:bars.at(-1)!.time,seriesIdentity:identity,clockAuthority:authority},
  });
  Object.defineProperty(window, "__arxVolumeProfileProbe", {value:{
    configure(count:number, rowCount=32, withCompanions=false) {
      if (![200,1000,5000].includes(count) || ![32,128].includes(rowCount)) throw Error("Unsupported benchmark workload");
      rows=rowCount;
      companions=withCompanions ? [
        {id:"probe-sma",kind:"sma",period:20,color:"#fbbf24"},
        {id:"probe-ema",kind:"ema",period:50,color:"#38bdf8"},
        {id:"probe-rsi",kind:"rsi",period:14,color:"#e879f9"},
        {id:"probe-macd",kind:"macd",period:12,slow:26,signal:9,color:"#2dd4bf"},
      ] : [];
      bars=Array.from({length:count},(_,i)=>{
        const close=100+i*.002+Math.sin(i/13)*2,open=close+Math.cos(i/7)*.2;
        return {time:1767355200+i*900,open,high:Math.max(open,close)+.3,low:Math.min(open,close)-.3,close,
          volumeEvidence:{kind:"real_volume",quantity:1000+i%197,unit:"provider_trade_units",reason:null,authority,seriesIdentity:identity},
          profileEvidence:{finality:"closed",clockAuthority:authority}};
      });
      adapter.setStudies([]);adapter.setFeedState({source:"assistant_real:twelve_data",livePriceAffordance:false});
      adapter.setSymbol?.("OFFLINE_CONSTRUCTED_STOCK");adapter.setTimeframe?.("M15");
      adapter.setCandles(bars);adapter.setStudies(companions);adapter.resetScale();
      return {count,rows,companions:companions.length,first:bars[0]!.time,last:bars.at(-1)!.time};
    },
    show(on:boolean) {if(!bars.length)throw Error("Configure first");adapter.setStudies(on?[...companions,config()]:companions);},
    hide(hidden:boolean) {adapter.setStudies([...companions,{...config(),lineStyles:[{visible:!hidden}]}]);},
    changeRows(rowCount:number) {if(![32,128].includes(rowCount))throw Error("Unsupported row count");rows=rowCount;adapter.setStudies([...companions,config()]);},
    view(mode:"latest"|"full") {if(mode==="full")adapter.fitHistory();else if(mode==="latest")adapter.resetScale();else throw Error("Unsupported view");},
    pan(direction:number) {if(direction!==-1&&direction!==1)throw Error("Direction required");adapter.panBy(direction*.05);},
    correctQuantity() {
      if(!bars.length)throw Error("Configure first");
      const i=bars.length-1,last=bars[i]!;
      bars=[...bars.slice(0,i),{...last,volumeEvidence:{...last.volumeEvidence!,quantity:last.volumeEvidence!.quantity!+1}}];
      adapter.setCandles(bars);
    },
    inspect() {return {bars:bars.length,rows,profiles:adapter.getVolumeProfiles?.()??[],range:adapter.chart?.timeScale().getVisibleLogicalRange()};},
    dispose() {adapter.destroy();root.remove();},
  },writable:false,configurable:false});
}
