// QA metadata only. This does not select or rewrite the application's engine.
export function readProductDefaultEngine(source) {
  const declarations = [...source.matchAll(/export\s+const\s+DEFAULT_CHART_ENGINE_ID\s*:\s*ChartEngineId\s*=\s*["']([^"']+)["']\s*;/g)];
  if (declarations.length !== 1 || !['arx-native', 'lightweight-charts'].includes(declarations[0][1])) {
    throw Error('Expected exactly one supported literal product default engine declaration');
  }
  return declarations[0][1];
}
export function nativeBuildProvenance(build) {
  if (!build?.nativeEngine) return null;
  if (build.qaOnlyDefaultEngineOverride === false && build.productDefaultEngineId === 'arx-native') return 'product-default';
  if (build.qaOnlyDefaultEngineOverride === true && build.productDefaultEngineId === 'lightweight-charts') return 'qa-override';
  return null;
}
