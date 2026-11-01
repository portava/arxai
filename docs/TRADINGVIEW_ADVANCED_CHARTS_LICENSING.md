# Chart renderer dependency and replacement status

Updated 1 November 2026. This supersedes the earlier recommendation to retain Lightweight Charts permanently and the obsolete description of `TradingViewLiveChart.tsx` as an active hosted widget.

The owner requires ARX's own chart throughout the application, with no TradingView branding. That requirement is **not yet fulfilled**: the default adapter still uses Lightweight Charts, and the native/replay/position chart surfaces still render `ChartLibraryCredit`. Renaming the adapter or hiding its credit would not replace the dependency.

## Verified dependency distinction

- Lightweight Charts is the open-source price-rendering dependency currently behind ARX's custom chart tools. It is **Apache-2.0**, correcting this document's previous MIT label. Its official README specifies attribution and a TradingView link. [Official repository and license section](https://github.com/tradingview/lightweight-charts#license).
- TradingView Advanced Charts is a different product. ARX's registry has an unavailable descriptor; its factory refuses to instantiate it. This checkout has no working Advanced Charts adapter or bundled distribution. This source inspection is not a determination of any agreement the owner may hold elsewhere.
- The former hosted widget is not the active Scanner renderer. Current frontend source searches find neither `TradingViewLiveChart` nor `s3.tradingview.com`/`tv.js`. They do find the Lightweight Charts adapter and credit components.

## Replacement direction

The existing ARX shell, data authority, studies, analysis, drawings, templates and guarded trade paths stay authoritative. The migration replaces the renderer under that interface; it does not create a second feed, analysis engine or order system.

Scanner overlays now use ARX-owned coordinate/overlay handles with revocable context lifetimes. The staged `nativePriceRenderer` independently paints seven price styles on Canvas, reusing ARX's candle sanitizer, display transforms and bounded navigation. It is not registered as an available engine or selected by default.

Full adapter integration, axes and gestures, incremental updates, studies/panes, overlays, drawing interactions, replay and mini-chart migration, real Scanner browser acceptance and comparative performance remain necessary. The dependency and associated credit can be removed after those consumers have actually migrated and bundle/source audits confirm it. See `SMART_CHART_NATIVE_RENDERER_2026_11_01.md` for exact evidence and remaining work.

No proprietary chart bundle was downloaded, no library implementation was copied into the native layer, and no license-gated adapter was enabled.
