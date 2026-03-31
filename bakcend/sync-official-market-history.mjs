#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    sourceUrl: process.env.MWI_OFFICIAL_MARKET_URL || "https://www.milkywayidle.com/game_data/marketplace.json",
    outDir: path.resolve("docs/history/official"),
    sourceName: "official_marketplace_json"
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source-url") args.sourceUrl = argv[++i];
    else if (arg === "--out-dir") args.outDir = path.resolve(argv[++i]);
    else if (arg === "--source-name") args.sourceName = argv[++i];
    else if (arg === "--help") {
      console.log(`Usage:
  node bakcend/sync-official-market-history.mjs [--source-url <url>] [--out-dir docs/history/official]

What it does:
  1. Downloads the latest market snapshot JSON.
  2. Stores the raw snapshot in a dated archive path.
  3. Updates latest.json plus per-item/per-variant history shards and manifest.json.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function toSafeFilename(value) {
  return String(value)
    .replace(/^\/+/, "")
    .replace(/[\\/:%?&#=+ ]/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
}

function createEmptyManifest(sourceName) {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    sourceName,
    latestSnapshot: null,
    items: {}
  };
}

async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function resolveSnapshotTimestamp(payload, response) {
  const payloadTimestamp = Number(payload?.timestamp);
  if (payloadTimestamp > 0) return payloadTimestamp;

  const lastModified = response.headers.get("last-modified");
  const lastModifiedMs = lastModified ? Date.parse(lastModified) : NaN;
  if (Number.isFinite(lastModifiedMs) && lastModifiedMs > 0) {
    return Math.floor(lastModifiedMs / 1000);
  }

  const responseDate = response.headers.get("date");
  const responseDateMs = responseDate ? Date.parse(responseDate) : NaN;
  if (Number.isFinite(responseDateMs) && responseDateMs > 0) {
    return Math.floor(responseDateMs / 1000);
  }

  return Math.floor(Date.now() / 1000);
}

function normalizeSnapshot(payload, response, sourceUrl) {
  const timestamp = resolveSnapshotTimestamp(payload, response);
  const marketData = payload?.marketData;
  if (!marketData || typeof marketData !== "object") {
    throw new Error("Snapshot payload missing marketData");
  }

  const items = [];
  for (const [itemHrid, variants] of Object.entries(marketData)) {
    if (!itemHrid?.startsWith("/items/")) continue;
    for (const [variantKey, point] of Object.entries(variants || {})) {
      const variant = Number(variantKey) || 0;
      items.push({
        itemHrid,
        variant,
        row: {
          time: timestamp,
          a: point?.a ?? -1,
          b: point?.b ?? -1,
          p: point?.p ?? null,
          v: point?.v ?? null
        }
      });
    }
  }

  if (!items.length) {
    throw new Error("Snapshot marketData has no item rows");
  }

  const normalizedPayload = {
    timestamp,
    marketData,
    meta: {
      sourceUrl,
      lastModified: response.headers.get("last-modified") || null,
      fetchedAt: new Date().toISOString()
    }
  };

  return {
    timestamp,
    payload: normalizedPayload,
    items
  };
}

function mergeRow(rows, nextRow) {
  const lastRow = rows[rows.length - 1];
  if (lastRow && Number(lastRow.time) === Number(nextRow.time)) {
    rows[rows.length - 1] = nextRow;
    return rows;
  }

  rows.push(nextRow);
  rows.sort((left, right) => Number(left.time) - Number(right.time));
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshotsDir = path.join(args.outDir, "snapshots");
  const itemsDir = path.join(args.outDir, "items");
  const latestPath = path.join(args.outDir, "latest.json");
  const manifestPath = path.join(args.outDir, "manifest.json");
  const publicMarketDir = path.resolve("docs/market");
  const publicHistoryDir = path.join(publicMarketDir, "history", "official");
  const publicApiPath = path.join(publicMarketDir, "api.json");
  const publicManifestPath = path.join(publicMarketDir, "manifest.json");
  const publicHistoryManifestPath = path.join(publicHistoryDir, "manifest.json");

  await fs.mkdir(snapshotsDir, { recursive: true });
  await fs.mkdir(itemsDir, { recursive: true });
  await fs.mkdir(publicMarketDir, { recursive: true });
  await fs.mkdir(publicHistoryDir, { recursive: true });

  console.log(`Fetching official market snapshot from ${args.sourceUrl}`);
  const response = await fetch(args.sourceUrl, {
    headers: { "cache-control": "no-cache" }
  });
  if (!response.ok) {
    throw new Error(`Snapshot download failed with HTTP ${response.status}`);
  }

  const snapshotPayload = await response.json();
  const snapshot = normalizeSnapshot(snapshotPayload, response, args.sourceUrl);
  const manifest = await readJsonIfExists(manifestPath, createEmptyManifest(args.sourceName));

  const isSameSnapshot = Number(manifest?.latestSnapshot?.timestamp || 0) === Number(snapshot.timestamp || 0);

  const snapshotDate = new Date(snapshot.timestamp * 1000);
  const year = String(snapshotDate.getUTCFullYear());
  const month = String(snapshotDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(snapshotDate.getUTCDate()).padStart(2, "0");
  const archiveDir = path.join(snapshotsDir, year, month, day);
  const archiveRelativePath = `snapshots/${year}/${month}/${day}/${snapshot.timestamp}.json`;
  const archivePath = path.join(args.outDir, archiveRelativePath);

  await fs.mkdir(archiveDir, { recursive: true });
  await fs.writeFile(archivePath, `${JSON.stringify(snapshot.payload)}\n`, "utf8");
  await fs.writeFile(latestPath, `${JSON.stringify(snapshot.payload)}\n`, "utf8");

  if (isSameSnapshot) {
    await fs.writeFile(publicApiPath, `${JSON.stringify(snapshot.payload)}\n`, "utf8");
    await fs.writeFile(
      publicManifestPath,
      `${JSON.stringify({
        version: 1,
        generatedAt: manifest.generatedAt,
        sourceName: manifest.sourceName,
        latestSnapshot: manifest.latestSnapshot,
        endpoints: {
          latestMarketApi: "market/api.json",
          officialHistoryManifest: "history/official/manifest.json",
          sqliteHistoryManifest: "history/sqlite/manifest.json"
        }
      })}\n`,
      "utf8"
    );
    await fs.writeFile(publicHistoryManifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    console.log(`Snapshot ${snapshot.timestamp} already imported, skipped shard rewrite`);
    return;
  }

  let touchedVariants = 0;
  for (const entry of snapshot.items) {
    const itemFilename = `${toSafeFilename(entry.itemHrid)}__${entry.variant}.json`;
    const itemRelativePath = `items/${itemFilename}`;
    const itemPath = path.join(args.outDir, itemRelativePath);
    const existingShard = await readJsonIfExists(itemPath, {
      version: 1,
      source: args.sourceName,
      itemHrid: entry.itemHrid,
      variant: entry.variant,
      earliestTime: entry.row.time,
      latestTime: entry.row.time,
      rows: []
    });

    const rows = Array.isArray(existingShard.rows) ? existingShard.rows : [];
    mergeRow(rows, entry.row);

    existingShard.version = 1;
    existingShard.source = args.sourceName;
    existingShard.itemHrid = entry.itemHrid;
    existingShard.variant = entry.variant;
    existingShard.rows = rows;
    existingShard.earliestTime = rows[0]?.time ?? entry.row.time;
    existingShard.latestTime = rows[rows.length - 1]?.time ?? entry.row.time;

    await fs.writeFile(itemPath, `${JSON.stringify(existingShard)}\n`, "utf8");

    const itemEntry = manifest.items[entry.itemHrid] || { variants: {} };
    itemEntry.variants[String(entry.variant)] = {
      path: itemRelativePath,
      rows: rows.length,
      earliestTime: existingShard.earliestTime,
      latestTime: existingShard.latestTime,
      maxDays: Math.max(
        1,
        Math.ceil((Number(existingShard.latestTime) - Number(existingShard.earliestTime)) / 86400) + 1
      )
    };
    manifest.items[entry.itemHrid] = itemEntry;
    touchedVariants += 1;
  }

  manifest.version = 1;
  manifest.generatedAt = new Date().toISOString();
  manifest.sourceName = args.sourceName;
  manifest.latestSnapshot = {
    timestamp: snapshot.timestamp,
    path: archiveRelativePath
  };

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
  await fs.writeFile(publicApiPath, `${JSON.stringify(snapshot.payload)}\n`, "utf8");
  await fs.writeFile(publicHistoryManifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
  await fs.writeFile(
    publicManifestPath,
    `${JSON.stringify({
      version: 1,
      generatedAt: manifest.generatedAt,
      sourceName: args.sourceName,
      latestSnapshot: manifest.latestSnapshot,
      endpoints: {
        latestMarketApi: "market/api.json",
        officialHistoryManifest: "history/official/manifest.json",
        sqliteHistoryManifest: "history/sqlite/manifest.json"
      }
    })}\n`,
    "utf8"
  );

  console.log(
    `Archived snapshot ${snapshot.timestamp} to ${archiveRelativePath} and updated ${touchedVariants} item variants`
  );
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
