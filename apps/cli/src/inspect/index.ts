import { ensureCorpusDatabase, findArtifacts, getArtifactsBySnapshotId, getArtifactKindCounts, getLatestSnapshot, getPreviousSnapshot, getSnapshotByIdOrDirName, listSnapshots } from "@discorpus/db";
import type { ReleaseChannel } from "@discorpus/core";

import { createArchiveResult, createFindArtifactResult, createSnapshotListItem, createSnapshotSummaryResult, diffArtifacts, listSnapshotArchives, listSnapshotInspectableFiles, resolveSnapshotArchive } from "./helpers.js";
import { printAmbiguousArchiveMatches, printArchiveDetails, printArtifactSearchResults, printDiffSummary, printNoPreviousDiff, printSnapshotEntries, printSnapshotSummary, printSnapshotTree } from "../output/inspect.js";
import { type CollectLayer, toArtifactCountObjectFromRows, getCorpusDataDir } from "../shared.js";

export async function runInspectLatest(layer: CollectLayer, channel: ReleaseChannel, json: boolean): Promise<void> {
  const db = await ensureCorpusDatabase(getCorpusDataDir());
  const snapshot = getLatestSnapshot(db.databasePath, channel, layer);

  if (!snapshot) {
    console.error(`no indexed snapshot found for channel ${channel} and layer ${layer}`);
    process.exitCode = 1;
    return;
  }

  const counts = getArtifactKindCounts(db.databasePath, snapshot.id);
  const result = createSnapshotSummaryResult(snapshot, db.databasePath, toArtifactCountObjectFromRows(counts));

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printSnapshotSummary(snapshot, db.databasePath, counts);
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
  const result = createSnapshotSummaryResult(snapshot, db.databasePath, toArtifactCountObjectFromRows(counts));

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printSnapshotSummary(snapshot, db.databasePath, counts);
}

export async function runListSnapshots(layer: CollectLayer | null, json: boolean): Promise<void> {
  const db = await ensureCorpusDatabase(getCorpusDataDir());
  const snapshots = listSnapshots(db.databasePath, layer ?? undefined);
  const result = {
    dbPath: db.databasePath,
    layer: layer ?? null,
    snapshots: snapshots.map(createSnapshotListItem),
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printSnapshotTree(db.databasePath, snapshots);
}

export async function runFindArtifact(
  filters: { kind?: string; pathFragment?: string; sha256?: string },
  json: boolean,
): Promise<void> {
  const db = await ensureCorpusDatabase(getCorpusDataDir());
  const results = findArtifacts(db.databasePath, filters, 50);

  if (json) {
    console.log(JSON.stringify(createFindArtifactResult(results, db.databasePath, filters), null, 2));
    return;
  }

  if (results.length === 0) {
    console.error("no artifacts found");
    process.exitCode = 1;
    return;
  }

  printArtifactSearchResults(results, db.databasePath);
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

  printSnapshotEntries(db.databasePath, snapshot.id, archives, files);
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
    printAmbiguousArchiveMatches(archiveName, archive);
    process.exitCode = 1;
    return;
  }

  const extractedArtifacts = artifacts.filter((item) => item.path.startsWith(`asar/${archive.path}!/`));
  const result = createArchiveResult(snapshot.id, archive, extractedArtifacts);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printArchiveDetails(snapshot.id, archive, extractedArtifacts);
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

    printNoPreviousDiff(latest.id);
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

  printDiffSummary(latest.id, previous.id, diff);
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
