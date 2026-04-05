import { createHash } from "node:crypto";
import path from "node:path";

import { extractAsarArchive, type AsarArchiveSummary } from "@discorpus/asar";
import { formatSnapshotKey, type ReleaseChannel, type VersionSignal } from "@discorpus/core";
import { ensureCorpusDatabase, indexSnapshot } from "@discorpus/db";
import {
  collectWindowsDesktopManifest,
  discoverWindowsDesktopInstall,
  type WindowsDesktopInstall,
  type WindowsDesktopManifest,
} from "@discorpus/platform-windows";
import { createSnapshotPaths, DiskBlobStore, InMemorySnapshotStore, writeJsonFile } from "@discorpus/storage";
import { createDiscordSnapshotKey, discordPlatforms } from "@discorpus/targets-discord";
import { createVersionSet } from "@discorpus/versioning";

import { type CollectLayer, formatArtifactCounts, formatCorpusSummary, formatUpstreamSummary, getCorpusDataDir, toArtifactCountObject, toPosixPath } from "./shared.js";

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

export async function runCollect(layer: CollectLayer, channel: ReleaseChannel, json: boolean): Promise<void> {
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
    const snapshotDir = await persistDesktopSnapshot(snapshot, desktopManifest, desktopArtifactRecords, versionSet, desktopAsarExtraction, dataDir);
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

function collectDesktopSignals(install: WindowsDesktopInstall, manifest: WindowsDesktopManifest): VersionSignal[] {
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

function collectWebSignals(manifest: WebCaptureManifest): VersionSignal[] {
  const signals: VersionSignal[] = [
    { scope: "web", name: "entry_url", value: manifest.entryUrl, confidence: "high" },
    { scope: "web", name: "final_url", value: manifest.document.finalUrl, confidence: "high" },
    { scope: "web", name: "document_sha256", value: manifest.document.sha256, confidence: "high" },
    { scope: "web", name: "asset_count", value: String(manifest.assets.length), confidence: "medium" },
  ];

  if (manifest.buildNumber) {
    signals.push({ scope: "web", name: "build_number", value: manifest.buildNumber, confidence: "high" });
  }

  for (const asset of manifest.assets) {
    signals.push({ scope: "web", name: "asset_path", value: asset.path, confidence: "medium" });
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
  const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "discorpus/0.1.0" } });
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
  const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "discorpus/0.1.0" } });
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
): Promise<DesktopAsarExtractionResult> {
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

  await writeSnapshotFiles(paths.rootDir, records, snapshot);
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

async function writeSnapshotFiles(
  rootDir: string,
  records: ReturnType<InMemorySnapshotStore["createArtifactRecord"]>[],
  snapshot: ReturnType<InMemorySnapshotStore["createSnapshotRecord"]>,
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
  const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "discorpus/0.1.0" } });

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
