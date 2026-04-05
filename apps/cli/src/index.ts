import path from "node:path";

import { formatSnapshotKey, type CorpusLayer, type ReleaseChannel, type VersionSignal } from "@discorpus/core";
import { ensureCorpusDatabase, getArtifactKindCounts, getLatestSnapshot, getSnapshotByIdOrDirName, indexSnapshot } from "@discorpus/db";
import {
  collectWindowsDesktopManifest,
  discoverWindowsDesktopInstall,
  type WindowsDesktopInstall,
  type WindowsDesktopManifest,
} from "@discorpus/platform-windows";
import { createSnapshotPaths, DiskBlobStore, InMemorySnapshotStore, writeJsonFile } from "@discorpus/storage";
import { createDiscordSnapshotKey, discordPlatforms, isDiscordChannel } from "@discorpus/targets-discord";
import { createVersionSet } from "@discorpus/versioning";

type CollectLayer = Extract<CorpusLayer, "desktop" | "web">;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const normalizedArgs = args.filter((value) => value !== "--json");

  if (normalizedArgs[0] === "collect") {
    const layer = parseLayer(normalizedArgs[1]);
    const channel = parseChannel(normalizedArgs.slice(2));

    if (!layer || !channel) {
      printUsage();
      process.exitCode = 1;
      return;
    }

    await runCollect(layer, channel, json);
    return;
  }

  if (normalizedArgs[0] === "inspect" && normalizedArgs[1] === "latest") {
    const layer = parseLayerFromOption(normalizedArgs.slice(2));
    const channel = parseChannel(normalizedArgs.slice(2));

    if (!layer || !channel) {
      printUsage();
      process.exitCode = 1;
      return;
    }

    await runInspectLatest(layer, channel, json);
    return;
  }

  if (normalizedArgs[0] === "inspect" && normalizedArgs[1] === "snapshot") {
    const snapshotId = normalizedArgs[2];

    if (!snapshotId) {
      printUsage();
      process.exitCode = 1;
      return;
    }

    await runInspectSnapshot(snapshotId, json);
    return;
  }

  {
    printUsage();
    process.exitCode = 1;
    return;
  }
}

async function runCollect(layer: CollectLayer, channel: ReleaseChannel, json: boolean): Promise<void> {
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
    desktopArtifactRecords = await createDesktopArtifactRecords(snapshot.id, snapshotStore, desktopManifest);
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
  const versionSet = createVersionSet({
    key: snapshotKey,
    observedAt,
    normalizedFingerprint: "pending",
    signals,
  });
  const collectResult = {
    artifactKindCounts: desktopManifest ? toArtifactCountObject(countArtifactKinds(desktopArtifactRecords)) : {},
    channel,
    corpusVersionId: versionSet.decision.corpusVersionId,
    layer,
    observedAt,
    release: snapshot.release,
    snapshotId: snapshot.id,
    snapshotKey: formatSnapshotKey(snapshotKey),
    status: `${layer} collection ${layer === "desktop" ? "discovery" : "stub"} ready`,
    upstreamSummary: formatUpstreamSummary(snapshot.release.appVersion, snapshot.release.releaseId, signals),
    upstreamVersionId: versionSet.decision.upstreamVersionId,
  };

  if (json) {
    console.log(JSON.stringify(collectResult, null, 2));
    return;
  }

  console.log("discorpus");
  console.log(`command: collect ${layer} --channel ${channel}`);
  console.log(`snapshot key: ${formatSnapshotKey(snapshotKey)}`);
  console.log(`snapshot id: ${snapshot.id}`);
  console.log(`upstream build: ${collectResult.upstreamSummary}`);
  console.log(`corpus version: ${formatCorpusSummary(versionSet.decision.corpusVersionId)}`);
  if (desktopInstall && desktopManifest) {
    printDesktopDiscovery(desktopInstall);
    printDesktopManifest(desktopArtifactRecords, desktopManifest);
    const snapshotDir = await persistDesktopSnapshot(snapshot, desktopManifest, desktopArtifactRecords, versionSet);
    const dbPath = await persistSnapshotIndex(snapshot, desktopArtifactRecords, versionSet);
    console.log(`snapshot dir: ${snapshotDir}`);
    console.log(`sqlite db: ${dbPath}`);
  }
  console.log(`status: ${collectResult.status}`);
}

async function runInspectLatest(layer: CollectLayer, channel: ReleaseChannel, json: boolean): Promise<void> {
  const db = await ensureCorpusDatabase(path.join(process.cwd(), "data"));
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
  console.log(`command: inspect latest --channel ${channel} --layer ${layer}`);
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

async function runInspectSnapshot(snapshotId: string, json: boolean): Promise<void> {
  const db = await ensureCorpusDatabase(path.join(process.cwd(), "data"));
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
  console.log(`command: inspect snapshot ${snapshotId}`);
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

async function createDesktopArtifactRecords(
  snapshotId: string,
  snapshotStore: InMemorySnapshotStore,
  manifest: WindowsDesktopManifest,
): Promise<ReturnType<InMemorySnapshotStore["createArtifactRecord"]>[]> {
  const blobStore = new DiskBlobStore(path.join(process.cwd(), "data", "blobs"));

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

async function persistDesktopSnapshot(
  snapshot: ReturnType<InMemorySnapshotStore["createSnapshotRecord"]>,
  manifest: WindowsDesktopManifest,
  records: ReturnType<InMemorySnapshotStore["createArtifactRecord"]>[],
  versionSet: ReturnType<typeof createVersionSet>,
): Promise<string> {
  const baseDir = path.join(process.cwd(), "data", "snapshots");
  const paths = await createSnapshotPaths(baseDir, snapshot.id);

  await writeJsonFile(path.join(paths.rootDir, "snapshot.json"), snapshot);
  await writeJsonFile(path.join(paths.rootDir, "artifacts.json"), records);
  await writeJsonFile(
    path.join(paths.rootDir, "blob-index.json"),
    records.map((record) => ({
      id: record.id,
      path: record.path,
      sha256: record.sha256,
      blob: record.blob ?? null,
    })),
  );
  await writeJsonFile(path.join(paths.desktopDir, "build-info.json"), manifest.buildInfo);
  await writeJsonFile(path.join(paths.desktopDir, "bootstrap-manifest.json"), manifest.bootstrapManifest);
  await writeJsonFile(path.join(paths.desktopDir, "module-manifests.json"), manifest.moduleManifests);
  await writeJsonFile(path.join(paths.desktopDir, "install.json"), manifest.install);
  await writeJsonFile(path.join(paths.desktopDir, "version.json"), versionSet.decision);

  return paths.rootDir;
}

async function persistSnapshotIndex(
  snapshot: ReturnType<InMemorySnapshotStore["createSnapshotRecord"]>,
  records: ReturnType<InMemorySnapshotStore["createArtifactRecord"]>[],
  versionSet: ReturnType<typeof createVersionSet>,
): Promise<string> {
  const dataDir = path.join(process.cwd(), "data");
  const db = await ensureCorpusDatabase(dataDir);

  indexSnapshot(db.databasePath, snapshot, versionSet, records);

  return db.databasePath;
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

function parseLayerFromOption(args: string[]): CollectLayer | null {
  const index = args.findIndex((value) => value === "--layer");

  if (index === -1) {
    return null;
  }

  return parseLayer(args[index + 1]);
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
  console.error("usage: discorpus inspect latest --channel <stable|ptb|canary> --layer <desktop|web>");
  console.error("usage: discorpus inspect snapshot <snapshot-id>");
  console.error("optional: add --json for structured output");
}

function formatArtifactCountRows(rows: { count: number; kind: string }[]): string {
  return rows
    .map((row) => `${row.kind}=${row.count}`)
    .join(", ");
}

function formatUpstreamSummary(
  appVersion: string | null | undefined,
  releaseId: string | null | undefined,
  signals: VersionSignal[],
): string {
  const parts = [releaseId ?? "unknown", appVersion ?? "unknown"];
  const signalCount = signals.length > 0 ? `signals=${signals.length}` : null;

  return [parts.join(" "), signalCount].filter(Boolean).join(", ");
}

function formatCorpusSummary(corpusVersionId: string): string {
  const suffix = corpusVersionId.split(":").at(-1) ?? corpusVersionId;
  return suffix === "pending" ? "pending" : suffix;
}

function toArtifactCountObject(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...counts.entries()].sort((left, right) => left[0].localeCompare(right[0])));
}

function toArtifactCountObjectFromRows(rows: { count: number; kind: string }[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.kind, row.count]));
}

void main().catch((error: unknown) => {
  if (error instanceof Error && error.message === "desktop install not found") {
    return;
  }

  console.error(error);
  process.exitCode = 1;
});
