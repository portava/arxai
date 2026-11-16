# Replay completion performance

This change reduces repeated work when advancing or rewinding a small number of revealed bars. Study render buffers retain their left edge while their tail changes; each channel uses the installed chart library's tail API only when the retained and changed endpoint values are finite. Lightweight Charts 5.2 `pop` counts plotted values, not whitespace: warmup/null channels, changed buffer ownership and large changes use complete replacement. Changed study configuration creates new calculators and series. No unrevealed bars are calculated or cached.

The embedded reader memoizes stable props and its bound-bar lookup. For immutable Replay input only, duplicate notifications for the identical applied OHLC window, prefix, source, chart epoch, view and read state reuse the current reading. Selection and annotation controls still apply independently. Live reads continue refreshing on every notification, including same-bar stream revisions. The installed-prefix and reader DOM witnesses remain separate from click acknowledgement.

## Validation and limits

All 17 study types are compared against full calculation at the rendered-channel boundary through rewinds, appends, middle revisions, prepends, empty/one-bar windows, warmup, style and period changes. A separate real Lightweight Charts 5.2 browser fixture passes 336 channel checks and 238 time-axis cases, including removing future whitespace on rewind. Tests preserve causal prefix behavior and source/read-state invalidation.

The paired production-browser workload uses 5,000 constructed closed bars, 12 studies and the existing 37-name catalogue reader, with all APIs intercepted and no trading. On the local Apple M4 Pro host at 4× CPU throttling, step second-rAF p95 improves from 61.1 ms to 36.9 ms; actual series installation improves from 32.8 ms to 10.7 ms and reader DOM observation from 41.9 ms to 19.8 ms. All 80 series/reader witnesses per version match.

Full forward-seek second-rAF p95 remains **105.7 ms**, so the overall 100 ms completion target **fails**. Its actual series installation p95 changes 61.7→65.3 ms, reader DOM 72.6→76.3 ms and following display opportunity 104.9→99.9 ms. These are local paired measurements, not a general speed or competitor comparison. rAF opportunity does not prove a physical paint or 60 fps. Earlier 179.7 ms trials remain retained; different host conditions prevent using them as the speedup baseline. The later 65-name catalogue and descriptive reader require separate integration validation.

Raw samples, conventional medians, nearest-rank p95/p99, all outliers, profiles, screenshots and failed harness evidence are in `arx-tier1-release/chart-replay-completion-performance-20261026` outside the repository. No trading, deployment or main-branch change is included.

## References

- [TradingView Lightweight Charts series API](https://tradingview.github.io/lightweight-charts/docs/api/interfaces/ISeriesApi): tail operations and complete data replacement. The installed 5.2 implementation was inspected and tested directly for whitespace behavior.
- [TradingView real-time updates](https://tradingview.github.io/lightweight-charts/tutorials/demos/realtime-updates): update the changed tail instead of repeatedly replacing full data where supported.
- [TradingView Bar Replay](https://www.tradingview.com/support/solutions/43000712747-bar-replay-how-and-why-to-test-a-strategy-in-the-past/): replay is a historical workflow; this implementation remains a single-chart, loaded-window, view-only feature.
