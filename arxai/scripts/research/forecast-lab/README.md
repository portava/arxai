# Offline forecast comparison

Uses installed upstream libraries, not copied model code:

| Repository | Installed version | License | Use |
|---|---|---|---|
| https://github.com/bashtage/arch | 9.0.0 | NCSA | Zero-mean GARCH(1,1) range baseline |
| https://github.com/Nixtla/statsforecast | 2.1.1 | Apache-2.0 | Naive forecast with rolling conformal intervals |
| https://github.com/online-ml/river | 0.27.0 | BSD-3-Clause | ADWIN on completed range misses |

The packages were installed in a separate Python 3.14 virtual environment. No
Python dependency is added to the ARX API or broker process. `requirements.lock`
records the complete resolved environment (including transitive dependencies).
No upstream source was copied into production TypeScript.

From `arxai`, with a Python environment compatible with the lock:

```sh
python3 -m venv /tmp/arx-forecast-env
/tmp/arx-forecast-env/bin/python -m pip install -r scripts/research/forecast-lab/requirements.lock
(cd scripts && node --import tsx src/research/exportForecastLibraryBenchmark.ts /tmp/arx-forecast-input.json)
/tmp/arx-forecast-env/bin/python scripts/research/forecast-lab/compare.py /tmp/arx-forecast-input.json /tmp/arx-forecast-results.json
```

`PROTOCOL.md` was written before the comparison. `results.json` pins its hash,
the exported input hash, package versions, every series, and optimizer failures.
The input exporter verifies the existing fixture hash and calls the production
TypeScript range implementation. Python passes only closed prefix data into
candidate models. Candidate failures fall back to ARX for scoring, retaining all
3,633 origins in the denominator; the failure list remains explicit. A reporting
serialization issue and coupled candidate-error handling were corrected before
the final report; no model settings were tuned from results.

Final comparison: 28 series (14 markets × M15/H1), 3,633 origins. Relative score
gain is positive when the candidate improves on ARX:

| Candidate | Mean normalized gain | Hierarchical block-bootstrap 95% interval | Better series |
|---|---:|---:|---:|
| GARCH | -3.68% | -5.18% to -2.42% | 2 / 28 |
| Conformal Naive | -0.54% | -1.18% to +0.16% | 8 / 28 |

Nine GARCH optimizations did not converge and fell back; Conformal had no
failures. Neither candidate is promoted. Drift detections are recorded per
series as diagnostic events; they do not replace the existing production brake.
The pre-existing market fixture has already been used for research, includes
provider/OTC market representations and session gaps, and is not untouched
prospective or execution-quality validation. Horizons here count bars, as in
the earlier range benchmark. Results are interval scores, not profit, price
accuracy, or directional probabilities. A fresh prospective evaluation is still
required before replacing the production range estimator.
