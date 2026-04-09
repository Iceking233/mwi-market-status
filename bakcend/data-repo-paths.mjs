import path from "node:path";

export const DEFAULT_DATA_DOCS_DIR = path.resolve(
  process.env.MWI_MARKET_DATA_DOCS_DIR || "docs"
);

export function inferDocsRootFromOutDir(outDir) {
  const resolvedOutDir = path.resolve(outDir);
  const parentName = path.basename(path.dirname(resolvedOutDir));
  const basename = path.basename(resolvedOutDir);

  if (
    (basename === "official" || basename === "sqlite") &&
    parentName === "history"
  ) {
    return path.dirname(path.dirname(resolvedOutDir));
  }

  return DEFAULT_DATA_DOCS_DIR;
}

export function resolveDataDocsDir(options = {}) {
  if (options.docsDir) return path.resolve(options.docsDir);
  if (options.outDir) return inferDocsRootFromOutDir(options.outDir);
  return DEFAULT_DATA_DOCS_DIR;
}

export function resolveOfficialHistoryOutDir(options = {}) {
  if (options.outDir) return path.resolve(options.outDir);
  return path.join(resolveDataDocsDir(options), "history", "official");
}

export function resolveSqliteHistoryOutDir(options = {}) {
  if (options.outDir) return path.resolve(options.outDir);
  return path.join(resolveDataDocsDir(options), "history", "sqlite");
}

export function normalizePagesBaseUrl(baseUrl) {
  if (!baseUrl) return "";
  return String(baseUrl).replace(/\/+$/, "");
}
