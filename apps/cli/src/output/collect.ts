import type { WindowsDesktopInstall, WindowsDesktopManifest } from "@discorpus/platform-windows";

import type { CliArtifactRecord, DesktopAsarExtraction, WebCaptureManifest } from "../types/collect.js";
import { countKinds, formatArtifactCounts, formatCorpusSummary } from "../shared.js";

export interface CollectHeaderOptions {
  corpusVersionId: string;
  snapshotId: string;
  snapshotKey: string;
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
  console.log(`web runtime discovery: ${manifest.runtimeDiscovery ? "ready" : "none"}`);

  if (manifest.runtimeDiscovery) {
    console.log(`web devtools url: ${manifest.runtimeDiscovery.devtoolsBaseUrl}`);
    console.log(`web runtime browser: ${manifest.runtimeDiscovery.version.browser}`);
    console.log(`web runtime targets: ${manifest.runtimeDiscovery.targets.length}`);
    console.log(`web runtime selected target: ${manifest.runtimeDiscovery.selectedTarget?.url ?? "none"}`);
    console.log(`web runtime captured resources: ${manifest.runtimeDiscovery.capture?.resources.length ?? 0}`);

    if (manifest.runtimeDiscovery.summary) {
      console.log(`web runtime resources with body: ${manifest.runtimeDiscovery.summary.capturedWithBodyCount}`);
      console.log(`web declared assets: ${manifest.runtimeDiscovery.summary.declaredAssetCount}`);
      console.log(`web runtime map assets: ${manifest.runtimeDiscovery.summary.runtimeMapAssetCount}`);
      console.log(`web runtime same-origin resources: ${manifest.runtimeDiscovery.summary.sameOriginResourceCount}`);
      console.log(`web runtime same-origin with body: ${manifest.runtimeDiscovery.summary.sameOriginWithBodyCount}`);
      console.log(`web runtime promotable resources: ${manifest.runtimeDiscovery.summary.promotableResourceCount}`);
      console.log(`web promoted assets: ${manifest.runtimeDiscovery.summary.promotedAssetCount}`);
      console.log(`web excluded assets: ${manifest.runtimeDiscovery.summary.excludedAssetCount}`);
      console.log(`web missed assets: ${manifest.runtimeDiscovery.summary.missedAssetCount}`);
      console.log(`web missed webpack assets: ${manifest.runtimeDiscovery.summary.missedWebpackAssetCount}`);
      console.log(`web runtime body states: ${formatCountRecord(manifest.runtimeDiscovery.summary.bodyStates)}`);
    }
  }

  for (const asset of manifest.assets.slice(0, 12)) {
    console.log(`asset ${asset.kind}: ${asset.path} ${asset.sha256}`);
  }
}

function formatCountRecord(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([name, count]) => `${name}=${count}`)
    .join(", ");
}
