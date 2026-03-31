#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_LEGACY_SOURCE_URL = "https://mooket.qi-e.top/market/item/history";
const DEFAULT_Q7_SOURCE_URL = "https://q7.nainai.eu.org/api/market/history";

function parseArgs(argv) {
  const args = {
    outDir: path.resolve("docs/history/official"),
    sourceUrl: DEFAULT_LEGACY_SOURCE_URL,
    sourceKind: "legacy",
    days: 7,
    delayMs: 120,
    onlyItem: "",
    limit: 0
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out-dir") args.outDir = path.resolve(argv[++i]);
    else if (arg === "--source-url") args.sourceUrl = argv[++i];
    else if (arg === "--source-kind") args.sourceKind = String(argv[++i] || "legacy").toLowerCase();
    else if (arg === "--days") args.days = Math.max(1, Number(argv[++i]) || 7);
    else if (arg === "--delay-ms") args.delayMs = Math.max(0, Number(argv[++i]) || 0);
    else if (arg === "--only-item") args.onlyItem = argv[++i] || "";
    else if (arg === "--limit") args.limit = Math.max(0, Number(argv[++i]) || 0);
    else if (arg === "--help") {
      console.log(`Usage:
  node bakcend/backfill-legacy-history-window.mjs [--source-kind legacy|q7] [--days 7] [--delay-ms 120] [--only-item /items/apple] [--limit 50]

What it does:
  1. Reads docs/history/official/manifest.json.
  2. Fetches recent rows from a maintenance history endpoint for each item/variant.
  3. Merges the rows into docs/history/official/items/*.json.
  4. Rebuilds docs/history/official/manifest.json.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (args.sourceKind === "q7" && args.sourceUrl === DEFAULT_LEGACY_SOURCE_URL) {
    args.sourceUrl = DEFAULT_Q7_SOURCE_URL;
  }

  if (!["legacy", "q7"].includes(args.sourceKind)) {
    throw new Error(`Unsupported --source-kind: ${args.sourceKind}`);
  }

  return args;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function normalizeLegacyRows(payload) {
  const byTime = new Map();
  const bidRows = Array.isArray(payload?.bid) ? payload.bid : (Array.isArray(payload?.bids) ? payload.bids : []);
  const askRows = Array.isArray(payload?.ask) ? payload.ask : (Array.isArray(payload?.asks) ? payload.asks : []);

  for (const row of bidRows) {
    const time = Number(row?.time) || 0;
    if (!time) continue;
    const point = byTime.get(time) || { time, a: -1, b: -1, p: null, v: null, source: "legacy_history" };
    if (row?.price != null || row?.bid != null) point.b = Number(row.price ?? row.bid ?? -1);
    if (row?.avg != null || row?.p != null) point.p = Number(row.avg ?? row.p ?? 0);
    if (row?.volume != null || row?.v != null) point.v = Number(row.volume ?? row.v ?? 0);
    byTime.set(time, point);
  }

  for (const row of askRows) {
    const time = Number(row?.time) || 0;
    if (!time) continue;
    const point = byTime.get(time) || { time, a: -1, b: -1, p: null, v: null, source: "legacy_history" };
    if (row?.price != null || row?.ask != null) point.a = Number(row.price ?? row.ask ?? -1);
    if ((point.p == null || point.p === 0) && (row?.avg != null || row?.p != null)) {
      point.p = Number(row.avg ?? row.p ?? 0);
    }
    if ((point.v == null || point.v === 0) && (row?.volume != null || row?.v != null)) {
      point.v = Number(row.volume ?? row.v ?? 0);
    }
    byTime.set(time, point);
  }

  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

function normalizeQ7Rows(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.data || payload?.rows || [];
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(row => Number(row?.time) > 0)
    .map(row => ({
      time: Number(row.time),
      a: row.a ?? row.ask ?? -1,
      b: row.b ?? row.bid ?? -1,
      p: row.p ?? row.price ?? null,
      v: row.v ?? row.volume ?? null,
      source: "third_party_history"
    }))
    .sort((a, b) => a.time - b.time);
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
    if (!time) continue;
    byTime.set(time, row);
  }
  for (const row of importedRows || []) {
    const time = Number(row?.time) || 0;
    if (!time) continue;
    const previous = byTime.get(time);
    if (!previous || scoreRowSource(row?.source) >= scoreRowSource(previous?.source)) {
      byTime.set(time, row);
      continue;
    }
    const next = { ...previous };
    let changed = false;
    if ((next?.v == null || Number(next?.v) <= 0) && Number(row?.v) > 0) {
      next.v = Number(row.v);
      changed = true;
    }
    if ((next?.p == null || Number(next?.p) <= 0) && row?.p != null && Number(row?.p) > 0) {
      next.p = Number(row.p);
      changed = true;
    }
    if ((next?.a == null || Number(next?.a) < 0) && row?.a != null && Number(row?.a) >= 0) {
      next.a = Number(row.a);
      changed = true;
    }
    if ((next?.b == null || Number(next?.b) < 0) && row?.b != null && Number(row?.b) >= 0) {
      next.b = Number(row.b);
      changed = true;
    }
    if (changed) {
      byTime.set(time, next);
    }
  }
  return Array.from(byTime.values()).sort((left, right) => Number(left.time) - Number(right.time));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.join(args.outDir, "manifest.json");
  const manifest = await readJson(manifestPath);

  const targets = [];
  for (const [itemHrid, itemEntry] of Object.entries(manifest.items || {})) {
    if (args.onlyItem && itemHrid !== args.onlyItem) continue;
    for (const [variant, variantEntry] of Object.entries(itemEntry?.variants || {})) {
      targets.push({
        itemHrid,
        variant: Number(variant) || 0,
        path: variantEntry.path
      });
    }
  }

  if (args.limit > 0) {
    targets.length = Math.min(targets.length, args.limit);
  }

  let touched = 0;
  for (const target of targets) {
    const itemPath = path.join(args.outDir, target.path);
    const shard = await readJson(itemPath);
    const url = new URL(args.sourceUrl);
    if (args.sourceKind === "q7") {
      url.searchParams.set("item_id", target.itemHrid);
      url.searchParams.set("variant", String(target.variant));
      url.searchParams.set("days", String(args.days));
    } else {
      url.searchParams.set("name", target.itemHrid);
      url.searchParams.set("level", String(target.variant));
      url.searchParams.set("time", String(args.days * 86400));
    }

    const response = await fetch(url, { headers: { "cache-control": "no-cache" } });
    if (!response.ok) {
      console.warn(`skip ${target.itemHrid}:${target.variant} HTTP ${response.status}`);
      if (args.delayMs > 0) await sleep(args.delayMs);
      continue;
    }

    const payload = await response.json();
    const importedRows = args.sourceKind === "q7"
      ? normalizeQ7Rows(payload)
      : normalizeLegacyRows(payload);
    if (!importedRows.length) {
      if (args.delayMs > 0) await sleep(args.delayMs);
      continue;
    }

    const mergedRows = mergeRows(shard.rows || [], importedRows);
    shard.rows = mergedRows;
    shard.earliestTime = mergedRows[0]?.time ?? shard.earliestTime ?? null;
    shard.latestTime = mergedRows[mergedRows.length - 1]?.time ?? shard.latestTime ?? null;

    await fs.writeFile(itemPath, `${JSON.stringify(shard)}\n`, "utf8");

    const manifestVariant = manifest.items?.[target.itemHrid]?.variants?.[String(target.variant)];
    if (manifestVariant) {
      manifestVariant.rows = mergedRows.length;
      manifestVariant.earliestTime = shard.earliestTime;
      manifestVariant.latestTime = shard.latestTime;
      manifestVariant.maxDays = Math.max(
        1,
        Math.ceil((Number(shard.latestTime) - Number(shard.earliestTime)) / 86400) + 1
      );
    }

    touched += 1;
    if (args.delayMs > 0) await sleep(args.delayMs);
  }

  manifest.generatedAt = new Date().toISOString();
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");

  console.log(`Backfilled legacy history window for ${touched} item variants`);
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
