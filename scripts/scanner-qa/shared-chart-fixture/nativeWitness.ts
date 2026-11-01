// Offline QA only. Observe the real native viewport's applied immutable data;
// never infer completion from React state or the input passed to setCandles.
export function installNativeChartWitness(Adapter: { prototype: any }): () => void {
  const prototype = Adapter.prototype;
  const original = {init:prototype.init,destroy:prototype.destroy,setCandles:prototype.setCandles,updateActiveCandle:prototype.updateActiveCandle};
  const registry = new Map<HTMLElement, any>(), containers = new WeakMap<object,HTMLElement>();
  const revisions = new WeakMap<object,number>(), ids = new WeakMap<object,number>();
  let sequence = 0;
  const id = (value:object|null|undefined) => {if(!value)return null;let n=ids.get(value);if(n===undefined){n=++sequence;ids.set(value,n);}return n;};
  const bar = (value:any) => value ? {time:value.time,open:value.open,high:value.high,low:value.low,close:value.close} : null;
  prototype.init = function(options:any) {
    const result=original.init.call(this,options);
    containers.set(this,options.container);registry.set(options.container,this);return result;
  };
  prototype.destroy=function(...args:any[]) {const container=containers.get(this);try{return original.destroy.apply(this,args);}finally{if(container&&registry.get(container)===this)registry.delete(container);containers.delete(this);}};
  for(const method of ['setCandles','updateActiveCandle'] as const)prototype[method]=function(...args:any[]){revisions.set(this,(revisions.get(this)??0)+1);return original[method].apply(this,args);};
  const find=(index=0)=>{const container=document.querySelectorAll<HTMLElement>('[data-testid="arx-native-canvas"]')[index];const adapter=container&&registry.get(container);return adapter?.viewport?{container,adapter,viewport:adapter.viewport}:null;};
  const api={
    schemaVersion:2,engine:'arx-native',
    snapshot(index=0){const found=find(index);if(!found)return null;const {container,adapter,viewport}=found,frame=viewport.getFrame(),state=viewport.getState(),candles=viewport.getCandles(),range=viewport.getRange(),bounds=container.getBoundingClientRect();
      return {adapterId:id(adapter),containerId:id(container),chartId:id(viewport),canvasIds:[...container.querySelectorAll('canvas')].map(id),dataRevision:revisions.get(adapter)??0,
        barCount:candles.length,first:bar(candles[0]),last:bar(candles.at(-1)),range:range?{...range}:null,state,
        symbol:adapter.symbol,intervalSeconds:adapter.interval,feed:adapter.feed?{...adapter.feed}:null,
        visibleTimeRange:frame?{from:candles[frame.first]?.time,to:candles[frame.last]?.time}:null,
        bounds:{x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height}};
    },
    data(index=0){const found=find(index);if(!found)return null;return {canonical:found.viewport.getCandles().map(bar),visible:found.adapter.getVisibleCandles().map(bar)};},
    anchorCoordinates(time:number,price:number,index=0){const found=find(index),frame=found?.viewport.getFrame();if(!found||!frame)return null;const x=frame.timeToX(time),y=frame.priceToY(price);if(x==null||y==null)return null;const box=found.container.getBoundingClientRect();return{x:box.x+x,y:box.y+y};},
    configuration(index=0){const found=find(index);if(!found)return null;const state=found.viewport.getState();return{analysisFocus:{enabled:found.adapter.isAnalysisFocused(),verified:found.adapter.isAnalysisFocusVerified()},scale:{mode:state.scale,inverted:state.inverted},studies:found.viewport.getStudies(),drawings:found.viewport.getDrawings()};},
  };
  (window as any).__arxChartQa=api;
  return()=>{for(const method of Object.keys(original) as (keyof typeof original)[])prototype[method]=original[method];registry.clear();if((window as any).__arxChartQa===api)delete(window as any).__arxChartQa;};
}
