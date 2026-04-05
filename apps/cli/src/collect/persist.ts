import path from "node:path";

import { ensureCorpusDatabase, indexSnapshot } from "@discorpus/db";
import type { DevtoolsCapturedResource } from "@discorpus/runtime-cdp";
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
  await writeJsonFile(path.join(paths.webDir, "document.json"), serializeWebDocument(manifest.document));
  await writeJsonFile(path.join(paths.webDir, "assets.json"), manifest.assets.map(serializeWebAsset));
  await writeJsonFile(path.join(paths.webDir, "excluded-assets.json"), manifest.excludedAssets);
  await writeJsonFile(path.join(paths.webDir, "missed-assets.json"), manifest.missedAssets);
  await writeJsonFile(path.join(paths.webDir, "manifest.json"), {
    assetUrls: manifest.assetUrls,
    buildNumber: manifest.buildNumber,
    channel: manifest.channel,
    entryUrl: manifest.entryUrl,
  });
  await writeJsonFile(path.join(paths.webDir, "runtime-discovery.json"), serializeRuntimeDiscovery(manifest.runtimeDiscovery));
  await writeJsonFile(path.join(paths.webDir, "runtime-summary.json"), manifest.runtimeDiscovery?.summary ?? null);
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

function serializeWebDocument(document: WebCaptureManifest["document"]): object {
  return {
    contentType: document.contentType,
    finalUrl: document.finalUrl,
    headers: document.headers ?? null,
    resourceType: document.resourceType ?? null,
    sha256: document.sha256,
    size: document.size,
    status: document.status,
    url: document.url,
  };
}

function serializeWebAsset(asset: WebCaptureManifest["assets"][number]): object {
  return {
    contentType: asset.contentType,
    finalUrl: asset.finalUrl,
    headers: asset.headers ?? null,
    kind: asset.kind,
    path: asset.path,
    resourceType: asset.resourceType ?? null,
    sha256: asset.sha256,
    size: asset.size,
    status: asset.status,
    url: asset.url,
  };
}

function serializeRuntimeDiscovery(runtimeDiscovery: WebCaptureManifest["runtimeDiscovery"]): object | null {
  if (!runtimeDiscovery) {
    return null;
  }

  return {
    capture: runtimeDiscovery.capture
      ? {
          finishedAt: runtimeDiscovery.capture.finishedAt,
          quietPeriodMs: runtimeDiscovery.capture.quietPeriodMs,
          resources: runtimeDiscovery.capture.resources.map((resource: DevtoolsCapturedResource) => ({
            bodyError: resource.bodyError,
            bodyState: resource.bodyState,
            contentType: resource.contentType,
            encodedDataLength: resource.encodedDataLength,
            finalUrl: resource.finalUrl,
            fromDiskCache: resource.fromDiskCache,
            hasBody: resource.body !== null,
            headers: resource.headers,
            requestId: resource.requestId,
            resourceType: resource.resourceType,
            size: resource.body?.length ?? 0,
            status: resource.status,
            url: resource.url,
          })),
          startedAt: runtimeDiscovery.capture.startedAt,
        }
      : null,
    devtoolsBaseUrl: runtimeDiscovery.devtoolsBaseUrl,
    launchPlan: runtimeDiscovery.launchPlan,
    selectedTarget: runtimeDiscovery.selectedTarget,
    summary: runtimeDiscovery.summary,
    targetCount: runtimeDiscovery.targetCount,
    targets: runtimeDiscovery.targets,
    version: runtimeDiscovery.version,
  };
}
