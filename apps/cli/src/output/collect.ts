import type { WindowsDesktopInstall, WindowsDesktopManifest } from "@discorpus/platform-windows";

import type { CliArtifactRecord, DesktopAsarExtraction, WebCaptureManifest } from "../types/collect.js";
import { countKinds, formatArtifactCounts, formatCorpusSummary } from "../shared.js";

export interface CollectHeaderOptions {
  channel: string;
  corpusVersionId: string;
  layer: string;
  snapshotId: string;
  snapshotKey: string;
  status: string;
  upstreamSummary: string;
}

export function printCollectHeader(options: CollectHeaderOptions): void {
  console.log(`snapshot key: ${options.snapshotKey}`);
  console.log(`snapshot id: ${options.snapshotId}`);
  console.log(`upstream build: ${options.upstreamSummary}`);
  console.log(`corpus version: ${formatCorpusSummary(options.corpusVersionId)}`);
}

export function printCollectFooter(status: string, snapshotDir: string, dbPath: string, dataDir: string): void {
  console.log(`snapshot dir: ${snapshotDir}`);
  console.log(`sqlite db: ${dbPath}`);
  console.log(`corpus dir: ${dataDir}`);
  console.log(`status: ${status}`);
}

export function printDesktopDiscovery(install: WindowsDesktopInstall): void {
  console.log(`desktop install root: ${install.rootDir}`);
  console.log(`desktop installed versions: ${install.installedVersions.join(", ") || "none"}`);
  console.log(`desktop current app dir: ${install.currentAppDir ?? "none"}`);
  console.log(`desktop executable: ${install.executablePath ?? "none"}`);
  console.log(`desktop update exe: ${install.updateExePath ?? "none"}`);
  console.log(`desktop resources dir: ${install.resourcesDir ?? "none"}`);
  console.log(`desktop app asar: ${install.appAsarPath ?? "none"}`);
}

export function printDesktopManifest(
  records: CliArtifactRecord[],
  manifest: WindowsDesktopManifest,
  extraction: DesktopAsarExtraction | null,
): void {
  const counts = countKinds(records);
  const importantArtifacts = records.filter((record) =>
    record.kind === "updater" ||
    record.kind === "desktop_executable" ||
    record.kind === "app_asar" ||
    record.kind === "dll" ||
    record.kind === "runtime_blob",
  );

  console.log(`desktop artifact count: ${records.length}`);
  console.log(`desktop artifact kinds: ${formatArtifactCounts(counts)}`);

  if (manifest.buildInfo) {
    console.log(`desktop build info version: ${manifest.buildInfo.version ?? "none"}`);
    console.log(`desktop build info channel: ${manifest.buildInfo.releaseChannel ?? "none"}`);
    console.log(`desktop new updater: ${String(manifest.buildInfo.newUpdater ?? false)}`);
  }

  const bootstrapModules = Object.keys(manifest.bootstrapManifest ?? {}).sort();
  console.log(`desktop bootstrap modules: ${bootstrapModules.join(", ") || "none"}`);
  console.log(`desktop module manifests: ${Object.keys(manifest.moduleManifests).sort().join(", ") || "none"}`);
  console.log(`desktop extracted asar archives: ${extraction?.archives.length ?? 0}`);
  console.log(`desktop extracted asar files: ${extraction?.extractedFileCount ?? 0}`);
  console.log(`desktop unpacked asar files: ${extraction?.unpackedFileCount ?? 0}`);

  for (const artifact of importantArtifacts.slice(0, 12)) {
    console.log(`artifact ${artifact.kind}: ${artifact.path} ${artifact.sha256}`);
  }
}

export function printWebManifest(records: CliArtifactRecord[], manifest: WebCaptureManifest): void {
  const counts = countKinds(records);

  console.log(`web entry url: ${manifest.entryUrl}`);
  console.log(`web final url: ${manifest.document.finalUrl}`);
  console.log(`web document status: ${manifest.document.status}`);
  console.log(`web build number: ${manifest.buildNumber ?? "none"}`);
  console.log(`web asset count: ${manifest.assets.length}`);
  console.log(`web artifact kinds: ${formatArtifactCounts(counts)}`);

  for (const asset of manifest.assets.slice(0, 12)) {
    console.log(`asset ${asset.kind}: ${asset.path} ${asset.sha256}`);
  }
}
