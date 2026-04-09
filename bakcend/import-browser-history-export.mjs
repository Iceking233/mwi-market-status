#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_HOURLY_RETENTION_DAYS,
  buildEmptyOfficialManifest,
  compactHistoryRows,
  toSafeFilename,
  updateVariantManifestEntry
} from "./history-compaction.mjs";
import {
  resolveDataDocsDir,
  resolveOfficialHistoryOutDir
} from "./data-repo-paths.mjs";

const ALLOWED_SOURCES = new Set([
  null,
  "",
  "official_hourly",
  "official_archive",
  "sqlite_history",
  "mwiapi_market_db",
  "official_marketplace_json",
  "official_market_api",
  "legacy_history",
  "third_party_history"
]);

function parseArgs(argv) {
  const args = {
    inFile: "",
    docsDir: resolveDataDocsDir(),
    outDir: "",
    sourceName: "browser_history_import",
    hourlyRetentionDays: DEFAULT_HOURLY_RETENTION_DAYS
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--in") args.inFile = path.resolve(argv[++i]);
    else if (arg === "--docs-dir") args.docsDir = path.resolve(argv[++i]);
    else if (arg === "--out-dir") args.outDir = path.resolve(argv[++i]);
    else if (arg === "--source-name") args.sourceName = argv[++i];
    else if (arg === "--hourly-retention-days") args.hourlyRetentionDays = Math.max(0, Number(argv[++i]) || 0);
    else if (arg === "--help") {
      console.log(`Usage:
  node bakcend/import-browser-history-export.mjs --in /path/to/mwi-market-history-export.json [--docs-dir ./docs] [--out-dir docs/history/official] [--hourly-retention-days 60]

What it does:
  1. Reads a userscript-exported browser history JSON file.
  2. Groups rows by item and variant.
  3. Merges them into docs/history/official/items/*.json.
  4. Rebuilds docs/history/official/manifest.json.
  5. Compacts rows older than the retention window into daily points.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.inFile) {
    throw new Error("Missing required argument: --in <path-to-export.json>");
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

function normalizeExportRows(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.rows;
  if (!Array.isArray(rows)) {
    throw new Error("Export payload does not contain a rows array");
  }
  return rows
    .filter(row =>
      row?.itemHrid?.startsWith("/items/") &&
      Number(row?.time) > 0 &&
      ALLOWED_SOURCES.has(row?.source ?? null)
    )
    .map(row => ({
      itemHrid: row.itemHrid,
      variant: Number(row.variant) || 0,
      row: {
        time: Number(row.time),
        a: row.a ?? row.ask ?? -1,
        b: row.b ?? row.bid ?? -1,
        p: row.p ?? row.price ?? null,
        v: row.v ?? row.volume ?? null,
        source: row.source || null
      }
    }));
}

function scoreRowSource(source) {
  switch (source ?? null) {
    case "official_hourly":
    case "official_archive":
    case "official_marketplace_json":
    case "official_market_api":
      return 4;
    case "sqlite_history":
    case "mwiapi_market_db":
      return 3;
    case null:
    case "":
      return 2;
    default:
      return 1;
  }
}

function mergeRows(existingRows, importedRows) {
  const byTime = new Map();
  for (const row of existingRows || []) {
    const time = Number(row?.time) || 0;
    if (!time || !ALLOWED_SOURCES.has(row?.source ?? null)) continue;
    byTime.set(time, row);
  }
  for (const row of importedRows || []) {
    const time = Number(row?.time) || 0;
    if (!time) continue;
    const previous = byTime.get(time);
    if (!previous || scoreRowSource(row?.source) >= scoreRowSource(previous?.source)) {
      byTime.set(time, row);
    }
  }
  return Array.from(byTime.values()).sort((left, right) => Number(left.time) - Number(right.time));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const itemsDir = path.join(args.outDir, "items");
  const manifestPath = path.join(args.outDir, "manifest.json");

  await fs.mkdir(itemsDir, { recursive: true });

  const inputPayload = JSON.parse(await fs.readFile(args.inFile, "utf8"));
  const exportRows = normalizeExportRows(inputPayload);
  const manifest = await readJsonIfExists(manifestPath, {
    ...buildEmptyOfficialManifest(args.sourceName),
    latestSnapshot: null
  });

  const grouped = new Map();
  for (const entry of exportRows) {
    const key = `${entry.itemHrid}::${entry.variant}`;
    const list = grouped.get(key) || [];
    list.push(entry.row);
    grouped.set(key, list);
  }

  let importedVariants = 0;
  for (const [key, rows] of grouped.entries()) {
    const [itemHrid, variantStr] = key.split("::");
    const variant = Number(variantStr) || 0;
    const itemFilename = `${toSafeFilename(itemHrid)}__${variant}.json`;
    const itemRelativePath = `items/${itemFilename}`;
    const itemPath = path.join(args.outDir, itemRelativePath);
    const existingShard = await readJsonIfExists(itemPath, {
      version: 1,
      source: args.sourceName,
      itemHrid,
      variant,
      earliestTime: rows[0]?.time ?? null,
      latestTime: rows[rows.length - 1]?.time ?? null,
      rows: []
    });

    const mergedRows = mergeRows(existingShard.rows || [], rows);
    const compactedRows = compactHistoryRows(mergedRows, {
      hourlyRetentionDays: args.hourlyRetentionDays
    });
    if (!compactedRows.length) continue;

    existingShard.version = 1;
    existingShard.source = existingShard.source || args.sourceName;
    existingShard.itemHrid = itemHrid;
    existingShard.variant = variant;
    existingShard.rows = compactedRows;
    existingShard.earliestTime = compactedRows[0].time;
    existingShard.latestTime = compactedRows[compactedRows.length - 1].time;
    existingShard.hourlyRetentionDays = args.hourlyRetentionDays;

    await fs.writeFile(itemPath, `${JSON.stringify(existingShard)}\n`, "utf8");

    const itemEntry = manifest.items[itemHrid] || { variants: {} };
    itemEntry.variants[String(variant)] = updateVariantManifestEntry(
      itemEntry.variants[String(variant)],
      compactedRows,
      itemRelativePath,
      args.hourlyRetentionDays
    );
    manifest.items[itemHrid] = itemEntry;
    importedVariants += 1;
  }

  manifest.version = 1;
  manifest.generatedAt = new Date().toISOString();
  manifest.sourceName = manifest.sourceName || args.sourceName;

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");

  console.log(`Imported browser export rows into ${importedVariants} item variants`);
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
