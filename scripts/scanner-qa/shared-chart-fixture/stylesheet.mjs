import path from 'node:path';

// Tailwind uses Vite's root as its default candidate-scanning base. This
// fixture's root contains no application JSX; explicitly include the real
// dashboard source without editing the shipped stylesheet or class names.
export function dashboardStyleSourcePlugin(dashboard) {
  const stylesheet=path.join(dashboard,'src/index.css');
  const source=path.join(dashboard,'src').split(path.sep).join('/');
  return {name:'arx-scanner-qa-dashboard-css-source',apply:'build',enforce:'pre',
    transform(code,id) {
      if(id.split('?')[0]!==stylesheet)return null;
      return {code:code+'\n@source '+JSON.stringify(source)+';\n',map:null};
    },
  };
}

export function assertDashboardUtilityCss(sources) {
  const css=sources.join('\n');
  // Representative real dashboard layout/visibility controls. The broken
  // fixture emitted only base styles and a few tokens from its own JS files.
  const selectors=['flex','hidden','h-8','rounded-2xl','border-zinc-800'];
  const missing=selectors.filter(selector=>!new RegExp('\\.'+selector+'(?=[\\s,{:.#>])').test(css));
  if(missing.length)throw Error('Dashboard Tailwind utilities missing: '+missing.join(', '));
  return {source:'artifacts/trading-dashboard/src',selectors};
}
