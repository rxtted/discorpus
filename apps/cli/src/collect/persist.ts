import path from "node:path";

import { ensureCorpusDatabase, indexSnapshot } from "@discorpus/db";
import { createSnapshotPaths, writeJsonFile } from "@discorpus/storage";

import type { CliArtifactRecord, CliSnapshotRecord, CliVersionSet, DesktopAsarExtraction, WebCaptureManifest } from "../types/collect.js";
import type { WindowsDesktopManifest } from "@discorpus/platform-windows";

export async function persistDesktopSnapshot(
  snapshot: CliSnapshotRecord,
  manifest: WindowsDesktopManifest,
  records: CliArtifactRecord[],
  versionSet: CliVersionSet,
  extraction: DesktopAsarExtraction | null,
  dataDir: string,
): Promise<string> {
  const baseDir = path.join(dataDir, "snapshots");
  const paths = await createSnapshotPaths(baseDir, snapshot.id);

  await writeSnapshotFiles(paths.rootDir, records, snapshot);
  await writeJsonFile(path.join(paths.desktopDir, "build-info.json"), manifest.buildInfo);
  await writeJsonFile(path.join(paths.desktopDir, "bootstrap-manifest.json"), manifest.bootstrapManifest);
  await writeJsonFile(path.join(paths.desktopDir, "module-manifests.json"), manifest.moduleManifests);
  await writeJsonFile(path.join(paths.desktopDir, "asar-archives.json"), extraction?.archives ?? []);
  await writeJsonFile(path.join(paths.desktopDir, "install.json"), manifest.install);
  await writeJsonFile(path.join(paths.desktopDir, "version.json"), versionSet.decision);

  return paths.rootDir;
}

export async function persistWebSnapshot(
  snapshot: CliSnapshotRecord,
  manifest: WebCaptureManifest,
  records: CliArtifactRecord[],
  versionSet: CliVersionSet,
  dataDir: string,
): Promise<string> {
  const baseDir = path.join(dataDir, "snapshots");
  const paths = await createSnapshotPaths(baseDir, snapshot.id);

  await writeSnapshotFiles(paths.rootDir, records, snapshot);
  await writeJsonFile(path.join(paths.webDir, "document.json"), manifest.document);
  await writeJsonFile(path.join(paths.webDir, "assets.json"), manifest.assets);
  await writeJsonFile(path.join(paths.webDir, "manifest.json"), {
    assetUrls: manifest.assetUrls,
    buildNumber: manifest.buildNumber,
    channel: manifest.channel,
    entryUrl: manifest.entryUrl,
  });
  await writeJsonFile(path.join(paths.webDir, "version.json"), versionSet.decision);

  return paths.rootDir;
}

export async function persistSnapshotIndex(
  snapshot: CliSnapshotRecord,
  records: CliArtifactRecord[],
  versionSet: CliVersionSet,
  dataDir: string,
): Promise<string> {
  const db = await ensureCorpusDatabase(dataDir);
  indexSnapshot(db.databasePath, snapshot, versionSet, records);
  return db.databasePath;
}

async function writeSnapshotFiles(
  rootDir: string,
  records: CliArtifactRecord[],
  snapshot: CliSnapshotRecord,
): Promise<void> {
  await writeJsonFile(path.join(rootDir, "snapshot.json"), snapshot);
  await writeJsonFile(path.join(rootDir, "artifacts.json"), records);
  await writeJsonFile(
    path.join(rootDir, "blob-index.json"),
    records.map((record) => ({
      id: record.id,
      path: record.path,
      sha256: record.sha256,
      blob: record.blob ?? null,
    })),
  );
}
