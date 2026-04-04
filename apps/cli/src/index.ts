import path from "node:path";

import { formatSnapshotKey, type CorpusLayer, type ReleaseChannel, type VersionSignal } from "@discorpus/core";
import {
  collectWindowsDesktopManifest,
  discoverWindowsDesktopInstall,
  type WindowsDesktopInstall,
  type WindowsDesktopManifest,
} from "@discorpus/platform-windows";
import { createSnapshotPaths, InMemorySnapshotStore, writeJsonFile } from "@discorpus/storage";
import { createDiscordSnapshotKey, discordPlatforms, isDiscordChannel } from "@discorpus/targets-discord";
import { decideVersion } from "@discorpus/versioning";

type CollectLayer = Extract<CorpusLayer, "desktop" | "web">;

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] !== "collect") {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const layer = parseLayer(args[1]);
  const channel = parseChannel(args.slice(2));

  if (!layer || !channel) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  await runCollect(layer, channel);
}

async function runCollect(layer: CollectLayer, channel: ReleaseChannel): Promise<void> {
  const observedAt = new Date().toISOString();
  const snapshotKey = createDiscordSnapshotKey(channel, discordPlatforms[0], layer);
  const snapshotStore = new InMemorySnapshotStore();
  const snapshot = snapshotStore.createSnapshotRecord(snapshotKey, observedAt);
  let desktopInstall: WindowsDesktopInstall | null = null;
  let desktopManifest: WindowsDesktopManifest | null = null;
  let desktopArtifactRecords: ReturnType<InMemorySnapshotStore["createArtifactRecord"]>[] = [];
  let signals: VersionSignal[];

  if (layer === "desktop") {
    desktopInstall = await requireDesktopInstall(channel);
    desktopManifest = await collectWindowsDesktopManifest(desktopInstall);
    desktopArtifactRecords = createDesktopArtifactRecords(snapshot.id, snapshotStore, desktopManifest);
    snapshot.release = {
      appVersion: desktopManifest.buildInfo?.version,
      releaseId: desktopManifest.buildInfo?.releaseChannel,
    };
    signals = collectDesktopSignals(desktopInstall, desktopManifest);
  } else {
    signals = [
      {
        scope: "web",
        name: "collection_stub",
        value: channel,
        confidence: "medium",
      },
    ];
  }
  const version = decideVersion({
    key: snapshotKey,
    observedAt,
    normalizedFingerprint: "pending",
    signals,
  });

  console.log("discorpus");
  console.log(`command: collect ${layer} --channel ${channel}`);
  console.log(`snapshot key: ${formatSnapshotKey(snapshotKey)}`);
  console.log(`snapshot id: ${snapshot.id}`);
  console.log(`upstream version: ${version.upstreamVersionId}`);
  console.log(`corpus version: ${version.corpusVersionId}`);
  if (desktopInstall && desktopManifest) {
    printDesktopDiscovery(desktopInstall);
    printDesktopManifest(desktopArtifactRecords, desktopManifest);
    const snapshotDir = await persistDesktopSnapshot(snapshot, desktopManifest, desktopArtifactRecords, version);
    console.log(`snapshot dir: ${snapshotDir}`);
  }
  console.log(`status: ${layer} collection ${layer === "desktop" ? "discovery" : "stub"} ready`);
}

function collectDesktopSignals(
  install: WindowsDesktopInstall,
  manifest: WindowsDesktopManifest,
): VersionSignal[] {
  const signals: VersionSignal[] = [];

  if (manifest.buildInfo?.version) {
    signals.push({
      scope: "desktop",
      name: "build_info_version",
      value: manifest.buildInfo.version,
      confidence: "high",
    });
  }

  if (manifest.buildInfo?.releaseChannel) {
    signals.push({
      scope: "desktop",
      name: "build_info_channel",
      value: manifest.buildInfo.releaseChannel,
      confidence: "high",
    });
  }

  signals.push({
    scope: "desktop",
    name: "root_dir",
    value: install.rootDir,
    confidence: "medium",
  });

  for (const version of install.installedVersions) {
    signals.push({
      scope: "desktop",
      name: "installed_version",
      value: version,
      confidence: "medium",
    });
  }

  if (install.currentAppDir) {
    signals.push({
      scope: "desktop",
      name: "current_app_dir",
      value: install.currentAppDir,
      confidence: "medium",
    });
  }

  if (install.appAsarPath) {
    signals.push({
      scope: "desktop",
      name: "app_asar_path",
      value: install.appAsarPath,
      confidence: "high",
    });
  }

  for (const moduleName of Object.keys(manifest.moduleManifests).sort()) {
    signals.push({
      scope: "desktop",
      name: "module_manifest",
      value: moduleName,
      confidence: "medium",
    });
  }

  return signals;
}

async function requireDesktopInstall(channel: ReleaseChannel): Promise<WindowsDesktopInstall> {
  const install = await discoverWindowsDesktopInstall(channel);

  if (!install) {
    console.error(`desktop install not found for channel: ${channel}`);
    process.exitCode = 1;
    throw new Error("desktop install not found");
  }

  return install;
}

function printDesktopDiscovery(install: WindowsDesktopInstall): void {
  console.log(`desktop install root: ${install.rootDir}`);
  console.log(`desktop installed versions: ${install.installedVersions.join(", ") || "none"}`);
  console.log(`desktop current app dir: ${install.currentAppDir ?? "none"}`);
  console.log(`desktop executable: ${install.executablePath ?? "none"}`);
  console.log(`desktop update exe: ${install.updateExePath ?? "none"}`);
  console.log(`desktop resources dir: ${install.resourcesDir ?? "none"}`);
  console.log(`desktop app asar: ${install.appAsarPath ?? "none"}`);
}

function printDesktopManifest(
  records: ReturnType<InMemorySnapshotStore["createArtifactRecord"]>[],
  manifest: WindowsDesktopManifest,
): void {
  const counts = countArtifactKinds(records);
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

  for (const artifact of importantArtifacts.slice(0, 12)) {
    console.log(`artifact ${artifact.kind}: ${artifact.path} ${artifact.sha256}`);
  }
}

function createDesktopArtifactRecords(
  snapshotId: string,
  snapshotStore: InMemorySnapshotStore,
  manifest: WindowsDesktopManifest,
): ReturnType<InMemorySnapshotStore["createArtifactRecord"]>[] {
  return manifest.artifacts.map((artifact) =>
    snapshotStore.createArtifactRecord({
      snapshotId,
      kind: artifact.kind,
      path: artifact.relativePath,
      sha256: artifact.sha256,
      size: artifact.size,
      source: artifact.path,
    }),
  );
}

async function persistDesktopSnapshot(
  snapshot: ReturnType<InMemorySnapshotStore["createSnapshotRecord"]>,
  manifest: WindowsDesktopManifest,
  records: ReturnType<InMemorySnapshotStore["createArtifactRecord"]>[],
  version: ReturnType<typeof decideVersion>,
): Promise<string> {
  const baseDir = path.join(process.cwd(), "data", "snapshots");
  const paths = await createSnapshotPaths(baseDir, snapshot.id);

  await writeJsonFile(path.join(paths.rootDir, "snapshot.json"), snapshot);
  await writeJsonFile(path.join(paths.rootDir, "artifacts.json"), records);
  await writeJsonFile(path.join(paths.desktopDir, "build-info.json"), manifest.buildInfo);
  await writeJsonFile(path.join(paths.desktopDir, "bootstrap-manifest.json"), manifest.bootstrapManifest);
  await writeJsonFile(path.join(paths.desktopDir, "module-manifests.json"), manifest.moduleManifests);
  await writeJsonFile(path.join(paths.desktopDir, "install.json"), manifest.install);
  await writeJsonFile(path.join(paths.desktopDir, "version.json"), version);

  return paths.rootDir;
}

function countArtifactKinds(records: ReturnType<InMemorySnapshotStore["createArtifactRecord"]>[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const record of records) {
    counts.set(record.kind, (counts.get(record.kind) ?? 0) + 1);
  }

  return counts;
}

function formatArtifactCounts(counts: Map<string, number>): string {
  return [...counts.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([kind, count]) => `${kind}=${count}`)
    .join(", ");
}

function parseLayer(value: string | undefined): CollectLayer | null {
  if (value === "desktop" || value === "web") {
    return value;
  }

  return null;
}

function parseChannel(args: string[]): ReleaseChannel | null {
  const index = args.findIndex((value) => value === "--channel");

  if (index === -1) {
    return null;
  }

  const value = args[index + 1];

  if (!value || !isDiscordChannel(value)) {
    return null;
  }

  return value;
}

function printUsage(): void {
  console.error("usage: discorpus collect <desktop|web> --channel <stable|ptb|canary>");
}

void main().catch((error: unknown) => {
  if (error instanceof Error && error.message === "desktop install not found") {
    return;
  }

  console.error(error);
  process.exitCode = 1;
});
