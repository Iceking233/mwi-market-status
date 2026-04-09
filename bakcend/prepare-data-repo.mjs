#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_DATA_DOCS_DIR } from "./data-repo-paths.mjs";

function parseArgs(argv) {
  const args = {
    sourceDocsDir: DEFAULT_DATA_DOCS_DIR,
    targetRepoDir: path.resolve("../mwi-market-data")
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source-docs-dir") args.sourceDocsDir = path.resolve(argv[++i]);
    else if (arg === "--target-repo-dir") args.targetRepoDir = path.resolve(argv[++i]);
    else if (arg === "--help") {
      console.log(`Usage:
  node bakcend/prepare-data-repo.mjs [--source-docs-dir ./docs] [--target-repo-dir ../mwi-market-data]

What it does:
  1. Creates the target repo directory if needed.
  2. Copies docs/history and docs/market into the target repo's docs/.
  3. Writes a small README and .nojekyll file for GitHub Pages.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceHistoryDir = path.join(args.sourceDocsDir, "history");
  const sourceMarketDir = path.join(args.sourceDocsDir, "market");
  const targetDocsDir = path.join(args.targetRepoDir, "docs");
  const targetHistoryDir = path.join(targetDocsDir, "history");
  const targetMarketDir = path.join(targetDocsDir, "market");

  if (!(await pathExists(sourceHistoryDir)) || !(await pathExists(sourceMarketDir))) {
    throw new Error(`Missing source docs directories under ${args.sourceDocsDir}`);
  }

  await ensureDir(targetDocsDir);
  await fs.cp(sourceHistoryDir, targetHistoryDir, { recursive: true, force: true });
  await fs.cp(sourceMarketDir, targetMarketDir, { recursive: true, force: true });
  await fs.writeFile(
    path.join(args.targetRepoDir, "README.md"),
    "# mwi-market-data\n\nStatic market history and public API payloads for Milky Way Idle.\n",
    "utf8"
  );
  await fs.writeFile(path.join(targetDocsDir, ".nojekyll"), "\n", "utf8");

  console.log(`Copied market data into ${args.targetRepoDir}`);
  console.log(`Data docs root: ${targetDocsDir}`);
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
