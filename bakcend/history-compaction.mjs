import path from "node:path";
import { inferDocsRootFromOutDir } from "./data-repo-paths.mjs";

export const DEFAULT_HOURLY_RETENTION_DAYS = 60;

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getMedian(values) {
  const valid = values
    .map(toNumberOrNull)
    .filter(value => value != null && value > 0)
    .sort((left, right) => left - right);
  if (!valid.length) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 === 0 ? (valid[mid - 1] + valid[mid]) / 2 : valid[mid];
}

function getMostRecentNonNull(rows, key) {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const value = toNumberOrNull(rows[i]?.[key]);
    if (value != null) return value;
  }
  return null;
}

function buildDayKeyUtc(unixTimeSeconds) {
  const date = new Date(Number(unixTimeSeconds) * 1000);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeRow(row) {
  const time = Number(row?.time) || 0;
  if (!time) return null;
  const normalized = {
    time,
    a: toNumberOrNull(row?.a),
    b: toNumberOrNull(row?.b),
    p: toNumberOrNull(row?.p),
    v: toNumberOrNull(row?.v)
  };
  if ("source" in (row || {})) {
    normalized.source = row?.source ?? null;
  }
  return normalized;
}

export function compactHistoryRows(rows, options = {}) {
  const nowTime = Number(options.nowTime) || Math.floor(Date.now() / 1000);
  const hourlyRetentionDays = Math.max(0, Number(options.hourlyRetentionDays) || DEFAULT_HOURLY_RETENTION_DAYS);
  const hourlyCutoff = nowTime - hourlyRetentionDays * 86400;

  const normalizedRows = (Array.isArray(rows) ? rows : [])
    .map(normalizeRow)
    .filter(Boolean)
    .sort((left, right) => left.time - right.time);

  if (!normalizedRows.length) return [];
  if (hourlyRetentionDays === 0) {
    return aggregateRowsByDay(normalizedRows);
  }

  const olderRows = [];
  const recentRows = [];
  for (const row of normalizedRows) {
    if (row.time < hourlyCutoff) olderRows.push(row);
    else recentRows.push(row);
  }

  const aggregatedOlderRows = aggregateRowsByDay(olderRows);
  return [...aggregatedOlderRows, ...recentRows].sort((left, right) => left.time - right.time);
}

export function aggregateRowsByDay(rows) {
  const sortedRows = (Array.isArray(rows) ? rows : [])
    .map(normalizeRow)
    .filter(Boolean)
    .sort((left, right) => left.time - right.time);

  if (!sortedRows.length) return [];

  const groups = new Map();
  for (const row of sortedRows) {
    const dayKey = buildDayKeyUtc(row.time);
    const group = groups.get(dayKey) || [];
    group.push(row);
    groups.set(dayKey, group);
  }

  return Array.from(groups.values()).map(groupRows => {
    const latestTime = groupRows[groupRows.length - 1].time;
    const source = getMostRecentNonNull(groupRows, "source");
    const aggregated = {
      time: latestTime,
      a: getMedian(groupRows.map(row => row.a)),
      b: getMedian(groupRows.map(row => row.b)),
      p: getMedian(groupRows.map(row => row.p)),
      v: groupRows.reduce((sum, row) => sum + Math.max(0, toNumberOrNull(row.v) || 0), 0)
    };
    if (source != null) {
      aggregated.source = source;
    }
    return aggregated;
  });
}

export function updateVariantManifestEntry(existingEntry, rows, itemRelativePath, hourlyRetentionDays = DEFAULT_HOURLY_RETENTION_DAYS) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const earliestTime = normalizedRows[0]?.time ?? null;
  const latestTime = normalizedRows[normalizedRows.length - 1]?.time ?? null;
  const maxDays = earliestTime && latestTime
    ? Math.max(1, Math.ceil((Number(latestTime) - Number(earliestTime)) / 86400) + 1)
    : 0;

  return {
    ...(existingEntry || {}),
    path: itemRelativePath,
    rows: normalizedRows.length,
    earliestTime,
    latestTime,
    maxDays,
    hourlyRetentionDays
  };
}

export function buildEmptyOfficialManifest(sourceName) {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    sourceName,
    latestSnapshot: null,
    items: {}
  };
}

export function toSafeFilename(value) {
  return String(value)
    .replace(/^\/+/, "")
    .replace(/[\\/:%?&#=+ ]/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function getOfficialHistoryPaths(outDir, options = {}) {
  const resolvedOutDir = path.resolve(outDir);
  const docsRoot = path.resolve(options.docsRoot || inferDocsRootFromOutDir(resolvedOutDir));
  return {
    outDir: resolvedOutDir,
    snapshotsDir: path.join(resolvedOutDir, "snapshots"),
    itemsDir: path.join(resolvedOutDir, "items"),
    latestPath: path.join(resolvedOutDir, "latest.json"),
    manifestPath: path.join(resolvedOutDir, "manifest.json"),
    publicMarketDir: path.join(docsRoot, "market"),
    publicHistoryDir: path.join(docsRoot, "market", "history", "official"),
    publicApiPath: path.join(docsRoot, "market", "api.json"),
    publicManifestPath: path.join(docsRoot, "market", "manifest.json"),
    publicHistoryManifestPath: path.join(docsRoot, "market", "history", "official", "manifest.json")
  };
}
