#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_HOURLY_RETENTION_DAYS,
  buildEmptyOfficialManifest,
  compactHistoryRows,
  getOfficialHistoryPaths,
  updateVariantManifestEntry
} from "./history-compaction.mjs";
import {
  resolveDataDocsDir,
  resolveOfficialHistoryOutDir
} from "./data-repo-paths.mjs";

function parseArgs(argv) {
  const args = {
    docsDir: resolveDataDocsDir(),
    outDir: "",
    hourlyRetentionDays: DEFAULT_HOURLY_RETENTION_DAYS
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--docs-dir") args.docsDir = path.resolve(argv[++i]);
    else if (arg === "--out-dir") args.outDir = path.resolve(argv[++i]);
    else if (arg === "--hourly-retention-days") args.hourlyRetentionDays = Math.max(0, Number(argv[++i]) || 0);
    else if (arg === "--help") {
      console.log(`Usage:
  node bakcend/compact-official-history.mjs [--docs-dir ./docs] [--out-dir docs/history/official] [--hourly-retention-days 60]

What it does:
  1. Reads every official item shard under docs/history/official/items.
  2. Compacts rows older than the retention window into daily points.
  3. Rebuilds docs/history/official/manifest.json and docs/market manifests.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  args.outDir = resolveOfficialHistoryOutDir(args);
  return args;
}

async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function buildPublicHistoryManifest(manifest) {
  const publicManifest = JSON.parse(JSON.stringify(manifest || {}));
  if (publicManifest?.latestSnapshot?.path) {
    publicManifest.latestSnapshot.path = `../../../history/official/${publicManifest.latestSnapshot.path}`;
  }

  Object.values(publicManifest?.items || {}).forEach(itemEntry => {
    Object.values(itemEntry?.variants || {}).forEach(variantEntry => {
      if (variantEntry?.path) {
        variantEntry.path = `../../../history/official/${variantEntry.path}`;
      }
    });
  });

  return publicManifest;
}

function buildPublicMarketManifest(manifest) {
  return {
    version: 1,
    generatedAt: manifest.generatedAt,
    sourceName: manifest.sourceName,
    latestSnapshot: manifest.latestSnapshot?.path
      ? {
          ...manifest.latestSnapshot,
          path: `../history/official/${manifest.latestSnapshot.path}`
        }
      : manifest.latestSnapshot,
    endpoints: {
      latestMarketApi: "api.json",
      officialHistoryManifest: "history/official/manifest.json",
      sqliteHistoryManifest: "../history/sqlite/manifest.json"
    }
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const {
    outDir,
    itemsDir,
    latestPath,
    manifestPath,
    publicApiPath,
    publicManifestPath,
    publicHistoryManifestPath
  } = getOfficialHistoryPaths(args.outDir);

  const previousManifest = await readJsonIfExists(manifestPath, buildEmptyOfficialManifest("official_marketplace_json"));
  const manifest = {
    ...buildEmptyOfficialManifest(previousManifest.sourceName || "official_marketplace_json"),
    latestSnapshot: previousManifest.latestSnapshot || null,
    items: {}
  };

  const itemFiles = (await fs.readdir(itemsDir))
    .filter(name => name.endsWith(".json"))
    .sort();

  let touchedVariants = 0;
  for (const filename of itemFiles) {
    const itemPath = path.join(itemsDir, filename);
    const shard = await readJsonIfExists(itemPath, null);
    if (!shard?.itemHrid) continue;

    const compactedRows = compactHistoryRows(shard.rows || [], {
      hourlyRetentionDays: args.hourlyRetentionDays
    });
    if (!compactedRows.length) continue;

    shard.version = 1;
    shard.rows = compactedRows;
    shard.earliestTime = compactedRows[0]?.time ?? null;
    shard.latestTime = compactedRows[compactedRows.length - 1]?.time ?? null;
    shard.hourlyRetentionDays = args.hourlyRetentionDays;

    await fs.writeFile(itemPath, `${JSON.stringify(shard)}\n`, "utf8");

    const itemRelativePath = `items/${filename}`;
    const itemEntry = manifest.items[shard.itemHrid] || { variants: {} };
    itemEntry.variants[String(Number(shard.variant) || 0)] = updateVariantManifestEntry(
      itemEntry.variants[String(Number(shard.variant) || 0)],
      compactedRows,
      itemRelativePath,
      args.hourlyRetentionDays
    );
    manifest.items[shard.itemHrid] = itemEntry;
    touchedVariants += 1;
  }

  manifest.generatedAt = new Date().toISOString();

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");

  const latestPayload = await readJsonIfExists(latestPath, null);
  if (latestPayload) {
    await fs.writeFile(publicApiPath, `${JSON.stringify(latestPayload)}\n`, "utf8");
  }
  await fs.writeFile(publicHistoryManifestPath, `${JSON.stringify(buildPublicHistoryManifest(manifest))}\n`, "utf8");
  await fs.writeFile(publicManifestPath, `${JSON.stringify(buildPublicMarketManifest(manifest))}\n`, "utf8");

  console.log(`Compacted ${touchedVariants} official item shards with hourly retention ${args.hourlyRetentionDays}d`);
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
