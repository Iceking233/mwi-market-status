# Split Code Repo And Data Repo

This project can now write generated market data into a separate repository.

## Recommended layout

- code repo: `mwi-market-status`
- data repo: `mwi-market-data`
- local folders:
  - `../mwi-market-status`
  - `../mwi-market-data`

## What changes after the split

- script code stays in the code repo
- `docs/history/**` and `docs/market/**` live in the data repo
- sync/import/compaction scripts can write directly into the data repo by setting:

```bash
export MWI_MARKET_DATA_DOCS_DIR=/path/to/mwi-market-data/docs
```

## Supported commands

Official history sync:

```bash
MWI_MARKET_DATA_DOCS_DIR=../mwi-market-data/docs node bakcend/sync-official-market-history.mjs
```

Browser export import:

```bash
MWI_MARKET_DATA_DOCS_DIR=../mwi-market-data/docs node bakcend/import-browser-history-export.mjs --in /path/to/export.json
```

SQLite shard build:

```bash
MWI_MARKET_DATA_DOCS_DIR=../mwi-market-data/docs node bakcend/download-and-build-sqlite-history.mjs
```

## First-time local seeding

If your current code repo already contains generated data, you can seed the sibling data repo with:

```bash
node bakcend/prepare-data-repo.mjs --target-repo-dir ../mwi-market-data
```

That copies:

- `docs/history/`
- `docs/market/`

into the target repo.

## GitHub Actions in the data repo

Copy the template below into the data repo:

- `docs/examples/sync-official-market-history.data-repo.yml`

Save it there as:

- `.github/workflows/sync-official-market-history.yml`

If the code repo is private, add a fine-grained PAT secret named `MWI_SYNC_REPO_TOKEN` in the data repo.

## One-time Git cleanup after the split

After you confirm the data repo is correct, remove generated data from the code repo index:

```bash
git rm -r --cached docs/history docs/market
git commit -m "Move generated market data to separate repo"
```

Because `.gitignore` now ignores those directories, future script-only commits will stay small.

## Userscript URL migration

The userscript now prefers a future Pages URL at:

- `https://iceking233.github.io/mwi-market-data`

but still falls back to the current code repo Pages URLs, so you can migrate gradually.
