import path from "node:path";

import { formatSnapshotKey, type ReleaseChannel, type VersionSignal } from "@discorpus/core";
import { collectWindowsDesktopManifest, type WindowsDesktopInstall, type WindowsDesktopManifest } from "@discorpus/platform-windows";
import { DiskBlobStore, InMemorySnapshotStore } from "@discorpus/storage";
import { createDiscordSnapshotKey, discordPlatforms } from "@discorpus/targets-discord";
import { createVersionSet } from "@discorpus/versioning";

import { collectDesktopSignals, createDesktopArtifactRecords, createExtractedAsarArtifactRecords, requireDesktopInstall } from "./desktop.js";
import { persistDesktopSnapshot, persistSnapshotIndex, persistWebSnapshot } from "./persist.js";
import type { CliArtifactRecord, DesktopAsarExtractionResult, WebCaptureManifest } from "../types/collect.js";
import { collectDiscordWebManifest, collectWebSignals, createWebArtifactRecords, createWebNormalizedFingerprint } from "./web.js";
import { printCollectFooter, printCollectHeader, printDesktopDiscovery, printDesktopManifest, printWebManifest } from "../output/collect.js";
import { type CollectLayer, countKinds, formatUpstreamSummary, getCorpusDataDir, toArtifactCountObject } from "../shared.js";

interface CollectResult {
  artifactKindCounts: Record<string, number>;
  channel: ReleaseChannel;
  corpusVersionId: string;
  layer: CollectLayer;
  observedAt: string;
  release: {
    appVersion?: string;
    releaseId?: string;
  };
  snapshotId: string;
  snapshotKey: string;
  status: string;
  upstreamSummary: string;
  upstreamVersionId: string;
}

export async function runCollect(layer: CollectLayer, channel: ReleaseChannel, json: boolean): Promise<void> {
  const observedAt = new Date().toISOString();
  const snapshotKey = createDiscordSnapshotKey(channel, discordPlatforms[0], layer);
  const snapshotStore = new InMemorySnapshotStore();
  const snapshot = snapshotStore.createSnapshotRecord(snapshotKey, observedAt);
  const dataDir = getCorpusDataDir();
  const blobStore = new DiskBlobStore(path.join(dataDir, "blobs"));
  let desktopInstall: WindowsDesktopInstall | null = null;
  let desktopManifest: WindowsDesktopManifest | null = null;
  let desktopArtifactRecords: CliArtifactRecord[] = [];
  let desktopAsarExtraction: DesktopAsarExtractionResult | null = null;
  let webManifest: WebCaptureManifest | null = null;
  let webArtifactRecords: CliArtifactRecord[] = [];
  let signals: VersionSignal[];
  let normalizedFingerprint = "pending";

  if (layer === "desktop") {
    desktopInstall = await requireDesktopInstall(channel);
    desktopManifest = await collectWindowsDesktopManifest(desktopInstall);
    const rawArtifactRecords = await createDesktopArtifactRecords(snapshot.id, snapshotStore, blobStore, desktopManifest);
    desktopAsarExtraction = await createExtractedAsarArtifactRecords(snapshot.id, snapshotStore, blobStore, desktopManifest);
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
  const collectResult = createCollectResult(
    artifactRecords,
    channel,
    layer,
    observedAt,
    snapshot.id,
    snapshotKey,
    snapshot.release,
    versionSet.decision,
    signals,
  );

  if (json) {
    console.log(JSON.stringify(collectResult, null, 2));
    return;
  }

  printCollectHeader({
    channel,
    corpusVersionId: collectResult.corpusVersionId,
    layer,
    snapshotId: snapshot.id,
    snapshotKey: formatSnapshotKey(snapshotKey),
    status: collectResult.status,
    upstreamSummary: collectResult.upstreamSummary,
  });

  if (desktopInstall && desktopManifest) {
    printDesktopDiscovery(desktopInstall);
    printDesktopManifest(desktopArtifactRecords, desktopManifest, desktopAsarExtraction);
    const snapshotDir = await persistDesktopSnapshot(snapshot, desktopManifest, desktopArtifactRecords, versionSet, desktopAsarExtraction, dataDir);
    const dbPath = await persistSnapshotIndex(snapshot, desktopArtifactRecords, versionSet, dataDir);
    printCollectFooter(collectResult.status, snapshotDir, dbPath, dataDir);
    return;
  }

  if (webManifest) {
    printWebManifest(webArtifactRecords, webManifest);
    const snapshotDir = await persistWebSnapshot(snapshot, webManifest, webArtifactRecords, versionSet, dataDir);
    const dbPath = await persistSnapshotIndex(snapshot, webArtifactRecords, versionSet, dataDir);
    printCollectFooter(collectResult.status, snapshotDir, dbPath, dataDir);
  }
}

function createCollectResult(
  artifactRecords: CliArtifactRecord[],
  channel: ReleaseChannel,
  layer: CollectLayer,
  observedAt: string,
  snapshotId: string,
  snapshotKey: ReturnType<typeof createDiscordSnapshotKey>,
  release: { appVersion?: string; releaseId?: string },
  decision: ReturnType<typeof createVersionSet>["decision"],
  signals: VersionSignal[],
): CollectResult {
  return {
    artifactKindCounts: toArtifactCountObject(countKinds(artifactRecords)),
    channel,
    corpusVersionId: decision.corpusVersionId,
    layer,
    observedAt,
    release,
    snapshotId,
    snapshotKey: formatSnapshotKey(snapshotKey),
    status: `${layer} collection ${layer === "desktop" ? "discovery" : "capture"} ready`,
    upstreamSummary: formatUpstreamSummary(release.appVersion, release.releaseId, signals),
    upstreamVersionId: decision.upstreamVersionId,
  };
}
