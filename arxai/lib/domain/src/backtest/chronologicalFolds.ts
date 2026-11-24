/** Half-open out-of-sample folds on a regular index grid. A prior label cannot
 * reach the next test period, including the requested embargo. */
export function chronologicalFoldBounds(firstTest: number, end: number, folds: number, horizon: number, embargo: number) {
  const span = end - firstTest;
  const result: Array<{ trainEnd: number; testStart: number; testEnd: number }> = [];
  for (let index = 0; index < folds; index++) {
    const testStart = firstTest + Math.floor(span * index / folds);
    const testEnd = firstTest + Math.floor(span * (index + 1) / folds);
    result.push({ trainEnd: testStart - horizon - embargo, testStart, testEnd });
  }
  return result;
}
