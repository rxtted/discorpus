import { createSnapshotDirName } from "@discorpus/storage";

import type { ArtifactKindCountRow, ArtifactSearchRow, LatestSnapshotRow, SnapshotListRow } from "@discorpus/db";

import type { ArchiveEntry, ArtifactDiff, InspectableEntry, SnapshotArtifact } from "../types/inspect.js";
import { countKinds, formatArtifactCountRows, formatArtifactCounts, formatCorpusSummary, formatCount, formatUpstreamSummary } from "../shared.js";

export function printSnapshotSummary(
  snapshot: LatestSnapshotRow,
  dbPath: string,
  counts: ArtifactKindCountRow[],
): void {
  console.log(`snapshot id: ${snapshot.id}`);
  console.log(`target: ${snapshot.target}`);
  console.log(`channel: ${snapshot.channel}`);
  console.log(`platform: ${snapshot.platform}`);
  console.log(`layer: ${snapshot.layer}`);
  console.log(`observed at: ${snapshot.observed_at}`);
  console.log(`app version: ${snapshot.app_version ?? "none"}`);
  console.log(`release id: ${snapshot.release_id ?? "none"}`);
  console.log(`upstream build: ${formatUpstreamSummary(snapshot.app_version, snapshot.release_id, [])}`);
  console.log(`corpus version: ${formatCorpusSummary(snapshot.corpus_version_id)}`);
  console.log(`new upstream version: ${snapshot.is_new_upstream_version === 1 ? "true" : "false"}`);
  console.log(`new corpus version: ${snapshot.is_new_corpus_version === 1 ? "true" : "false"}`);
  console.log(`sqlite db: ${dbPath}`);
  console.log(`artifact kinds: ${formatArtifactCountRows(counts)}`);
}

export function printSnapshotTree(
  dbPath: string,
  snapshots: SnapshotListRow[],
): void {
  console.log(`sqlite db: ${dbPath}`);
  console.log(`snapshots: ${snapshots.length}`);

  if (snapshots.length === 0) {
    console.log("no snapshots indexed");
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

    const dirName = createSnapshotDirName(snapshot.id);
    const version = snapshot.app_version ?? "unknown";
    const releaseId = snapshot.release_id ?? snapshot.channel;
    console.log(`  │  └─ ${dirName}  ${releaseId} ${version}  ${snapshot.observed_at}`);
  }
}

export function printArtifactSearchResults(results: ArtifactSearchRow[], dbPath: string): void {
  console.log(`results: ${results.length}`);
  console.log(`sqlite db: ${dbPath}`);

  if (results.length === 0) {
    console.log("no artifacts found");
    return;
  }

  for (const result of results.slice(0, 20)) {
    console.log(`${result.kind} ${result.path}`);
    console.log(`snapshot: ${result.snapshot_id}`);
    console.log(`scope: ${result.channel} ${result.platform} ${result.layer}`);
    console.log(`observed at: ${result.observed_at}`);
    console.log(`sha256: ${result.sha256}`);
    console.log(`blob: ${result.blob_path ?? "none"}`);
  }
}

export function printSnapshotEntries(
  dbPath: string,
  snapshotId: string,
  archives: ArchiveEntry[],
  files: InspectableEntry[],
): void {
  console.log(`sqlite db: ${dbPath}`);
  console.log(`snapshot id: ${snapshotId}`);
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

export function printAmbiguousArchiveMatches(archiveName: string, matches: ArchiveEntry[]): void {
  console.error(`archive name is ambiguous: ${archiveName}`);
  console.error("matches:");

  for (const match of matches) {
    console.error(`${match.name} ${match.path}`);
  }
}

export function printArchiveDetails(snapshotId: string, archive: ArchiveEntry, extractedArtifacts: SnapshotArtifact[]): void {
  const topLevelEntries = extractedArtifacts.length > 0
    ? [...new Set(extractedArtifacts.map((item) => item.path.replace(`asar/${archive.path}!/`, "").split("/")[0]).filter(Boolean))].sort()
    : [];

  console.log(`snapshot id: ${snapshotId}`);
  console.log(`archive: ${archive.name}`);
  console.log(`archive path: ${archive.path}`);
  console.log(`archive kind: ${archive.kind}`);
  console.log(`archive sha256: ${archive.sha256}`);
  console.log(`archive size: ${archive.size}`);
  console.log(`extracted files: ${extractedArtifacts.length}`);
  console.log(`extracted kinds: ${formatArtifactCounts(countKinds(extractedArtifacts))}`);
  console.log(`top level: ${topLevelEntries.join(", ") || "none"}`);

  for (const item of extractedArtifacts.slice(0, 20)) {
    console.log(`${item.kind} ${item.path}`);
  }
}

export function printDiffSummary(currentSnapshotId: string, previousSnapshotId: string, diff: ArtifactDiff): void {
  console.log(`current snapshot: ${currentSnapshotId}`);
  console.log(`previous snapshot: ${previousSnapshotId}`);
  console.log(`added: ${diff.added.length}`);
  console.log(`removed: ${diff.removed.length}`);
  console.log(`changed: ${diff.changed.length}`);

  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    console.log("no artifact changes detected");
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

export function printNoPreviousDiff(currentSnapshotId: string): void {
  console.log(`current snapshot: ${currentSnapshotId}`);
  console.log("previous snapshot: none");
  console.log("no previous snapshot in lineage");
}
