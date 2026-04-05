#!/usr/bin/env node

import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { extractAsarArchive, type AsarArchiveSummary } from "@discorpus/asar";
import { formatSnapshotKey, type CorpusLayer, type ReleaseChannel, type VersionSignal } from "@discorpus/core";
import {
  ensureCorpusDatabase,
  findArtifacts,
  getArtifactsBySnapshotId,
  getArtifactKindCounts,
  getLatestSnapshot,
  getPreviousSnapshot,
  getSnapshotByIdOrDirName,
  indexSnapshot,
  listSnapshots,
} from "@discorpus/db";
import {
  collectWindowsDesktopManifest,
  discoverWindowsDesktopInstall,
  type WindowsDesktopInstall,
  type WindowsDesktopManifest,
} from "@discorpus/platform-windows";
import { createSnapshotDirName, createSnapshotPaths, DiskBlobStore, InMemorySnapshotStore, writeJsonFile } from "@discorpus/storage";
import { createDiscordSnapshotKey, discordPlatforms, isDiscordChannel } from "@discorpus/targets-discord";
import { createVersionSet } from "@discorpus/versioning";

type CollectLayer = Extract<CorpusLayer, "desktop" | "web">;

interface DesktopAsarArchiveRecord extends AsarArchiveSummary {
  extractedFileCount: number;
  kind: string;
  relativePath: string;
  sourcePath: string;
}

interface DesktopAsarExtraction {
  archives: DesktopAsarArchiveRecord[];
  extractedFileCount: number;
  unpackedFileCount: number;
}

interface DesktopAsarExtractionResult extends DesktopAsarExtraction {
  records: ReturnType<InMemorySnapshotStore["createArtifactRecord"]>[];
}

interface WebCapturedDocument {
  contentType: string | null;
  finalUrl: string;
  sha256: string;
  size: number;
  status: number;
  url: string;
}

interface WebCapturedAsset {
  contentType: string | null;
  finalUrl: string;
  kind: string;
  path: string;
  sha256: string;
  size: number;
  status: number;
  url: string;
}

interface WebCaptureManifest {
  assetUrls: string[];
  assets: WebCapturedAsset[];
  buildNumber: string | null;
  channel: ReleaseChannel;
  document: WebCapturedDocument;
  entryUrl: string;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const normalizedArgs = args.filter((value) => value !== "--json");

  if (normalizedArgs[0] === "snapshots") {
    const layer = parseLayerFromOption(normalizedArgs.slice(1));
    await runListSnapshots(layer, json);
    return;
  }

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

  if (normalizedArgs[0] === "snapshot") {
    const selector = normalizedArgs[1];

    if (!selector) {
      printUsage();
      process.exitCode = 1;
      return;
    }

    if (selector === "latest") {
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

    await runInspectSnapshot(selector, json);
    return;
  }

  if (normalizedArgs[0] === "entries") {
    const selector = normalizedArgs[1];

    if (!selector) {
      printUsage();
      process.exitCode = 1;
      return;
    }

    if (selector === "latest") {
      const layer = parseLayerFromOption(normalizedArgs.slice(2));
      const channel = parseChannel(normalizedArgs.slice(2));

      if (!layer || !channel) {
        printUsage();
        process.exitCode = 1;
        return;
      }

      await runListEntriesForLatest(layer, channel, json);
      return;
    }

    await runListEntries(selector, json);
    return;
  }

  if (normalizedArgs[0] === "archive") {
    const selector = normalizedArgs[1];
    const archiveName = normalizedArgs[2];

    if (!selector || !archiveName) {
      printUsage();
      process.exitCode = 1;
      return;
    }

    if (selector === "latest") {
      const layer = parseLayerFromOption(normalizedArgs.slice(3));
      const channel = parseChannel(normalizedArgs.slice(3));

      if (!layer || !channel) {
        printUsage();
        process.exitCode = 1;
        return;
      }

      await runInspectArchiveForLatest(layer, channel, archiveName, json);
      return;
    }

    await runInspectArchive(selector, archiveName, json);
    return;
  }

  if (normalizedArgs[0] === "find" && normalizedArgs[1] === "artifact") {
    const sha256 = parseOption(normalizedArgs.slice(2), "--sha256");
    const kind = parseOption(normalizedArgs.slice(2), "--kind");
    const pathFragment = parseOption(normalizedArgs.slice(2), "--path");

    if (!sha256 && !kind && !pathFragment) {
      printUsage();
      process.exitCode = 1;
      return;
    }

    await runFindArtifact({ kind, pathFragment, sha256 }, json);
    return;
  }

  if (normalizedArgs[0] === "diff" && normalizedArgs[1] === "latest") {
    const layer = parseLayerFromOption(normalizedArgs.slice(2));
    const channel = parseChannel(normalizedArgs.slice(2));

    if (!layer || !channel) {
      printUsage();
      process.exitCode = 1;
      return;
    }

    await runDiffLatest(layer, channel, json);
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
  const dataDir = getCorpusDataDir();
  const blobStore = new DiskBlobStore(path.join(dataDir, "blobs"));
  let desktopInstall: WindowsDesktopInstall | null = null;
  let desktopManifest: WindowsDesktopManifest | null = null;
  let desktopArtifactRecords: ReturnType<InMemorySnapshotStore["createArtifactRecord"]>[] = [];
  let desktopAsarExtraction: DesktopAsarExtractionResult | null = null;
  let webManifest: WebCaptureManifest | null = null;
  let webArtifactRecords: ReturnType<InMemorySnapshotStore["createArtifactRecord"]>[] = [];
  let signals: VersionSignal[];
  let normalizedFingerprint = "pending";

  if (layer === "desktop") {
    desktopInstall = await requireDesktopInstall(channel);
    desktopManifest = await collectWindowsDesktopManifest(desktopInstall);
    const rawArtifactRecords = await createDesktopArtifactRecords(snapshot.id, snapshotStore, blobStore, desktopManifest);
    desktopAsarExtraction = await createExtractedAsarArtifactRecords(
      snapshot.id,
      snapshotStore,
      blobStore,
      desktopManifest,
    );
    desktopArtifactRecords = [...rawArtifactRecords, ...desktopAsarExtraction.records];
    snapshot.release = {
      appVersion: desktopManifest.buildInfo?.version,
      releaseId: desktopManifest.buildInfo?.releaseChannel,
    };
    signals = collectDesktopSignals(desktopInstall, desktopManifest);
  } else {
    webManifest = await collectDiscordWebManifest(channel);
    webArtifactRecords = await createWebArtifactRecords(snapshot.id, snapshotStore, blobStore, webManifest);
    snapshot.release = {
      appVersion: webManifest.buildNumber ?? undefined,
      releaseId: channel,
    };
    signals = collectWebSignals(webManifest);
    normalizedFingerprint = createWebNormalizedFingerprint(webManifest);
  }
  const artifactRecords = layer === "desktop" ? desktopArtifactRecords : webArtifactRecords;
  const versionSet = createVersionSet({
    key: snapshotKey,
    observedAt,
    normalizedFingerprint,
    signals,
  });
  const collectResult = {
    artifactKindCounts: toArtifactCountObject(countArtifactKinds(artifactRecords)),
    channel,
    corpusVersionId: versionSet.decision.corpusVersionId,
    layer,
    observedAt,
    release: snapshot.release,
    snapshotId: snapshot.id,
    snapshotKey: formatSnapshotKey(snapshotKey),
    status: `${layer} collection ${layer === "desktop" ? "discovery" : "capture"} ready`,
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
    printDesktopManifest(desktopArtifactRecords, desktopManifest, desktopAsarExtraction);
    const snapshotDir = await persistDesktopSnapshot(
      snapshot,
      desktopManifest,
      desktopArtifactRecords,
      versionSet,
      desktopAsarExtraction,
      dataDir,
    );
    const dbPath = await persistSnapshotIndex(snapshot, desktopArtifactRecords, versionSet, dataDir);
    console.log(`snapshot dir: ${snapshotDir}`);
    console.log(`sqlite db: ${dbPath}`);
    console.log(`corpus dir: ${dataDir}`);
  }
  if (webManifest) {
    printWebManifest(webArtifactRecords, webManifest);
    const snapshotDir = await persistWebSnapshot(snapshot, webManifest, webArtifactRecords, versionSet, dataDir);
    const dbPath = await persistSnapshotIndex(snapshot, webArtifactRecords, versionSet, dataDir);
    console.log(`snapshot dir: ${snapshotDir}`);
    console.log(`sqlite db: ${dbPath}`);
    console.log(`corpus dir: ${dataDir}`);
  }
  console.log(`status: ${collectResult.status}`);
}

async function runInspectLatest(layer: CollectLayer, channel: ReleaseChannel, json: boolean): Promise<void> {
  const db = await ensureCorpusDatabase(getCorpusDataDir());
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

async function runListEntriesForLatest(
  layer: CollectLayer,
  channel: ReleaseChannel,
  json: boolean,
): Promise<void> {
  const snapshot = await requireLatestSnapshot(channel, layer);
  await runListEntries(snapshot.id, json);
}

async function runInspectArchiveForLatest(
  layer: CollectLayer,
  channel: ReleaseChannel,
  archiveName: string,
  json: boolean,
): Promise<void> {
  const snapshot = await requireLatestSnapshot(channel, layer);
  await runInspectArchive(snapshot.id, archiveName, json);
}

async function runInspectSnapshot(snapshotId: string, json: boolean): Promise<void> {
  const db = await ensureCorpusDatabase(getCorpusDataDir());
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

async function runListSnapshots(layer: CollectLayer | null, json: boolean): Promise<void> {
  const dataDir = getCorpusDataDir();
  const db = await ensureCorpusDatabase(dataDir);
  const snapshots = listSnapshots(db.databasePath, layer ?? undefined);
  const result = {
    dbPath: db.databasePath,
    layer: layer ?? null,
    snapshots: snapshots.map((snapshot) => ({
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
    })),
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`sqlite db: ${db.databasePath}`);
  console.log(`snapshots: ${snapshots.length}`);

  if (snapshots.length === 0) {
    console.log("status: no snapshots indexed");
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

    const dirName = formatSnapshotDirName(snapshot.id);
    const version = snapshot.app_version ?? "unknown";
    const releaseId = snapshot.release_id ?? snapshot.channel;
    console.log(`  │  └─ ${dirName}  ${releaseId} ${version}  ${snapshot.observed_at}`);
  }
}

async function runFindArtifact(
  filters: { kind?: string; pathFragment?: string; sha256?: string },
  json: boolean,
): Promise<void> {
  const db = await ensureCorpusDatabase(getCorpusDataDir());
  const results = findArtifacts(db.databasePath, filters, 50);

  if (json) {
    console.log(JSON.stringify({
      dbPath: db.databasePath,
      filters,
      results,
    }, null, 2));
    return;
  }

  if (results.length === 0) {
    console.error("no artifacts found");
    process.exitCode = 1;
    return;
  }

  console.log("discorpus");
  console.log(`command: find artifact${formatFindFilters(filters)}`);
  console.log(`results: ${results.length}`);
  console.log(`sqlite db: ${db.databasePath}`);

  for (const result of results.slice(0, 20)) {
    console.log(`${result.kind} ${result.path}`);
    console.log(`snapshot: ${result.snapshot_id}`);
    console.log(`scope: ${result.channel} ${result.platform} ${result.layer}`);
    console.log(`observed at: ${result.observed_at}`);
    console.log(`sha256: ${result.sha256}`);
    console.log(`blob: ${result.blob_path ?? "none"}`);
  }
}

async function runListEntries(snapshotId: string, json: boolean): Promise<void> {
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

  console.log(`sqlite db: ${db.databasePath}`);
  console.log(`snapshot id: ${snapshot.id}`);
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

async function runInspectArchive(snapshotId: string, archiveName: string, json: boolean): Promise<void> {
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
    console.error(`archive name is ambiguous: ${archiveName}`);
    console.error("matches:");

    for (const match of archive) {
      console.error(`${match.name} ${match.path}`);
    }

    process.exitCode = 1;
    return;
  }

  const extractedArtifacts = artifacts.filter((item) => item.path.startsWith(`asar/${archive.path}!/`));
  const topLevelEntries = summarizeArchiveTopLevelEntries(extractedArtifacts, archive.path);
  const kindCounts = countArtifactKindsFromRows(extractedArtifacts);
  const result = {
    archive: {
      kind: archive.kind,
      name: archive.name,
      path: archive.path,
      sha256: archive.sha256,
      size: archive.size,
    },
    extractedFileCount: extractedArtifacts.length,
    extractedKindCounts: toArtifactCountObject(kindCounts),
    snapshotId: snapshot.id,
    topLevelEntries,
    sampleFiles: extractedArtifacts.slice(0, 20).map((item) => ({
      kind: item.kind,
      path: item.path,
      sha256: item.sha256,
    })),
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("discorpus");
  console.log(`command: inspect archive ${snapshotId} --name ${archiveName}`);
  console.log(`snapshot id: ${snapshot.id}`);
  console.log(`archive: ${archive.name}`);
  console.log(`archive path: ${archive.path}`);
  console.log(`archive kind: ${archive.kind}`);
  console.log(`archive sha256: ${archive.sha256}`);
  console.log(`archive size: ${archive.size}`);
  console.log(`extracted files: ${extractedArtifacts.length}`);
  console.log(`extracted kinds: ${formatArtifactCounts(kindCounts)}`);
  console.log(`top level: ${topLevelEntries.join(", ") || "none"}`);

  for (const item of extractedArtifacts.slice(0, 20)) {
    console.log(`${item.kind} ${item.path}`);
  }
}

async function runDiffLatest(layer: CollectLayer, channel: ReleaseChannel, json: boolean): Promise<void> {
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

    console.log("discorpus");
    console.log(`command: diff latest --channel ${channel} --layer ${layer}`);
    console.log(`current snapshot: ${latest.id}`);
    console.log("previous snapshot: none");
    console.log("status: no previous snapshot in lineage");
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

  console.log("discorpus");
  console.log(`command: diff latest --channel ${channel} --layer ${layer}`);
  console.log(`current snapshot: ${latest.id}`);
  console.log(`previous snapshot: ${previous.id}`);
  console.log(`added: ${diff.added.length}`);
  console.log(`removed: ${diff.removed.length}`);
  console.log(`changed: ${diff.changed.length}`);

  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    console.log("status: no artifact changes detected");
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

function collectWebSignals(manifest: WebCaptureManifest): VersionSignal[] {
  const signals: VersionSignal[] = [
    {
      scope: "web",
      name: "entry_url",
      value: manifest.entryUrl,
      confidence: "high",
    },
    {
      scope: "web",
      name: "final_url",
      value: manifest.document.finalUrl,
      confidence: "high",
    },
    {
      scope: "web",
      name: "document_sha256",
      value: manifest.document.sha256,
      confidence: "high",
    },
    {
      scope: "web",
      name: "asset_count",
      value: String(manifest.assets.length),
      confidence: "medium",
    },
  ];

  if (manifest.buildNumber) {
    signals.push({
      scope: "web",
      name: "build_number",
      value: manifest.buildNumber,
      confidence: "high",
    });
  }

  for (const asset of manifest.assets) {
    signals.push({
      scope: "web",
      name: "asset_path",
      value: asset.path,
      confidence: "medium",
    });
  }

  return signals;
}

function createWebNormalizedFingerprint(manifest: WebCaptureManifest): string {
  const fingerprint = createHash("sha256");

  fingerprint.update(manifest.document.sha256);

  for (const asset of manifest.assets) {
    fingerprint.update(`${asset.path}:${asset.sha256}`);
  }

  return fingerprint.digest("hex");
}

async function collectDiscordWebManifest(channel: ReleaseChannel): Promise<WebCaptureManifest> {
  const entryUrl = getDiscordWebEntryUrl(channel);
  const document = await fetchWebDocument(entryUrl);
  const html = (await fetchBuffer(document.finalUrl)).toString("utf8");
  const assetUrls = discoverWebAssetUrls(html, document.finalUrl);
  const assets: WebCapturedAsset[] = [];

  for (const assetUrl of assetUrls) {
    assets.push(await fetchWebAsset(assetUrl));
  }

  return {
    assetUrls,
    assets,
    buildNumber: extractWebBuildNumber(html),
    channel,
    document,
    entryUrl,
  };
}

async function fetchWebDocument(url: string): Promise<WebCapturedDocument> {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "discorpus/0.1.0",
    },
  });

  const buffer = Buffer.from(await response.arrayBuffer());

  if (!response.ok) {
    throw new Error(`web document request failed: ${response.status} ${response.url}`);
  }

  return {
    contentType: response.headers.get("content-type"),
    finalUrl: response.url,
    sha256: hashBuffer(buffer),
    size: buffer.length,
    status: response.status,
    url,
  };
}

async function fetchWebAsset(url: string): Promise<WebCapturedAsset> {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "discorpus/0.1.0",
    },
  });

  const buffer = Buffer.from(await response.arrayBuffer());

  if (!response.ok) {
    throw new Error(`web asset request failed: ${response.status} ${response.url}`);
  }

  return {
    contentType: response.headers.get("content-type"),
    finalUrl: response.url,
    kind: classifyWebArtifact(response.url, response.headers.get("content-type")),
    path: createWebArtifactPath(response.url),
    sha256: hashBuffer(buffer),
    size: buffer.length,
    status: response.status,
    url,
  };
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
  extraction: DesktopAsarExtraction | null,
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
  console.log(`desktop extracted asar archives: ${extraction?.archives.length ?? 0}`);
  console.log(`desktop extracted asar files: ${extraction?.extractedFileCount ?? 0}`);
  console.log(`desktop unpacked asar files: ${extraction?.unpackedFileCount ?? 0}`);

  for (const artifact of importantArtifacts.slice(0, 12)) {
    console.log(`artifact ${artifact.kind}: ${artifact.path} ${artifact.sha256}`);
  }
}

function printWebManifest(
  records: ReturnType<InMemorySnapshotStore["createArtifactRecord"]>[],
  manifest: WebCaptureManifest,
): void {
  const counts = countArtifactKinds(records);

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

async function createDesktopArtifactRecords(
  snapshotId: string,
  snapshotStore: InMemorySnapshotStore,
  blobStore: DiskBlobStore,
  manifest: WindowsDesktopManifest,
): Promise<ReturnType<InMemorySnapshotStore["createArtifactRecord"]>[]> {
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

async function createWebArtifactRecords(
  snapshotId: string,
  snapshotStore: InMemorySnapshotStore,
  blobStore: DiskBlobStore,
  manifest: WebCaptureManifest,
): Promise<ReturnType<InMemorySnapshotStore["createArtifactRecord"]>[]> {
  const documentBuffer = await fetchBuffer(manifest.document.finalUrl);
  const documentBlob = await blobStore.persistBuffer(documentBuffer, manifest.document.sha256, "raw");
  const records: ReturnType<InMemorySnapshotStore["createArtifactRecord"]>[] = [
    snapshotStore.createArtifactRecord({
      snapshotId,
      kind: "web_document",
      path: "document/app.html",
      sha256: manifest.document.sha256,
      size: manifest.document.size,
      source: manifest.document.finalUrl,
      blob: documentBlob,
    }),
  ];

  for (const asset of manifest.assets) {
    const buffer = await fetchBuffer(asset.finalUrl);
    const blob = await blobStore.persistBuffer(buffer, asset.sha256, "raw");

    records.push(snapshotStore.createArtifactRecord({
      snapshotId,
      kind: asset.kind,
      path: asset.path,
      sha256: asset.sha256,
      size: asset.size,
      source: asset.finalUrl,
      blob,
    }));
  }

  return records;
}

async function createExtractedAsarArtifactRecords(
  snapshotId: string,
  snapshotStore: InMemorySnapshotStore,
  blobStore: DiskBlobStore,
  manifest: WindowsDesktopManifest,
): Promise<DesktopAsarExtraction & {
  records: ReturnType<InMemorySnapshotStore["createArtifactRecord"]>[];
}> {
  const archives: DesktopAsarArchiveRecord[] = [];
  const records: ReturnType<InMemorySnapshotStore["createArtifactRecord"]>[] = [];
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

async function persistDesktopSnapshot(
  snapshot: ReturnType<InMemorySnapshotStore["createSnapshotRecord"]>,
  manifest: WindowsDesktopManifest,
  records: ReturnType<InMemorySnapshotStore["createArtifactRecord"]>[],
  versionSet: ReturnType<typeof createVersionSet>,
  extraction: DesktopAsarExtraction | null,
  dataDir: string,
): Promise<string> {
  const baseDir = path.join(dataDir, "snapshots");
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
  await writeJsonFile(path.join(paths.desktopDir, "asar-archives.json"), extraction?.archives ?? []);
  await writeJsonFile(path.join(paths.desktopDir, "install.json"), manifest.install);
  await writeJsonFile(path.join(paths.desktopDir, "version.json"), versionSet.decision);

  return paths.rootDir;
}

async function persistWebSnapshot(
  snapshot: ReturnType<InMemorySnapshotStore["createSnapshotRecord"]>,
  manifest: WebCaptureManifest,
  records: ReturnType<InMemorySnapshotStore["createArtifactRecord"]>[],
  versionSet: ReturnType<typeof createVersionSet>,
  dataDir: string,
): Promise<string> {
  const baseDir = path.join(dataDir, "snapshots");
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

async function persistSnapshotIndex(
  snapshot: ReturnType<InMemorySnapshotStore["createSnapshotRecord"]>,
  records: ReturnType<InMemorySnapshotStore["createArtifactRecord"]>[],
  versionSet: ReturnType<typeof createVersionSet>,
  dataDir: string,
): Promise<string> {
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

function countArtifactKindsFromRows(
  rows: Array<{
    kind: string;
  }>,
): Map<string, number> {
  const counts = new Map<string, number>();

  for (const row of rows) {
    counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
  }

  return counts;
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

function parseOption(args: string[], name: string): string | undefined {
  const index = args.findIndex((value) => value === name);

  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}

function diffArtifacts(
  previousArtifacts: Array<{
    kind: string;
    path: string;
    sha256: string;
  }>,
  currentArtifacts: Array<{
    kind: string;
    path: string;
    sha256: string;
  }>,
): {
  added: typeof currentArtifacts;
  changed: Array<{
    current: (typeof currentArtifacts)[number];
    previous: (typeof previousArtifacts)[number];
  }>;
  removed: typeof previousArtifacts;
} {
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
    .filter((value): value is NonNullable<typeof value> => value !== null);

  return {
    added,
    removed,
    changed,
  };
}

function listSnapshotArchives(
  artifacts: Array<{
    kind: string;
    path: string;
    sha256: string;
    size: number;
  }>,
): Array<{
  kind: string;
  name: string;
  path: string;
  sha256: string;
  size: number;
}> {
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

function listSnapshotInspectableFiles(
  artifacts: Array<{
    kind: string;
    path: string;
  }>,
): Array<{
  kind: string;
  path: string;
}> {
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
      artifact.kind === "web_script" ||
      artifact.kind === "web_stylesheet" ||
      artifact.kind === "web_json" ||
      artifact.kind === "web_source_map" ||
      artifact.kind === "web_asset",
    )
    .map((artifact) => ({
      kind: artifact.kind,
      path: toPosixPath(artifact.path),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function resolveSnapshotArchive(
  archives: Array<{
    kind: string;
    name: string;
    path: string;
    sha256: string;
    size: number;
  }>,
  value: string,
):
  | {
      kind: string;
      name: string;
      path: string;
      sha256: string;
      size: number;
    }
  | Array<{
      kind: string;
      name: string;
      path: string;
      sha256: string;
      size: number;
    }>
  | null {
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

function summarizeArchiveTopLevelEntries(
  artifacts: Array<{
    path: string;
  }>,
  archivePath: string,
): string[] {
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

function printUsage(): void {
  console.error("usage: discorpus collect <desktop|web> --channel <stable|ptb|canary>");
  console.error("usage: discorpus snapshots [--layer <desktop|web>]");
  console.error("usage: discorpus snapshot <snapshot-id>");
  console.error("usage: discorpus snapshot latest --channel <stable|ptb|canary> --layer <desktop|web>");
  console.error("usage: discorpus entries <snapshot-id>");
  console.error("usage: discorpus entries latest --channel <stable|ptb|canary> --layer <desktop|web>");
  console.error("usage: discorpus archive <snapshot-id> <archive-name>");
  console.error("usage: discorpus archive latest <archive-name> --channel <stable|ptb|canary> --layer <desktop|web>");
  console.error("usage: discorpus find artifact [--sha256 <hash>] [--kind <kind>] [--path <path-fragment>]");
  console.error("usage: discorpus diff latest --channel <stable|ptb|canary> --layer <desktop|web>");
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

function formatFindFilters(filters: { kind?: string; pathFragment?: string; sha256?: string }): string {
  const parts = [
    filters.sha256 ? ` --sha256 ${filters.sha256}` : "",
    filters.kind ? ` --kind ${filters.kind}` : "",
    filters.pathFragment ? ` --path ${filters.pathFragment}` : "",
  ];

  return parts.join("");
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

function classifyWebArtifact(url: string, contentType: string | null): string {
  const extension = path.posix.extname(new URL(url).pathname).toLowerCase();
  const normalizedContentType = contentType?.split(";")[0].trim().toLowerCase() ?? "";

  if (normalizedContentType.includes("javascript") || extension === ".js" || extension === ".mjs") {
    return "web_script";
  }

  if (normalizedContentType.includes("css") || extension === ".css") {
    return "web_stylesheet";
  }

  if (normalizedContentType.includes("json") || extension === ".json") {
    return "web_json";
  }

  if (extension === ".map") {
    return "web_source_map";
  }

  return "web_asset";
}

function createWebArtifactPath(url: string): string {
  const parsed = new URL(url);
  const host = sanitizePathComponent(parsed.host);
  const pathname = parsed.pathname.replace(/^\/+/, "") || "index";
  const query = parsed.search ? `__${sanitizePathComponent(parsed.search.slice(1))}` : "";

  return `assets/${host}/${pathname}${query}`;
}

function discoverWebAssetUrls(html: string, baseUrl: string): string[] {
  const assetUrls = new Set<string>();
  const patterns = [
    /<script[^>]+src="([^"]+)"/gi,
    /<script[^>]+src='([^']+)'/gi,
    /<link[^>]+href="([^"]+)"/gi,
    /<link[^>]+href='([^']+)'/gi,
  ];
  const base = new URL(baseUrl);

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const value = match[1];

      if (!value) {
        continue;
      }

      const resolvedUrl = new URL(value, baseUrl);

      if (resolvedUrl.origin !== base.origin) {
        continue;
      }

      if (resolvedUrl.pathname === "/" || resolvedUrl.pathname === "/app") {
        continue;
      }

      assetUrls.add(resolvedUrl.toString());
    }
  }

  return [...assetUrls].sort();
}

function extractWebBuildNumber(html: string): string | null {
  const patterns = [
    /BUILD_NUMBER["'\s:=]+(\d+)/i,
    /buildNumber["'\s:=]+(\d+)/i,
    /SENTRY_TAGS[^<]*buildId["'\s:=]+["']?([^"',}\s<]+)/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);

    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "discorpus/0.1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`request failed: ${response.status} ${response.url}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function getDiscordWebEntryUrl(channel: ReleaseChannel): string {
  switch (channel) {
    case "stable":
      return "https://discord.com/app";
    case "ptb":
      return "https://ptb.discord.com/app";
    case "canary":
      return "https://canary.discord.com/app";
  }
}

function hashBuffer(buffer: Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function sanitizePathComponent(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "_");
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function formatSnapshotDirName(snapshotId: string): string {
  return createSnapshotDirName(snapshotId);
}

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
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

function getCorpusDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DISCORPUS_DATA_DIR;

  if (override) {
    return path.resolve(override);
  }

  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA;

    if (localAppData) {
      return path.join(localAppData, "discorpus");
    }
  }

  const xdgStateHome = env.XDG_STATE_HOME;

  if (xdgStateHome) {
    return path.join(xdgStateHome, "discorpus");
  }

  return path.join(os.homedir(), ".discorpus");
}

void main().catch((error: unknown) => {
  if (error instanceof Error && error.message === "desktop install not found") {
    return;
  }

  console.error(error);
  process.exitCode = 1;
});
