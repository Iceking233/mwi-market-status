#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const args = {
    dbUrl: "https://raw.githubusercontent.com/holychikenz/MWIApi/main/market.db",
    outDir: path.resolve("docs/history/sqlite")
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--db-url") args.dbUrl = argv[++i];
    else if (arg === "--out-dir") args.outDir = path.resolve(argv[++i]);
    else if (arg === "--help") {
      console.log(`Usage:
  node bakcend/download-and-build-sqlite-history.mjs [--db-url <url>] [--out-dir docs/history/sqlite]`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mwi-market-db-"));
  const dbPath = path.join(tmpDir, "market.db");

  console.log(`Downloading ${args.dbUrl}`);
  const response = await fetch(args.dbUrl);
  if (!response.ok) {
    throw new Error(`Download failed with HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  await fs.writeFile(dbPath, Buffer.from(arrayBuffer));

  const result = spawnSync(
    process.execPath,
    [
      path.resolve("bakcend/build-sqlite-history-shards.mjs"),
      "--db",
      dbPath,
      "--out-dir",
      args.outDir
    ],
    {
      stdio: "inherit"
    }
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
