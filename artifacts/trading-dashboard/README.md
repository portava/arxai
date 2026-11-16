# ARX preview adapter

This directory owns ARX AI's routing metadata, not a second frontend package.
The original dashboard and its dependencies remain under
`arxai/artifacts/trading-dashboard`.

Use the managed workflow `artifacts/trading-dashboard: web`. Its development
command runs `scripts/run-arx-web.sh` inside the original workspace and inherits
the artifact's `PORT` and `BASE_PATH`.

Keep only one active dashboard manifest, here at the top-level artifact path.
The nested registration could start Vite but was not forwarded by the shared
preview router. Do not add a legacy workflow or a second copy of the frontend.

The API uses its separate existing safety-isolated launcher. This adapter does
not enable live trading or change authentication.
