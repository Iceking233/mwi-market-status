# GitHub Pages And Actions Setup

This project is designed to use GitHub as the long-term storage and distribution layer.

## What GitHub will do

- GitHub Actions runs every 30 minutes.
- The workflow downloads the latest official market JSON.
- The workflow writes archive files into `docs/history/official/`.
- The workflow publishes public API entrypoints into `docs/market/`.
- GitHub Pages serves those files to all plugin users.

## What you need to do

### 1. Push this repository to GitHub

Make sure the workflow file and sync script are included:

- `.github/workflows/sync-official-market-history.yml`
- `bakcend/sync-official-market-history.mjs`

### 2. Enable GitHub Actions

Open your repository on GitHub:

1. Go to `Settings`
2. Open `Actions` -> `General`
3. Make sure Actions are allowed for this repository
4. Allow workflows to create and push commits

Recommended setting:

- Workflow permissions: `Read and write permissions`

### 3. Enable GitHub Pages

Open:

1. `Settings`
2. `Pages`
3. Under `Build and deployment`
4. Source: `Deploy from a branch`
5. Branch: choose your main branch, usually `main`
6. Folder: `/docs`
7. Save

After Pages is enabled, your public URLs will look like:

- `https://<your-user>.github.io/<your-repo>/market/api.json`
- `https://<your-user>.github.io/<your-repo>/market/history/official/manifest.json`

## Optional repository variable

If the official JSON source changes, you can configure it without editing code:

1. `Settings`
2. `Secrets and variables`
3. `Actions`
4. `Variables`
5. Add repository variable `MWI_OFFICIAL_MARKET_URL`

If you do not set it, the workflow uses:

- `https://www.milkywayidle.com/game_data/marketplace.json`

## First run

After Actions and Pages are enabled:

1. Open `Actions`
2. Open `Sync Official Market History`
3. Click `Run workflow`

That first run will generate:

- `docs/history/official/...`
- `docs/market/api.json`
- `docs/market/manifest.json`

## After setup

Your userscript will try this order:

1. GitHub Pages current market API
2. Old market API fallback at `mooket.qi-e.top`
3. Local browser cache

For history it will try:

1. GitHub Pages official history shards
2. GitHub Pages sqlite shards
3. Old history API fallback at `mooket.qi-e.top`
4. Local IndexedDB history

It will not use the Q7 interface anymore.
