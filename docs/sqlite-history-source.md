# SQLite History Source

This project can import long-range market history from the public `market.db` published in [holychikenz/MWIApi](https://github.com/holychikenz/MWIApi?tab=readme-ov-file).

## Build static shards

```bash
node bakcend/download-and-build-sqlite-history.mjs --out-dir docs/history/sqlite
```

This does two things:

1. Downloads `market.db`.
2. Converts SQLite `ask` and `bid` tables into static JSON shards plus a `manifest.json`.

Output layout:

```text
docs/history/sqlite/
  manifest.json
  items/
    items_apple.json
    items_cheese.json
    ...
```

## Host it

Serve the generated directory at:

```text
https://mooket.qi-e.top/market/history/sqlite/
```

The userscript will request:

- `.../manifest.json`
- `.../items/<item>.json`

## Runtime behavior

- New users do not download the SQLite database directly.
- The userscript fetches the manifest only when it needs longer history coverage.
- It then downloads just the selected item's shard, stores it in IndexedDB, and reuses it locally after that.

## Current limitations

- The SQLite dump only helps with level `0` items unless the upstream database later includes enhancement-level columns.
- Volume is not restored from this source because the public SQLite dump is treated as ask/bid history only.
