import path from "node:path";

import { ensureCorpusDatabase, findArtifacts, getArtifactsBySnapshotId, getArtifactKindCounts, getLatestSnapshot, getPreviousSnapshot, getSnapshotByIdOrDirName, listSnapshots } from "@discorpus/db";
import type { ReleaseChannel } from "@discorpus/core";

import { type CollectLayer, formatArtifactCountRows, formatArtifactCounts, formatCorpusSummary, formatCount, formatFindFilters, formatSnapshotDirName, formatUpstreamSummary, getCorpusDataDir, toArtifactCountObject, toArtifactCountObjectFromRows, toPosixPath } from "./shared.js";

export async function runInspectLatest(layer: CollectLayer, channel: ReleaseChannel, json: boolean): Promise<void> {
  const db = await ensureCorpusDatabase(getCorpusDataDir());
  const snapshot = getLatestSnapshot(db.databasePath, channel, layer);

  if (!snapshot) {
    console.error(`no indexed snapshot found for channel ${channel} and layer ${layer}`);
    process.exitCode = 1;
    return;
  }

  const counts = getArtifactKindCounts(db.databasePath, snapshot.id);
  const result = {
    appVersion: snapshot.app_version,
    artifactKindCounts: toArtifactCountObjectFromRows(counts),
    channel: snapshot.channel,
    corpusVersionId: snapshot.corpus_version_id,
    dbPath: db.databasePath,
    isNewCorpusVersion: snapshot.is_new_corpus_version === 1,
    isNewUpstreamVersion: snapshot.is_new_upstream_version === 1,
    layer: snapshot.layer,
    observedAt: snapshot.observed_at,
    platform: snapshot.platform,
    releaseId: snapshot.release_id,
    snapshotId: snapshot.id,
    target: snapshot.target,
    upstreamSummary: formatUpstreamSummary(snapshot.app_version, snapshot.release_id, []),
    upstreamVersionId: snapshot.upstream_version_id,
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("discorpus");
  console.log(`snapshot id: ${snapshot.id}`);
  console.log(`target: ${snapshot.target}`);
  console.log(`channel: ${snapshot.channel}`);
  console.log(`platform: ${snapshot.platform}`);
  console.log(`layer: ${snapshot.layer}`);
  console.log(`observed at: ${snapshot.observed_at}`);
  console.log(`app version: ${snapshot.app_version ?? "none"}`);
  console.log(`release id: ${snapshot.release_id ?? "none"}`);
  console.log(`upstream build: ${result.upstreamSummary}`);
  console.log(`corpus version: ${formatCorpusSummary(snapshot.corpus_version_id)}`);
  console.log(`new upstream version: ${snapshot.is_new_upstream_version === 1 ? "true" : "false"}`);
  console.log(`new corpus version: ${snapshot.is_new_corpus_version === 1 ? "true" : "false"}`);
  console.log(`sqlite db: ${db.databasePath}`);
  console.log(`artifact kinds: ${formatArtifactCountRows(counts)}`);
}

export async function runInspectSnapshot(snapshotId: string, json: boolean): Promise<void> {
  const db = await ensureCorpusDatabase(getCorpusDataDir());
  const snapshot = getSnapshotByIdOrDirName(db.databasePath, snapshotId);

  if (!snapshot) {
    console.error(`snapshot not found: ${snapshotId}`);
    process.exitCode = 1;
    return;
  }

  const counts = getArtifactKindCounts(db.databasePath, snapshot.id);
  const result = {
    appVersion: snapshot.app_version,
    artifactKindCounts: toArtifactCountObjectFromRows(counts),
    channel: snapshot.channel,
    corpusVersionId: snapshot.corpus_version_id,
    dbPath: db.databasePath,
    isNewCorpusVersion: snapshot.is_new_corpus_version === 1,
    isNewUpstreamVersion: snapshot.is_new_upstream_version === 1,
    layer: snapshot.layer,
    observedAt: snapshot.observed_at,
    platform: snapshot.platform,
    releaseId: snapshot.release_id,
    snapshotId: snapshot.id,
    target: snapshot.target,
    upstreamSummary: formatUpstreamSummary(snapshot.app_version, snapshot.release_id, []),
    upstreamVersionId: snapshot.upstream_version_id,
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("discorpus");
  console.log(`snapshot id: ${snapshot.id}`);
  console.log(`target: ${snapshot.target}`);
  console.log(`channel: ${snapshot.channel}`);
  console.log(`platform: ${snapshot.platform}`);
  console.log(`layer: ${snapshot.layer}`);
  console.log(`observed at: ${snapshot.observed_at}`);
  console.log(`app version: ${snapshot.app_version ?? "none"}`);
  console.log(`release id: ${snapshot.release_id ?? "none"}`);
  console.log(`upstream build: ${result.upstreamSummary}`);
  console.log(`corpus version: ${formatCorpusSummary(snapshot.corpus_version_id)}`);
  console.log(`new upstream version: ${snapshot.is_new_upstream_version === 1 ? "true" : "false"}`);
  console.log(`new corpus version: ${snapshot.is_new_corpus_version === 1 ? "true" : "false"}`);
  console.log(`sqlite db: ${db.databasePath}`);
  console.log(`artifact kinds: ${formatArtifactCountRows(counts)}`);
}

export async function runListSnapshots(layer: CollectLayer | null, json: boolean): Promise<void> {
  const db = await ensureCorpusDatabase(getCorpusDataDir());
  const snapshots = listSnapshots(db.databasePath, layer ?? undefined);
  const result = {
    dbPath: db.databasePath,
    layer: layer ?? null,
    snapshots: snapshots.map((snapshot) => ({
      appVersion: snapshot.app_version,
      channel: snapshot.channel,
      corpusVersionId: snapshot.corpus_version_id,
      dirName: formatSnapshotDirName(snapshot.id),
      id: snapshot.id,
      isNewCorpusVersion: snapshot.is_new_corpus_version === 1,
      isNewUpstreamVersion: snapshot.is_new_upstream_version === 1,
      layer: snapshot.layer,
      observedAt: snapshot.observed_at,
      platform: snapshot.platform,
      releaseId: snapshot.release_id,
      target: snapshot.target,
    })),
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`sqlite db: ${db.databasePath}`);
  console.log(`snapshots: ${snapshots.length}`);

  if (snapshots.length === 0) {
    console.log("status: no snapshots indexed");
    return;
  }

  console.log("");

  const channelCounts = new Map<string, number>();

  for (const snapshot of snapshots) {
    channelCounts.set(snapshot.channel, (channelCounts.get(snapshot.channel) ?? 0) + 1);
  }

  let currentChannel: string | null = null;
  let currentLayer: string | null = null;

  for (const snapshot of snapshots) {
    if (snapshot.channel !== currentChannel) {
      currentChannel = snapshot.channel;
      currentLayer = null;
      console.log(`- ${currentChannel} [${formatCount(channelCounts.get(currentChannel) ?? 0, "snapshot")}]`);
    }

    if (snapshot.layer !== currentLayer) {
      currentLayer = snapshot.layer;
      console.log(`  ├─ ${currentLayer}`);
    }

    const dirName = formatSnapshotDirName(snapshot.id);
    const version = snapshot.app_version ?? "unknown";
    const releaseId = snapshot.release_id ?? snapshot.channel;
    console.log(`  │  └─ ${dirName}  ${releaseId} ${version}  ${snapshot.observed_at}`);
  }
}

export async function runFindArtifact(
  filters: { kind?: string; pathFragment?: string; sha256?: string },
  json: boolean,
): Promise<void> {
  const db = await ensureCorpusDatabase(getCorpusDataDir());
  const results = findArtifacts(db.databasePath, filters, 50);

  if (json) {
    console.log(JSON.stringify({
      dbPath: db.databasePath,
      filters,
      results,
    }, null, 2));
    return;
  }

  if (results.length === 0) {
    console.error("no artifacts found");
    process.exitCode = 1;
    return;
  }

  console.log("discorpus");
  console.log(`results: ${results.length}`);
  console.log(`sqlite db: ${db.databasePath}`);

  for (const result of results.slice(0, 20)) {
    console.log(`${result.kind} ${result.path}`);
    console.log(`snapshot: ${result.snapshot_id}`);
    console.log(`scope: ${result.channel} ${result.platform} ${result.layer}`);
    console.log(`observed at: ${result.observed_at}`);
    console.log(`sha256: ${result.sha256}`);
    console.log(`blob: ${result.blob_path ?? "none"}`);
  }
}

export async function runListEntries(snapshotId: string, json: boolean): Promise<void> {
  const db = await ensureCorpusDatabase(getCorpusDataDir());
  const snapshot = getSnapshotByIdOrDirName(db.databasePath, snapshotId);

  if (!snapshot) {
    console.error(`snapshot not found: ${snapshotId}`);
    process.exitCode = 1;
    return;
  }

  const artifacts = getArtifactsBySnapshotId(db.databasePath, snapshot.id);
  const archives = listSnapshotArchives(artifacts);
  const files = listSnapshotInspectableFiles(artifacts);
  const result = {
    archives,
    files,
    snapshotId: snapshot.id,
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`sqlite db: ${db.databasePath}`);
  console.log(`snapshot id: ${snapshot.id}`);
  console.log("");
  console.log(`- archives [${formatCount(archives.length, "archive")}]`);

  if (archives.length === 0) {
    console.log("  └─ none");
  } else {
    for (const archive of archives) {
      console.log(`  └─ ${archive.name}  ${archive.path}`);
    }
  }

  console.log(`- files [${formatCount(files.length, "file")}]`);

  if (files.length === 0) {
    console.log("  └─ none");
    return;
  }

  for (const file of files.slice(0, 40)) {
    console.log(`  └─ ${file.kind}  ${file.path}`);
  }
}

export async function runInspectArchive(snapshotId: string, archiveName: string, json: boolean): Promise<void> {
  const db = await ensureCorpusDatabase(getCorpusDataDir());
  const snapshot = getSnapshotByIdOrDirName(db.databasePath, snapshotId);

  if (!snapshot) {
    console.error(`snapshot not found: ${snapshotId}`);
    process.exitCode = 1;
    return;
  }

  const artifacts = getArtifactsBySnapshotId(db.databasePath, snapshot.id);
  const archives = listSnapshotArchives(artifacts);
  const archive = resolveSnapshotArchive(archives, archiveName);

  if (!archive) {
    console.error(`archive not found in snapshot: ${archiveName}`);
    process.exitCode = 1;
    return;
  }

  if (Array.isArray(archive)) {
    console.error(`archive name is ambiguous: ${archiveName}`);
    console.error("matches:");

    for (const match of archive) {
      console.error(`${match.name} ${match.path}`);
    }

    process.exitCode = 1;
    return;
  }

  const extractedArtifacts = artifacts.filter((item) => item.path.startsWith(`asar/${archive.path}!/`));
  const topLevelEntries = summarizeArchiveTopLevelEntries(extractedArtifacts, archive.path);
  const kindCounts = countArtifactKindsFromRows(extractedArtifacts);
  const result = {
    archive: {
      kind: archive.kind,
      name: archive.name,
      path: archive.path,
      sha256: archive.sha256,
      size: archive.size,
    },
    extractedFileCount: extractedArtifacts.length,
    extractedKindCounts: toArtifactCountObject(kindCounts),
    snapshotId: snapshot.id,
    topLevelEntries,
    sampleFiles: extractedArtifacts.slice(0, 20).map((item) => ({
      kind: item.kind,
      path: item.path,
      sha256: item.sha256,
    })),
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("discorpus");
  console.log(`snapshot id: ${snapshot.id}`);
  console.log(`archive: ${archive.name}`);
  console.log(`archive path: ${archive.path}`);
  console.log(`archive kind: ${archive.kind}`);
  console.log(`archive sha256: ${archive.sha256}`);
  console.log(`archive size: ${archive.size}`);
  console.log(`extracted files: ${extractedArtifacts.length}`);
  console.log(`extracted kinds: ${formatArtifactCounts(kindCounts)}`);
  console.log(`top level: ${topLevelEntries.join(", ") || "none"}`);

  for (const item of extractedArtifacts.slice(0, 20)) {
    console.log(`${item.kind} ${item.path}`);
  }
}

export async function runListEntriesForLatest(
  layer: CollectLayer,
  channel: ReleaseChannel,
  json: boolean,
): Promise<void> {
  const snapshot = await requireLatestSnapshot(channel, layer);
  await runListEntries(snapshot.id, json);
}

export async function runInspectArchiveForLatest(
  layer: CollectLayer,
  channel: ReleaseChannel,
  archiveName: string,
  json: boolean,
): Promise<void> {
  const snapshot = await requireLatestSnapshot(channel, layer);
  await runInspectArchive(snapshot.id, archiveName, json);
}

export async function runDiffLatest(layer: CollectLayer, channel: ReleaseChannel, json: boolean): Promise<void> {
  const db = await ensureCorpusDatabase(getCorpusDataDir());
  const latest = getLatestSnapshot(db.databasePath, channel, layer);

  if (!latest) {
    console.error(`no indexed snapshot found for channel ${channel} and layer ${layer}`);
    process.exitCode = 1;
    return;
  }

  const previous = getPreviousSnapshot(db.databasePath, channel, layer, latest.observed_at);

  if (!previous) {
    const result = {
      channel,
      currentSnapshotId: latest.id,
      layer,
      previousSnapshotId: null,
      reason: "no previous snapshot in lineage",
    };

    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log("discorpus");
    console.log(`current snapshot: ${latest.id}`);
    console.log("previous snapshot: none");
    console.log("status: no previous snapshot in lineage");
    return;
  }

  const latestArtifacts = getArtifactsBySnapshotId(db.databasePath, latest.id);
  const previousArtifacts = getArtifactsBySnapshotId(db.databasePath, previous.id);
  const diff = diffArtifacts(previousArtifacts, latestArtifacts);
  const result = {
    added: diff.added,
    changed: diff.changed,
    channel,
    currentSnapshotId: latest.id,
    layer,
    previousSnapshotId: previous.id,
    removed: diff.removed,
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("discorpus");
  console.log(`current snapshot: ${latest.id}`);
  console.log(`previous snapshot: ${previous.id}`);
  console.log(`added: ${diff.added.length}`);
  console.log(`removed: ${diff.removed.length}`);
  console.log(`changed: ${diff.changed.length}`);

  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    console.log("status: no artifact changes detected");
    return;
  }

  for (const item of diff.added.slice(0, 10)) {
    console.log(`added ${item.kind} ${item.path}`);
  }

  for (const item of diff.removed.slice(0, 10)) {
    console.log(`removed ${item.kind} ${item.path}`);
  }

  for (const item of diff.changed.slice(0, 10)) {
    console.log(`changed ${item.current.path}`);
    console.log(`from: ${item.previous.sha256}`);
    console.log(`to: ${item.current.sha256}`);
  }
}

async function requireLatestSnapshot(
  channel: ReleaseChannel,
  layer: CollectLayer,
): Promise<NonNullable<ReturnType<typeof getLatestSnapshot>>> {
  const db = await ensureCorpusDatabase(getCorpusDataDir());
  const snapshot = getLatestSnapshot(db.databasePath, channel, layer);

  if (!snapshot) {
    console.error(`no indexed snapshot found for channel ${channel} and layer ${layer}`);
    process.exitCode = 1;
    throw new Error("latest snapshot not found");
  }

  return snapshot;
}

function countArtifactKindsFromRows(
  rows: Array<{
    kind: string;
  }>,
): Map<string, number> {
  const counts = new Map<string, number>();

  for (const row of rows) {
    counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
  }

  return counts;
}

function diffArtifacts(
  previousArtifacts: Array<{
    kind: string;
    path: string;
    sha256: string;
  }>,
  currentArtifacts: Array<{
    kind: string;
    path: string;
    sha256: string;
  }>,
): {
  added: typeof currentArtifacts;
  changed: Array<{
    current: (typeof currentArtifacts)[number];
    previous: (typeof previousArtifacts)[number];
  }>;
  removed: typeof previousArtifacts;
} {
  const previousByPath = new Map(previousArtifacts.map((artifact) => [artifact.path, artifact]));
  const currentByPath = new Map(currentArtifacts.map((artifact) => [artifact.path, artifact]));

  const added = currentArtifacts.filter((artifact) => !previousByPath.has(artifact.path));
  const removed = previousArtifacts.filter((artifact) => !currentByPath.has(artifact.path));
  const changed = currentArtifacts
    .map((artifact) => {
      const previous = previousByPath.get(artifact.path);

      if (!previous || previous.sha256 === artifact.sha256) {
        return null;
      }

      return {
        current: artifact,
        previous,
      };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null);

  return {
    added,
    removed,
    changed,
  };
}

function listSnapshotArchives(
  artifacts: Array<{
    kind: string;
    path: string;
    sha256: string;
    size: number;
  }>,
): Array<{
  kind: string;
  name: string;
  path: string;
  sha256: string;
  size: number;
}> {
  return artifacts
    .filter((artifact) => artifact.kind === "app_asar" || artifact.kind === "module_asar")
    .map((artifact) => ({
      kind: artifact.kind,
      name: path.posix.basename(toPosixPath(artifact.path)),
      path: toPosixPath(artifact.path),
      sha256: artifact.sha256,
      size: artifact.size,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function listSnapshotInspectableFiles(
  artifacts: Array<{
    kind: string;
    path: string;
  }>,
): Array<{
  kind: string;
  path: string;
}> {
  return artifacts
    .filter((artifact) =>
      artifact.kind === "updater" ||
      artifact.kind === "desktop_executable" ||
      artifact.kind === "app_asar" ||
      artifact.kind === "module_asar" ||
      artifact.kind === "update_package" ||
      artifact.kind === "update_releases" ||
      artifact.kind === "module_manifest" ||
      artifact.kind === "module_package" ||
      artifact.kind === "web_document" ||
      artifact.kind === "web_script" ||
      artifact.kind === "web_stylesheet" ||
      artifact.kind === "web_json" ||
      artifact.kind === "web_source_map" ||
      artifact.kind === "web_asset"
    )
    .map((artifact) => ({
      kind: artifact.kind,
      path: toPosixPath(artifact.path),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function resolveSnapshotArchive(
  archives: Array<{
    kind: string;
    name: string;
    path: string;
    sha256: string;
    size: number;
  }>,
  value: string,
):
  | {
      kind: string;
      name: string;
      path: string;
      sha256: string;
      size: number;
    }
  | Array<{
      kind: string;
      name: string;
      path: string;
      sha256: string;
      size: number;
    }>
  | null {
  const normalizedValue = toPosixPath(value);
  const exactNameMatches = archives.filter((archive) => archive.name === normalizedValue);

  if (exactNameMatches.length === 1) {
    return exactNameMatches[0];
  }

  if (exactNameMatches.length > 1) {
    return exactNameMatches;
  }

  const exactPathMatches = archives.filter((archive) => archive.path === normalizedValue);

  if (exactPathMatches.length === 1) {
    return exactPathMatches[0];
  }

  if (exactPathMatches.length > 1) {
    return exactPathMatches;
  }

  const suffixMatches = archives.filter((archive) => archive.path.endsWith(`/${normalizedValue}`) || archive.path.endsWith(normalizedValue));

  if (suffixMatches.length === 1) {
    return suffixMatches[0];
  }

  if (suffixMatches.length > 1) {
    return suffixMatches;
  }

  return null;
}

function summarizeArchiveTopLevelEntries(
  artifacts: Array<{
    path: string;
  }>,
  archivePath: string,
): string[] {
  const prefix = `asar/${archivePath}!/`;
  const names = new Set<string>();

  for (const artifact of artifacts) {
    const relativePath = artifact.path.slice(prefix.length);
    const topLevelEntry = relativePath.split("/")[0];

    if (topLevelEntry) {
      names.add(topLevelEntry);
    }
  }

  return [...names].sort();
}
