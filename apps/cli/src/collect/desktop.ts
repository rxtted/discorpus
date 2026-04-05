import { createHash } from "node:crypto";
import path from "node:path";

import { extractAsarArchive } from "@discorpus/asar";
import type { ReleaseChannel, VersionSignal } from "@discorpus/core";
import type { WindowsDesktopInstall, WindowsDesktopManifest } from "@discorpus/platform-windows";
import { discoverWindowsDesktopInstall } from "@discorpus/platform-windows";
import { type DiskBlobStore, type InMemorySnapshotStore } from "@discorpus/storage";

import type { CliArtifactRecord, DesktopAsarArchiveRecord, DesktopAsarExtractionResult } from "../types/collect.js";
import { toPosixPath } from "../shared.js";

export async function requireDesktopInstall(channel: ReleaseChannel): Promise<WindowsDesktopInstall> {
  const install = await discoverWindowsDesktopInstall(channel);

  if (!install) {
    console.error(`desktop install not found for channel: ${channel}`);
    process.exitCode = 1;
    throw new Error("desktop install not found");
  }

  return install;
}

export function collectDesktopSignals(install: WindowsDesktopInstall, manifest: WindowsDesktopManifest): VersionSignal[] {
  const signals: VersionSignal[] = [];

  if (manifest.buildInfo?.version) {
    signals.push({ scope: "desktop", name: "build_info_version", value: manifest.buildInfo.version, confidence: "high" });
  }

  if (manifest.buildInfo?.releaseChannel) {
    signals.push({ scope: "desktop", name: "build_info_channel", value: manifest.buildInfo.releaseChannel, confidence: "high" });
  }

  signals.push({ scope: "desktop", name: "root_dir", value: install.rootDir, confidence: "medium" });

  for (const version of install.installedVersions) {
    signals.push({ scope: "desktop", name: "installed_version", value: version, confidence: "medium" });
  }

  if (install.currentAppDir) {
    signals.push({ scope: "desktop", name: "current_app_dir", value: install.currentAppDir, confidence: "medium" });
  }

  if (install.appAsarPath) {
    signals.push({ scope: "desktop", name: "app_asar_path", value: install.appAsarPath, confidence: "high" });
  }

  for (const moduleName of Object.keys(manifest.moduleManifests).sort()) {
    signals.push({ scope: "desktop", name: "module_manifest", value: moduleName, confidence: "medium" });
  }

  return signals;
}

export async function createDesktopArtifactRecords(
  snapshotId: string,
  snapshotStore: InMemorySnapshotStore,
  blobStore: DiskBlobStore,
  manifest: WindowsDesktopManifest,
): Promise<CliArtifactRecord[]> {
  return Promise.all(manifest.artifacts.map(async (artifact) => {
    const blob = await blobStore.persistFile(artifact.path, artifact.sha256, "raw");

    return snapshotStore.createArtifactRecord({
      snapshotId,
      kind: artifact.kind,
      path: artifact.relativePath,
      sha256: artifact.sha256,
      size: artifact.size,
      source: artifact.path,
      blob,
    });
  }));
}

export async function createExtractedAsarArtifactRecords(
  snapshotId: string,
  snapshotStore: InMemorySnapshotStore,
  blobStore: DiskBlobStore,
  manifest: WindowsDesktopManifest,
): Promise<DesktopAsarExtractionResult> {
  const archives: DesktopAsarArchiveRecord[] = [];
  const records: CliArtifactRecord[] = [];
  let extractedFileCount = 0;
  let unpackedFileCount = 0;

  for (const artifact of manifest.artifacts) {
    if (artifact.kind !== "app_asar" && artifact.kind !== "module_asar") {
      continue;
    }

    let archiveExtractedFileCount = 0;
    const relativeArchivePath = toPosixPath(artifact.relativePath);
    const archive = await extractAsarArchive(artifact.path, async (file) => {
      if (file.unpacked || !file.buffer) {
        return;
      }

      const sha256 = createHash("sha256").update(file.buffer).digest("hex");
      const blob = await blobStore.persistBuffer(file.buffer, sha256, "derived");

      records.push(snapshotStore.createArtifactRecord({
        snapshotId,
        kind: classifyExtractedAsarArtifact(file.path),
        path: `asar/${relativeArchivePath}!/${file.path}`,
        sha256,
        size: file.size,
        source: `${artifact.path}!/${file.path}`,
        blob,
      }));
      archiveExtractedFileCount += 1;
      extractedFileCount += 1;
    });

    unpackedFileCount += archive.unpackedFileCount;
    archives.push({
      ...archive,
      extractedFileCount: archiveExtractedFileCount,
      kind: artifact.kind,
      relativePath: relativeArchivePath,
      sourcePath: artifact.path,
    });
  }

  return {
    archives,
    extractedFileCount,
    records,
    unpackedFileCount,
  };
}

function classifyExtractedAsarArtifact(filePath: string): string {
  const extension = path.posix.extname(filePath).toLowerCase();

  switch (extension) {
    case ".js":
    case ".cjs":
    case ".mjs":
      return "asar_javascript";
    case ".json":
      return "asar_json";
    case ".css":
      return "asar_css";
    case ".html":
      return "asar_html";
    case ".map":
      return "asar_source_map";
    case ".node":
      return "asar_native_module";
    case ".wasm":
      return "asar_wasm";
    case ".txt":
    case ".md":
    case ".yml":
    case ".yaml":
      return "asar_text";
    default:
      return "asar_file";
  }
}
