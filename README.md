# mwi-market-status

A private project for building my own Milky Way Idle market data pipeline.

## Current scope
- userscript frontend
- browser-local cache and IndexedDB history
- GitHub-hosted official snapshot archive
- SQLite historical storage
- future realtime order book ingestion
- static shard pipeline for importing extra history from `market.db`

## Current local storage

The userscript currently stores market data in the browser, not on a server:

- `localStorage["MWIAPI_JSON_NEW"]`: latest downloaded market snapshot JSON
- `localStorage["MWICore_marketData"]`: merged in-browser market cache
- `IndexedDB["MWIHistoryDB"]`: normalized historical points and import metadata

## Long-term sync plan

- `docs/history/sqlite/`: static long-range history imported from `market.db`
- `docs/history/official/`: official snapshot archive, latest snapshot, and per-item history shards
- `docs/market/`: GitHub Pages public API root for current market and manifests
- `.github/workflows/sync-official-market-history.yml`: updates the official archive every 30 minutes

See [docs/official-history-source.md](docs/official-history-source.md), [docs/sqlite-history-source.md](docs/sqlite-history-source.md), and [docs/github-pages-actions-setup.md](docs/github-pages-actions-setup.md).
