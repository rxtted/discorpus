import path from "node:path";

import type { ArtifactRow, ArtifactSearchRow, LatestSnapshotRow, SnapshotListRow } from "@discorpus/db";
import { createSnapshotDirName } from "@discorpus/storage";

import type { ArchiveEntry, ArtifactDiff, InspectableEntry, SnapshotArtifact } from "../types/inspect.js";
import { countKinds, toPosixPath } from "../shared.js";

export function createSnapshotSummaryResult(
  snapshot: LatestSnapshotRow,
  dbPath: string,
  artifactKindCounts: Record<string, number>,
): Record<string, unknown> {
  return {
    appVersion: snapshot.app_version,
    artifactKindCounts,
    channel: snapshot.channel,
    corpusVersionId: snapshot.corpus_version_id,
    dbPath,
    isNewCorpusVersion: snapshot.is_new_corpus_version === 1,
    isNewUpstreamVersion: snapshot.is_new_upstream_version === 1,
    layer: snapshot.layer,
    observedAt: snapshot.observed_at,
    platform: snapshot.platform,
    releaseId: snapshot.release_id,
    snapshotId: snapshot.id,
    target: snapshot.target,
    upstreamVersionId: snapshot.upstream_version_id,
  };
}

export function createSnapshotListItem(snapshot: SnapshotListRow): Record<string, unknown> {
  return {
    appVersion: snapshot.app_version,
    channel: snapshot.channel,
    corpusVersionId: snapshot.corpus_version_id,
    dirName: createSnapshotDirName(snapshot.id),
    id: snapshot.id,
    isNewCorpusVersion: snapshot.is_new_corpus_version === 1,
    isNewUpstreamVersion: snapshot.is_new_upstream_version === 1,
    layer: snapshot.layer,
    observedAt: snapshot.observed_at,
    platform: snapshot.platform,
    releaseId: snapshot.release_id,
    target: snapshot.target,
  };
}

export function createArchiveResult(
  snapshotId: string,
  archive: ArchiveEntry,
  extractedArtifacts: SnapshotArtifact[],
): Record<string, unknown> {
  return {
    archive: {
      kind: archive.kind,
      name: archive.name,
      path: archive.path,
      sha256: archive.sha256,
      size: archive.size,
    },
    extractedFileCount: extractedArtifacts.length,
    extractedKindCounts: Object.fromEntries([...countKinds(extractedArtifacts).entries()].sort((left, right) => left[0].localeCompare(right[0]))),
    sampleFiles: extractedArtifacts.slice(0, 20).map((item) => ({
      kind: item.kind,
      path: item.path,
      sha256: item.sha256,
    })),
    snapshotId,
    topLevelEntries: summarizeArchiveTopLevelEntries(extractedArtifacts, archive.path),
  };
}

export function diffArtifacts(previousArtifacts: SnapshotArtifact[], currentArtifacts: SnapshotArtifact[]): ArtifactDiff {
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
    .filter((value): value is ArtifactDiff["changed"][number] => value !== null);

  return { added, changed, removed };
}

export function listSnapshotArchives(artifacts: SnapshotArtifact[]): ArchiveEntry[] {
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

export function listSnapshotInspectableFiles(artifacts: SnapshotArtifact[]): InspectableEntry[] {
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
      artifact.kind === "web_html" ||
      artifact.kind === "web_script" ||
      artifact.kind === "web_stylesheet" ||
      artifact.kind === "web_json" ||
      artifact.kind === "web_source_map" ||
      artifact.kind === "web_wasm" ||
      artifact.kind === "web_font" ||
      artifact.kind === "web_image" ||
      artifact.kind === "web_media" ||
      artifact.kind === "web_asset"
    )
    .map((artifact) => ({
      kind: artifact.kind,
      path: toPosixPath(artifact.path),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function resolveSnapshotArchive(
  archives: ArchiveEntry[],
  value: string,
): ArchiveEntry | ArchiveEntry[] | null {
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

export function summarizeArchiveTopLevelEntries(artifacts: Array<Pick<ArtifactRow, "path">>, archivePath: string): string[] {
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

export function createFindArtifactResult(results: ArtifactSearchRow[], dbPath: string, filters: Record<string, string | undefined>): Record<string, unknown> {
  return {
    dbPath,
    filters,
    results,
  };
}
