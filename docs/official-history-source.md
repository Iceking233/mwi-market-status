# Official History Source

This repository can keep a long-lived archive of the official market snapshot JSON and publish it as static files through GitHub Pages.

## Sync the archive

```bash
node bakcend/sync-official-market-history.mjs
```

By default the script:

1. Downloads the latest market snapshot from `MWI_OFFICIAL_MARKET_URL` or `https://www.milkywayidle.com/game_data/marketplace.json`.
2. Saves the raw snapshot to `docs/history/official/snapshots/YYYY/MM/DD/<timestamp>.json`.
3. Updates `docs/history/official/latest.json`.
4. Appends per-item/per-variant history shards under `docs/history/official/items/`.
5. Keeps the most recent 60 days at hourly precision and compacts older rows into daily points.
6. Rebuilds `docs/history/official/manifest.json`.
7. Publishes GitHub Pages API entrypoints under `docs/market/`.

If `MWI_MARKET_DATA_DOCS_DIR` is set, those generated files are written into that external docs root instead of this repository's local `docs/`.

You can override the retention window:

```bash
node bakcend/sync-official-market-history.mjs --hourly-retention-days 60
```

To compact existing shards in place:

```bash
node bakcend/compact-official-history.mjs --hourly-retention-days 60
```

## GitHub automation

The workflow [`.github/workflows/sync-official-market-history.yml`](../.github/workflows/sync-official-market-history.yml) runs every 30 minutes and can also be triggered manually.

If you set the repository variable `MWI_OFFICIAL_MARKET_URL`, the workflow will fetch from that URL. Otherwise it falls back to `https://www.milkywayidle.com/game_data/marketplace.json`.

## Published API shape

Once GitHub Pages serves the `docs/` directory, the main endpoints are:

- `.../market/api.json`
- `.../market/manifest.json`
- `.../market/history/official/manifest.json`
- `.../history/official/latest.json`
- `.../history/official/manifest.json`
- `.../history/official/items/<item>__<variant>.json`
- `.../history/official/snapshots/YYYY/MM/DD/<timestamp>.json`

That gives you both:

- raw long-term snapshot storage
- one public GitHub Pages API root for current and historical market data
- static item history endpoints that future plugin users can request directly
