#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  resolveDataDocsDir,
  resolveSqliteHistoryOutDir
} from "./data-repo-paths.mjs";

function parseArgs(argv) {
  const args = {
    db: "",
    docsDir: resolveDataDocsDir(),
    outDir: "",
    sourceName: "mwiapi_market_db"
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--db") args.db = path.resolve(argv[++i]);
    else if (arg === "--docs-dir") args.docsDir = path.resolve(argv[++i]);
    else if (arg === "--out-dir") args.outDir = path.resolve(argv[++i]);
    else if (arg === "--source-name") args.sourceName = argv[++i];
    else if (arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.db) {
    throw new Error("Missing required argument: --db <path-to-market.db>");
  }

  args.outDir = resolveSqliteHistoryOutDir(args);
  return args;
}

function printHelp() {
  console.log(`Usage:
  node bakcend/build-sqlite-history-shards.mjs --db /path/to/market.db [--docs-dir ./docs] [--out-dir docs/history/sqlite]

What it does:
  1. Reads ask/bid history from the SQLite database.
  2. Emits one static JSON shard per item.
  3. Writes a manifest.json for the userscript to resolve item -> shard path.`);
}

function runSqliteJson(dbPath, sql) {
  const output = execFileSync("sqlite3", ["-json", dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024
  });
  const trimmed = output.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, "\"\"")}"`;
}

function toSafeFilename(itemHrid) {
  return itemHrid
    .replace(/^\/+/, "")
    .replace(/[\\/:%?&#=+ ]/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
}

function normalizeItemKey(rawKey) {
  if (!rawKey) return null;
  if (rawKey.startsWith("/items/")) return rawKey;
  return rawKey;
}

function buildRows(askRows, bidRows) {
  const points = new Map();

  const merge = (rows, field) => {
    for (const row of rows) {
      const time = Number(row.time) || 0;
      const value = Number(row[field]);
      if (!time || !Number.isFinite(value) || value < 0) continue;
      const point = points.get(time) || {
        time,
        a: -1,
        b: -1,
        p: null,
        v: null
      };
      if (field === "ask") point.a = value;
      if (field === "bid") point.b = value;
      points.set(time, point);
    }
  };

  merge(askRows, "ask");
  merge(bidRows, "bid");

  return Array.from(points.values())
    .sort((left, right) => left.time - right.time)
    .filter(row => row.a >= 0 || row.b >= 0);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const itemsDir = path.join(args.outDir, "items");

  await fs.mkdir(itemsDir, { recursive: true });

  const askColumns = runSqliteJson(args.db, "PRAGMA table_info(ask);")
    .map(column => column.name)
    .filter(name => name && name !== "time");
  const bidColumnSet = new Set(
    runSqliteJson(args.db, "PRAGMA table_info(bid);")
      .map(column => column.name)
      .filter(name => name && name !== "time")
  );

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    sourceName: args.sourceName,
    items: {}
  };

  for (const rawColumnName of askColumns) {
    if (!bidColumnSet.has(rawColumnName)) continue;
    const itemKey = normalizeItemKey(rawColumnName);
    if (!itemKey) continue;

    const quoted = quoteIdentifier(rawColumnName);
    const askRows = runSqliteJson(
      args.db,
      `SELECT time, ${quoted} AS ask FROM ask WHERE ${quoted} IS NOT NULL ORDER BY time;`
    );
    const bidRows = runSqliteJson(
      args.db,
      `SELECT time, ${quoted} AS bid FROM bid WHERE ${quoted} IS NOT NULL ORDER BY time;`
    );

    const rows = buildRows(askRows, bidRows);
    if (!rows.length) continue;

    const filename = `${toSafeFilename(itemKey)}.json`;
    const relativePath = `items/${filename}`;
    const latestTime = rows[rows.length - 1].time;
    const earliestTime = rows[0].time;
    const maxDays = Math.max(1, Math.ceil((latestTime - earliestTime) / 86400) + 1);

    const payload = {
      version: 1,
      source: args.sourceName,
      itemHrid: itemKey,
      earliestTime,
      latestTime,
      rows
    };

    await fs.writeFile(
      path.join(args.outDir, relativePath),
      `${JSON.stringify(payload)}\n`,
      "utf8"
    );

    manifest.items[itemKey] = {
      path: relativePath,
      rows: rows.length,
      earliestTime,
      latestTime,
      maxDays
    };
  }

  await fs.writeFile(
    path.join(args.outDir, "manifest.json"),
    `${JSON.stringify(manifest)}\n`,
    "utf8"
  );

  console.log(
    `Built ${Object.keys(manifest.items).length} item shards into ${args.outDir}`
  );
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
