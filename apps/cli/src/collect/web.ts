import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

import type { ReleaseChannel, VersionSignal } from "@discorpus/core";
import {
  captureDevtoolsNetwork,
  listDevtoolsTargets,
  waitForDevtoolsVersion,
  type DevtoolsCapturedResource,
  type DevtoolsTargetInfo,
} from "@discorpus/runtime-cdp";
import { createWindowsDesktopLaunchPlan, discoverWindowsDesktopInstall, launchWindowsDesktopClient } from "@discorpus/platform-windows";
import type { DiskBlobStore, InMemorySnapshotStore } from "@discorpus/storage";

import type {
  CliArtifactRecord,
  WebBootstrapChunkManifest,
  WebCaptureManifest,
  WebCapturedAsset,
  WebCapturedDocument,
  WebExcludedAsset,
  WebMissedAsset,
  WebRuntimeChunkManifest,
  WebRuntimeDiscovery,
  WebRuntimeSummary,
} from "../types/collect.js";

const WEB_FETCH_HEADERS = { "user-agent": "discorpus/0.1.0" };

export function collectWebSignals(manifest: WebCaptureManifest): VersionSignal[] {
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

  if (manifest.runtimeDiscovery) {
    signals.push({
      scope: "web",
      name: "runtime_target_count",
      value: String(manifest.runtimeDiscovery.targetCount),
      confidence: "medium",
    });

    if (manifest.runtimeDiscovery.selectedTarget) {
      signals.push({
        scope: "web",
        name: "runtime_selected_target",
        value: `${manifest.runtimeDiscovery.selectedTarget.type}:${manifest.runtimeDiscovery.selectedTarget.title || manifest.runtimeDiscovery.selectedTarget.url || manifest.runtimeDiscovery.selectedTarget.id}`,
        confidence: "high",
      });
    }
  }

  return signals;
}

export function createWebNormalizedFingerprint(manifest: WebCaptureManifest): string {
  const fingerprint = createHash("sha256");
  fingerprint.update(manifest.document.sha256);

  for (const asset of manifest.assets) {
    fingerprint.update(`${asset.path}:${asset.sha256}`);
  }

  return fingerprint.digest("hex");
}

export async function collectDiscordWebManifest(
  channel: ReleaseChannel,
  onProgress?: (message: string) => void,
): Promise<WebCaptureManifest> {
  const entryUrl = getDiscordWebEntryUrl(channel);
  const runtimeDiscovery = await collectDiscordWebRuntimeDiscovery(channel, onProgress);
  onProgress?.("web capture: session ended, deriving snapshot assets...");
  const capturedResources = runtimeDiscovery.capture?.resources ?? [];
  const runtimeDocument = selectRuntimeDocument(capturedResources, entryUrl);
  const livePageDocument = runtimeDiscovery.capture?.pageDocument
    ? createCapturedDocumentFromPage(runtimeDiscovery.capture.pageDocument)
    : null;
  const document = runtimeDocument ?? livePageDocument;

  if (!runtimeDiscovery.capture || capturedResources.length === 0) {
    throw new Error("live runtime capture produced no resources");
  }

  if (!document) {
    throw new Error(createMissingRuntimeDocumentError(runtimeDiscovery, capturedResources));
  }

  const html = decodeUtf8Body(document.body);
  const bootstrapChunkManifest = parseBootstrapChunkManifest(html);
  const { assets: runtimeAssets, excludedAssets, missedAssets, missedWebpackAssets } = await collectRuntimeAssets(capturedResources, document);
  onProgress?.("web capture: merging shell-declared assets...");
  const declaredAssets = await mergeDeclaredShellAssets(runtimeAssets, bootstrapChunkManifest, document.finalUrl);
  const runtimeChunkManifest = extractRuntimeChunkManifest(declaredAssets);
  onProgress?.("web capture: deriving runtime-map assets...");
  const assets = await mergeRuntimeMapAssets(declaredAssets, runtimeChunkManifest, document.finalUrl);
  runtimeDiscovery.summary = summarizeRuntimeCapture(
    capturedResources,
    document,
    excludedAssets,
    assets,
    missedAssets,
    missedWebpackAssets,
  );

  return {
    assetUrls: assets.map((asset) => asset.finalUrl),
    assets,
    bootstrapChunkManifest,
    buildNumber: extractWebBuildNumber(html),
    channel,
    document,
    entryUrl,
    excludedAssets,
    missedAssets,
    missedWebpackAssets,
    runtimeChunkManifest,
    runtimeDiscovery,
  };
}

export async function createWebArtifactRecords(
  snapshotId: string,
  snapshotStore: InMemorySnapshotStore,
  blobStore: DiskBlobStore,
  manifest: WebCaptureManifest,
): Promise<CliArtifactRecord[]> {
  const documentBody = manifest.document.body ?? await fetchBuffer(manifest.document.finalUrl);
  const documentSha256 = manifest.document.sha256 || hashBuffer(documentBody);
  const documentSize = manifest.document.size || documentBody.length;
  const documentBlob = await blobStore.persistBuffer(documentBody, documentSha256, "raw");
  const records: CliArtifactRecord[] = [
    snapshotStore.createArtifactRecord({
      snapshotId,
      kind: "web_document",
      path: "document/app.html",
      sha256: documentSha256,
      size: documentSize,
      source: manifest.document.finalUrl,
      blob: documentBlob,
    }),
  ];

  for (const asset of manifest.assets) {
    const buffer = asset.body ?? await fetchBuffer(asset.finalUrl);
    const sha256 = asset.sha256 || hashBuffer(buffer);
    const size = asset.size || buffer.length;
    const blob = await blobStore.persistBuffer(buffer, sha256, "raw");

    records.push(snapshotStore.createArtifactRecord({
      snapshotId,
      kind: asset.kind,
      path: asset.path,
      sha256,
      size,
      source: asset.finalUrl,
      blob,
    }));
  }

  return records;
}

async function fetchBuffer(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { headers: WEB_FETCH_HEADERS, redirect: "follow" });

  if (!response.ok) {
    throw new Error(`request failed: ${response.status} ${response.url}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

async function collectDiscordWebRuntimeDiscovery(
  channel: ReleaseChannel,
  onProgress?: (message: string) => void,
): Promise<WebRuntimeDiscovery> {
  const install = await discoverWindowsDesktopInstall(channel);

  if (!install) {
    throw new Error(`desktop install not found for channel: ${channel}`);
  }

  const remoteDebuggingPort = 9222;
  const launchOptions = {
    remoteDebuggingPort,
    startMinimized: false,
    useUpdater: false,
  };
  const launchPlan = createWindowsDesktopLaunchPlan(install, launchOptions);
  const child = launchWindowsDesktopClient(install, launchOptions);
  const devtoolsBaseUrl = `http://127.0.0.1:${remoteDebuggingPort}`;
  let completed = false;

  try {
    const version = await waitForDevtoolsVersion(devtoolsBaseUrl, { timeoutMs: 15000 });
    const session = await collectRuntimeCaptureSession(devtoolsBaseUrl, child, onProgress);
    completed = true;

    return {
      capture: session.capture,
      devtoolsBaseUrl,
      launchPlan,
      selectedTarget: session.selectedTarget,
      summary: null,
      targetCount: session.targets.length,
      targets: session.targets,
      version,
    };
  } finally {
    if (!completed) {
      child.kill();
    }
  }
}

async function collectRuntimeCaptureSession(
  baseUrl: string,
  child: ChildProcess,
  onProgress?: (message: string) => void,
): Promise<Pick<WebRuntimeDiscovery, "capture" | "selectedTarget" | "targets">> {
  const resources = new Map<string, DevtoolsCapturedResource>();
  const seenTargets = new Map<string, DevtoolsTargetInfo>();
  const attachedTargetIds = new Set<string>();
  let captureFinishedAt = new Date().toISOString();
  let captureStartedAt: string | null = null;
  let pageDocument: NonNullable<NonNullable<WebRuntimeDiscovery["capture"]>["pageDocument"]> | null = null;
  let selectedTarget: DevtoolsTargetInfo | null = null;
  let observedTarget = false;
  let devtoolsUnavailableSince: number | null = null;

  while (true) {
    let targets: DevtoolsTargetInfo[] = [];

    try {
      targets = await listDevtoolsTargets(baseUrl);
      devtoolsUnavailableSince = null;
    } catch {
      if (observedTarget) {
        devtoolsUnavailableSince ??= Date.now();

        if (Date.now() - devtoolsUnavailableSince >= 5000) {
          break;
        }
      } else if (!isChildRunning(child)) {
        break;
      }

      await sleep(500);
      continue;
    }

    for (const target of targets) {
      seenTargets.set(target.id, target);
    }

    const nextTarget = pickNextRuntimeCaptureTarget(targets, attachedTargetIds);

    if (!nextTarget?.webSocketDebuggerUrl) {
      if (observedTarget && !isChildRunning(child) && targets.length === 0) {
        break;
      }

      await sleep(500);
      continue;
    }

    observedTarget = true;
    attachedTargetIds.add(nextTarget.id);
    onProgress?.(`web capture: attached target ${nextTarget.type} ${nextTarget.url || nextTarget.id}`);

    if (!selectedTarget || isRemoteDiscordTarget(nextTarget)) {
      selectedTarget = nextTarget;
    }

    const capture = await captureDevtoolsNetwork(nextTarget.webSocketDebuggerUrl, {
      captureUntilClose: true,
      onProgress: (progress) => {
        onProgress?.(
          `web capture: live resources=${progress.resourceCount} bodies=${progress.bodyCapturedCount} pending=${progress.bodyPendingCount} failed=${progress.bodyFailedCount} skipped=${progress.bodySkippedCount}`,
        );
      },
      reloadOnAttach: false,
    });
    onProgress?.(`web capture: target closed ${nextTarget.url || nextTarget.id}, resources=${capture.resources.length}`);

    if (!captureStartedAt) {
      captureStartedAt = capture.startedAt;
    }

    captureFinishedAt = capture.finishedAt;
    pageDocument = pickPreferredPageDocument(pageDocument, capture.pageDocument, selectedTarget);

    for (const resource of capture.resources) {
      resources.set(`${nextTarget.id}:${resource.requestId}`, {
        ...resource,
        requestId: `${nextTarget.id}:${resource.requestId}`,
      });
    }
  }

  return {
    capture: captureStartedAt
      ? {
          finishedAt: captureFinishedAt,
          pageDocument,
          quietPeriodMs: 0,
          resources: [...resources.values()].sort((left, right) => left.finalUrl.localeCompare(right.finalUrl)),
          startedAt: captureStartedAt,
        }
      : null,
    selectedTarget,
    targets: [...seenTargets.values()],
  };
}

async function waitForDiscordTargets(baseUrl: string): Promise<ReturnType<typeof listDevtoolsTargets> extends Promise<infer T> ? T : never> {
  const startedAt = Date.now();
  let lastTargets = await listDevtoolsTargets(baseUrl);

  while (Date.now() - startedAt < 30000) {
    const preferredTarget = pickRuntimeCaptureTarget(lastTargets);

    if (preferredTarget?.webSocketDebuggerUrl && isRemoteDiscordTarget(preferredTarget)) {
      return lastTargets;
    }

    await sleep(500);
    lastTargets = await listDevtoolsTargets(baseUrl);
  }

  return lastTargets;
}

function pickNextRuntimeCaptureTarget(
  targets: DevtoolsTargetInfo[],
  attachedTargetIds: Set<string>,
): DevtoolsTargetInfo | null {
  const pageTargets = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
  const unattachedTargets = pageTargets.filter((target) => !attachedTargetIds.has(target.id));

  if (unattachedTargets.length === 0) {
    return null;
  }

  return pickRuntimeCaptureTarget(unattachedTargets);
}

function pickPreferredPageDocument(
  current: NonNullable<NonNullable<WebRuntimeDiscovery["capture"]>["pageDocument"]> | null,
  candidate: NonNullable<NonNullable<WebRuntimeDiscovery["capture"]>["pageDocument"]> | null,
  selectedTarget: DevtoolsTargetInfo | null,
): NonNullable<NonNullable<WebRuntimeDiscovery["capture"]>["pageDocument"]> | null {
  if (!candidate) {
    return current;
  }

  if (!current) {
    return candidate;
  }

  return scorePageDocument(candidate, selectedTarget) > scorePageDocument(current, selectedTarget)
    ? candidate
    : current;
}

function scorePageDocument(
  pageDocument: NonNullable<NonNullable<WebRuntimeDiscovery["capture"]>["pageDocument"]>,
  selectedTarget: DevtoolsTargetInfo | null,
): number {
  let score = 0;

  if (isRemoteDiscordUrl(pageDocument.finalUrl)) {
    score += 100;
  }

  if (selectedTarget && isSameOrigin(pageDocument.finalUrl, selectedTarget.url)) {
    score += 25;
  }

  if (pageDocument.contentType?.toLowerCase().includes("html")) {
    score += 10;
  }

  if (!pageDocument.finalUrl.startsWith("file:")) {
    score += 5;
  }

  return score;
}

function selectRuntimeDocument(resources: DevtoolsCapturedResource[], entryUrl: string): WebCapturedDocument | null {
  const documentResource = resources.find((resource) =>
    resource.resourceType === "Document" &&
    resource.body &&
    (resource.finalUrl.includes("/app") || resource.finalUrl === entryUrl),
  ) ?? resources.find((resource) => resource.resourceType === "Document" && resource.body);

  if (!documentResource || !documentResource.body || documentResource.status === null) {
    return null;
  }

  return {
    body: documentResource.body,
    contentType: documentResource.contentType,
    finalUrl: documentResource.finalUrl,
    headers: documentResource.headers,
    resourceType: documentResource.resourceType,
    sha256: hashBuffer(documentResource.body),
    size: documentResource.body.length,
    status: documentResource.status,
    url: documentResource.url,
  };
}

function createCapturedDocumentFromPage(pageDocument: NonNullable<NonNullable<WebRuntimeDiscovery["capture"]>["pageDocument"]>): WebCapturedDocument {
  const body = new Uint8Array(Buffer.from(pageDocument.html, "utf8"));

  return {
    body,
    contentType: pageDocument.contentType,
    finalUrl: pageDocument.finalUrl,
    resourceType: "Document",
    sha256: hashBuffer(body),
    size: body.length,
    status: 200,
    url: pageDocument.finalUrl,
  };
}

async function collectRuntimeAssets(
  resources: DevtoolsCapturedResource[],
  document: WebCapturedDocument,
): Promise<{
  assets: WebCapturedAsset[];
  excludedAssets: WebExcludedAsset[];
  missedAssets: WebMissedAsset[];
  missedWebpackAssets: WebMissedAsset[];
}> {
  const trustedOrigins = createTrustedDiscordOrigins(document.finalUrl);
  const assetsByPath = new Map<string, WebCapturedAsset>();
  const excludedAssets: WebExcludedAsset[] = [];
  const missedAssets: WebMissedAsset[] = [];
  const missedWebpackAssetsByPath = new Map<string, WebMissedAsset>();

  for (const resource of resources) {
    if (isExcludedContentResource(resource)) {
      excludedAssets.push({
        contentType: resource.contentType,
        finalUrl: resource.finalUrl,
        path: createWebArtifactPath(resource.finalUrl),
        reason: "user_or_content_media",
        resourceType: resource.resourceType,
        status: resource.status,
      });
      continue;
    }

    const webpackCandidate = isWebpackCandidateResource(resource, trustedOrigins, document.finalUrl);
    const promotable = isPromotableDiscordResource(resource, trustedOrigins, document.finalUrl);

    if (!promotable && !webpackCandidate) {
      continue;
    }

    const recoveredBody = await recoverPromotableResourceBody(resource, webpackCandidate);
    const body = recoveredBody ?? resource.body ?? undefined;
    const kind = classifyWebArtifact(resource.finalUrl, resource.contentType, resource.resourceType);
    const path = createWebArtifactPath(resource.finalUrl);

    if (kind === "web_unknown") {
      continue;
    }

    if (!body || body.length === 0) {
      missedAssets.push({
        bodyError: resource.bodyError,
        bodyState: body ? "captured_empty" : resource.bodyState,
        contentType: resource.contentType,
        finalUrl: resource.finalUrl,
        path,
        reason: !body ? "no_body" : "empty_body",
        resourceType: resource.resourceType,
        status: resource.status,
      });

      if (webpackCandidate) {
        missedWebpackAssetsByPath.set(path, {
          bodyError: resource.bodyError,
          bodyState: body ? "captured_empty" : resource.bodyState,
          contentType: resource.contentType,
          finalUrl: resource.finalUrl,
          path,
          reason: !body ? "no_body" : "empty_body",
          resourceType: resource.resourceType,
          status: resource.status,
        });
      }
      continue;
    }

    const asset: WebCapturedAsset = {
      body,
      contentType: resource.contentType,
      declarationKinds: [],
      finalUrl: resource.finalUrl,
      headers: resource.headers,
      kind,
      path,
      provenance: "runtime",
      resourceType: resource.resourceType,
      sha256: hashBuffer(body),
      size: body.length,
      status: resource.status as number,
      url: resource.url,
    };

    const existing = assetsByPath.get(path);

    if (!existing || shouldReplacePromotedAsset(existing, asset)) {
      assetsByPath.set(path, asset);
    }
  }

  for (const resource of resources) {
    const webpackCandidate = isWebpackCandidateResource(resource, trustedOrigins, document.finalUrl);

    if (!webpackCandidate) {
      continue;
    }

    const path = createWebArtifactPath(resource.finalUrl);

    if (assetsByPath.has(path) || missedWebpackAssetsByPath.has(path)) {
      continue;
    }

    missedWebpackAssetsByPath.set(path, {
      bodyError: resource.bodyError,
      bodyState: resource.bodyState,
      contentType: resource.contentType,
      finalUrl: resource.finalUrl,
      path,
      reason: classifyUnrecoveredWebpackReason(resource),
      resourceType: resource.resourceType,
      status: resource.status,
    });
  }

  return {
    assets: [...assetsByPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
    excludedAssets: dedupeExcludedAssets(excludedAssets),
    missedAssets: missedAssets.sort((left, right) => left.path.localeCompare(right.path)),
    missedWebpackAssets: [...missedWebpackAssetsByPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function summarizeRuntimeCapture(
  resources: DevtoolsCapturedResource[],
  document: WebCapturedDocument,
  excludedAssets: WebExcludedAsset[],
  promotedAssets: WebCapturedAsset[],
  missedAssets: WebMissedAsset[],
  missedWebpackAssets: WebMissedAsset[],
): WebRuntimeSummary {
  const trustedOrigins = createTrustedDiscordOrigins(document.finalUrl);
  const contentTypeFamilies: Record<string, number> = {};
  const origins: Record<string, number> = {};
  const bodyStates: Record<string, number> = {};
  const resourceTypes: Record<string, number> = {};
  let capturedWithBodyCount = 0;
  let declaredAssetCount = 0;
  let promotableResourceCount = 0;
  let runtimeMapAssetCount = 0;
  let sameOriginResourceCount = 0;
  let sameOriginWithBodyCount = 0;

  for (const resource of resources) {
    const resourceType = resource.resourceType || "unknown";
    resourceTypes[resourceType] = (resourceTypes[resourceType] ?? 0) + 1;
    bodyStates[resource.bodyState] = (bodyStates[resource.bodyState] ?? 0) + 1;

    const contentTypeFamily = getContentTypeFamily(resource.contentType);
    contentTypeFamilies[contentTypeFamily] = (contentTypeFamilies[contentTypeFamily] ?? 0) + 1;

    const origin = getResourceOriginLabel(resource.finalUrl);
    origins[origin] = (origins[origin] ?? 0) + 1;

    if (resource.body) {
      capturedWithBodyCount += 1;
    }

    if (trustedOrigins.has(origin)) {
      sameOriginResourceCount += 1;

      if (resource.body) {
        sameOriginWithBodyCount += 1;
      }
    }

    if (isPromotableDiscordResource(resource, trustedOrigins, document.finalUrl)) {
      promotableResourceCount += 1;
    }
  }

  for (const asset of promotedAssets) {
    if (asset.provenance === "declared") {
      declaredAssetCount += 1;
    }

    if (asset.provenance === "runtime_map") {
      runtimeMapAssetCount += 1;
    }
  }

  return {
    bodyStates: sortCountMap(bodyStates),
    capturedResourceCount: resources.length,
    capturedWithBodyCount,
    declaredAssetCount,
    contentTypeFamilies: sortCountMap(contentTypeFamilies),
    excludedAssetCount: excludedAssets.length,
    missedAssetCount: missedAssets.length,
    missedWebpackAssetCount: missedWebpackAssets.length,
    origins: sortCountMap(origins),
    promotableResourceCount,
    promotedAssetCount: promotedAssets.length,
    promotedKinds: sortCountMap(countAssetKinds(promotedAssets)),
    resourceTypes: sortCountMap(resourceTypes),
    runtimeMapAssetCount,
    sameOriginResourceCount,
    sameOriginWithBodyCount,
  };
}

function classifyWebArtifact(url: string, contentType: string | null, resourceType: string): string {
  const extension = path.posix.extname(new URL(url).pathname).toLowerCase();
  const normalizedContentType = contentType?.split(";")[0].trim().toLowerCase() ?? "";

  if (resourceType === "Document") {
    return "web_document";
  }

  if (extension === ".html" || normalizedContentType.includes("text/html")) {
    return "web_html";
  }

  if (extension === ".map") {
    return "web_source_map";
  }

  if (extension === ".webm" || extension === ".mp3" || extension === ".mp4" || normalizedContentType.startsWith("video/") || normalizedContentType.startsWith("audio/")) {
    return "web_media";
  }

  if (extension === ".wasm" || normalizedContentType.includes("wasm")) {
    return "web_wasm";
  }

  if (extension === ".woff" || extension === ".woff2" || extension === ".ttf" || normalizedContentType.startsWith("font/")) {
    return "web_font";
  }

  if (extension === ".png" || extension === ".jpg" || extension === ".jpeg" || extension === ".gif" || extension === ".webp" || extension === ".svg" || extension === ".ico" || normalizedContentType.startsWith("image/")) {
    return "web_image";
  }

  if (resourceType === "Script" || normalizedContentType.includes("javascript") || extension === ".js" || extension === ".mjs") {
    return "web_script";
  }

  if (resourceType === "Stylesheet" || normalizedContentType.includes("css") || extension === ".css") {
    return "web_stylesheet";
  }

  if (resourceType === "XHR" || resourceType === "Fetch" || normalizedContentType.includes("json") || extension === ".json") {
    return "web_json";
  }

  return resourceType === "Other" ? "web_asset" : "web_unknown";
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

function createMissingRuntimeDocumentError(
  runtimeDiscovery: WebRuntimeDiscovery,
  resources: DevtoolsCapturedResource[],
): string {
  const documentResources = resources.filter((resource) => resource.resourceType === "Document");
  const documentUrls = documentResources
    .slice(0, 5)
    .map((resource) => `${resource.finalUrl} [bodyState=${resource.bodyState}]`)
    .join(", ");

  return [
    "live runtime capture did not produce a usable document body",
    `selected target: ${runtimeDiscovery.selectedTarget?.url ?? "none"}`,
    `document resources: ${documentResources.length}`,
    `examples: ${documentUrls || "none"}`,
  ].join("; ");
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

function parseBootstrapChunkManifest(html: string): WebBootstrapChunkManifest {
  return {
    dataRspackChunkIds: extractDataRspackChunkIds(html),
    globalEnv: extractGlobalEnvFields(html),
    prefetchScripts: extractPrefetchAssets(html, "script"),
    prefetchStyles: extractPrefetchStyles(html),
    scriptUrls: extractScriptUrls(html),
    stylesheetUrls: extractStylesheetUrls(html),
  };
}

function extractPrefetchStyles(html: string): string[] {
  return extractPrefetchAssets(html, "style");
}

function extractPrefetchAssets(html: string, as: "script" | "style"): string[] {
  const matches = new Set<string>();
  const patterns = [
    new RegExp(`<link[^>]+rel=["'][^"']*prefetch[^"']*["'][^>]+as=["']${as}["'][^>]+href=["']([^"']+)["']`, "gi"),
    new RegExp(`<link[^>]+as=["']${as}["'][^>]+rel=["'][^"']*prefetch[^"']*["'][^>]+href=["']([^"']+)["']`, "gi"),
  ];

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      if (match[1]) {
        matches.add(match[1]);
      }
    }
  }

  return [...matches].sort();
}

function extractScriptUrls(html: string): string[] {
  return extractTagUrls(html, /<script[^>]+src=["']([^"']+)["']/gi);
}

function extractStylesheetUrls(html: string): string[] {
  return extractTagUrls(html, /<link[^>]+rel=["'][^"']*stylesheet[^"']*["'][^>]+href=["']([^"']+)["']/gi);
}

function extractTagUrls(html: string, pattern: RegExp): string[] {
  const matches = new Set<string>();

  for (const match of html.matchAll(pattern)) {
    if (match[1]) {
      matches.add(match[1]);
    }
  }

  return [...matches].sort();
}

function extractDataRspackChunkIds(html: string): string[] {
  const ids = new Set<string>();
  const pattern = /data-rspack=["']discord_app:chunk-([^"']+)["']/gi;

  for (const match of html.matchAll(pattern)) {
    if (match[1]) {
      ids.add(match[1]);
    }
  }

  return [...ids].sort();
}

function extractGlobalEnvFields(html: string): Record<string, string | number | boolean | null> {
  const objectLiteral = extractAssignedObjectLiteral(html, "window.GLOBAL_ENV");

  if (!objectLiteral) {
    return {};
  }
  const fields = new Map<string, string | number | boolean | null>();
  const allowedKeys = [
    "API_ENDPOINT",
    "API_VERSION",
    "BUILD_NUMBER",
    "CDN_HOST",
    "MEDIA_PROXY_ENDPOINT",
    "PROJECT_ENV",
    "PUBLIC_PATH",
    "RELEASE_CHANNEL",
    "VERSION_HASH",
  ];

  for (const key of allowedKeys) {
    const value = extractLooseObjectLiteralValue(objectLiteral, key);

    if (value !== undefined) {
      fields.set(key, value);
    }
  }

  const buildId = extractLooseNestedObjectValue(objectLiteral, "SENTRY_TAGS", "buildId");

  if (buildId !== undefined) {
    fields.set("SENTRY_TAGS.buildId", buildId);
  }

  return Object.fromEntries([...fields.entries()].sort((left, right) => left[0].localeCompare(right[0])));
}

function extractAssignedObjectLiteral(source: string, assignment: string): string | null {
  const assignmentIndex = source.indexOf(assignment);

  if (assignmentIndex === -1) {
    return null;
  }

  const equalsIndex = source.indexOf("=", assignmentIndex + assignment.length);

  if (equalsIndex === -1) {
    return null;
  }

  const objectStart = source.indexOf("{", equalsIndex + 1);

  if (objectStart === -1) {
    return null;
  }

  let depth = 0;
  let inString: '"' | "'" | null = null;
  let escaped = false;

  for (let index = objectStart; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === inString) {
        inString = null;
      }

      continue;
    }

    if (char === "\"" || char === "'") {
      inString = char;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return source.slice(objectStart, index + 1);
      }
    }
  }

  return null;
}

function extractLooseObjectLiteralValue(
  objectLiteral: string,
  key: string,
): string | number | boolean | null | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = objectLiteral.match(new RegExp(`${escapedKey}\\s*:\\s*("([^"\\\\]|\\\\.)*"|'([^'\\\\]|\\\\.)*'|true|false|null|-?\\d+)`, "i"));

  if (!match?.[1]) {
    return undefined;
  }

  return parseLooseLiteralValue(match[1]);
}

function extractLooseNestedObjectValue(
  objectLiteral: string,
  parentKey: string,
  childKey: string,
): string | number | boolean | null | undefined {
  const escapedParentKey = parentKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parentMatch = objectLiteral.match(new RegExp(`${escapedParentKey}\\s*:\\s*\\{([\\s\\S]*?)\\}`, "i"));

  if (!parentMatch?.[1]) {
    return undefined;
  }

  return extractLooseObjectLiteralValue(parentMatch[1], childKey);
}

function parseLooseLiteralValue(value: string): string | number | boolean | null {
  const trimmed = value.trim();

  if (trimmed === "true") {
    return true;
  }

  if (trimmed === "false") {
    return false;
  }

  if (trimmed === "null") {
    return null;
  }

  if (/^-?\d+$/.test(trimmed)) {
    return Number(trimmed);
  }

  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replace(/\\(["'\\\/bfnrt])/g, "$1");
  }

  return trimmed;
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

function pickRuntimeCaptureTarget(targets: DevtoolsTargetInfo[]): DevtoolsTargetInfo | null {
  const pageTargets = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);

  if (pageTargets.length === 0) {
    return null;
  }

  const remoteDiscordTarget = pageTargets.find(isRemoteDiscordTarget);

  if (remoteDiscordTarget) {
    return remoteDiscordTarget;
  }

  const remoteHttpTarget = pageTargets.find((target) => target.url.startsWith("https://") || target.url.startsWith("http://"));

  if (remoteHttpTarget) {
    return remoteHttpTarget;
  }

  return pageTargets[0];
}

function isRemoteDiscordTarget(target: DevtoolsTargetInfo): boolean {
  return isRemoteDiscordUrl(target.url);
}

function hashBuffer(buffer: Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function sanitizePathComponent(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "_");
}

function isPromotableDiscordResource(
  resource: DevtoolsCapturedResource,
  trustedOrigins: Set<string>,
  documentUrl: string,
): boolean {
  if (resource.status === null || resource.status < 200 || resource.status >= 400) {
    return false;
  }

  if (resource.resourceType === "Preflight" || resource.resourceType === "WebSocket" || resource.resourceType === "Manifest") {
    return false;
  }

  if (resource.finalUrl === documentUrl) {
    return false;
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(resource.finalUrl);
  } catch {
    return false;
  }

  if (!trustedOrigins.has(parsedUrl.origin)) {
    return false;
  }

  if (parsedUrl.pathname.startsWith("/assets/")) {
    return true;
  }

  if (
    resource.resourceType === "Script" ||
    resource.resourceType === "Stylesheet" ||
    resource.resourceType === "Image" ||
    resource.resourceType === "Font"
  ) {
    return true;
  }

  if ((resource.resourceType === "XHR" || resource.resourceType === "Fetch") && (
    resource.contentType?.toLowerCase().includes("json") ||
    path.posix.extname(parsedUrl.pathname).toLowerCase() === ".json"
  )) {
    return true;
  }

  const extension = path.posix.extname(parsedUrl.pathname).toLowerCase();

  return extension === ".js" ||
    extension === ".mjs" ||
    extension === ".css" ||
    extension === ".html" ||
    extension === ".json" ||
    extension === ".map" ||
    extension === ".wasm" ||
    extension === ".webm" ||
    extension === ".mp3" ||
    extension === ".mp4" ||
    extension === ".woff" ||
    extension === ".woff2" ||
    extension === ".ttf" ||
    extension === ".svg" ||
    extension === ".png" ||
    extension === ".jpg" ||
    extension === ".jpeg" ||
    extension === ".gif" ||
    extension === ".webp" ||
    extension === ".ico";
}

function decodeUtf8Body(body: Uint8Array | undefined): string {
  if (!body) {
    return "";
  }

  return Buffer.from(body).toString("utf8");
}

function createTrustedDiscordOrigins(documentUrl: string): Set<string> {
  const origins = new Set<string>([
    "https://discord.com",
  ]);

  try {
    origins.add(new URL(documentUrl).origin);
  } catch {
    // ignore invalid document url
  }

  return origins;
}

async function mergeDeclaredShellAssets(
  runtimeAssets: WebCapturedAsset[],
  bootstrapChunkManifest: WebBootstrapChunkManifest,
  documentUrl: string,
): Promise<WebCapturedAsset[]> {
  const assetsByPath = new Map(runtimeAssets.map((asset) => [asset.path, asset]));
  const declarationKindsByUrl = new Map<string, Set<string>>();
  const declaredSources = [
    { kind: "prefetch_style", urls: bootstrapChunkManifest.prefetchStyles },
    { kind: "prefetch_script", urls: bootstrapChunkManifest.prefetchScripts },
    { kind: "stylesheet", urls: bootstrapChunkManifest.stylesheetUrls },
    { kind: "script", urls: bootstrapChunkManifest.scriptUrls },
  ] as const;

  for (const source of declaredSources) {
    for (const value of source.urls) {
      let resolvedUrl: URL;

      try {
        resolvedUrl = new URL(value, documentUrl);
      } catch {
        continue;
      }

      if (!isDeclaredShellAssetUrl(resolvedUrl)) {
        continue;
      }

      const url = resolvedUrl.toString();
      const kinds = declarationKindsByUrl.get(url) ?? new Set<string>();
      kinds.add(source.kind);
      declarationKindsByUrl.set(url, kinds);
    }
  }

  for (const [url, declarationKindsSet] of declarationKindsByUrl.entries()) {
    const path = createWebArtifactPath(url);
    const declarationKinds = [...declarationKindsSet].sort();
    const existing = assetsByPath.get(path);

    if (existing) {
      existing.declarationKinds = mergeDeclarationKinds(existing.declarationKinds, declarationKinds);
      continue;
    }

    let body: Uint8Array;

    try {
      body = await fetchBuffer(url);
    } catch {
      continue;
    }

    if (body.length === 0) {
      continue;
    }

    const kind = classifyWebArtifact(url, null, inferDeclaredResourceType(url));

    if (kind === "web_unknown") {
      continue;
    }

    assetsByPath.set(path, {
      body,
      contentType: null,
      declarationKinds,
      finalUrl: url,
      kind,
      path,
      provenance: "declared",
      resourceType: inferDeclaredResourceType(url),
      sha256: hashBuffer(body),
      size: body.length,
      status: 200,
      url,
    });
  }

  return [...assetsByPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

async function mergeRuntimeMapAssets(
  assets: WebCapturedAsset[],
  runtimeChunkManifest: WebRuntimeChunkManifest,
  documentUrl: string,
): Promise<WebCapturedAsset[]> {
  const assetsByPath = new Map(assets.map((asset) => [asset.path, asset]));

  for (const url of runtimeChunkManifest.derivedUrls) {
    let resolvedUrl: URL;

    try {
      resolvedUrl = new URL(url, documentUrl);
    } catch {
      continue;
    }

    if (!isDeclaredShellAssetUrl(resolvedUrl)) {
      continue;
    }

    const finalUrl = resolvedUrl.toString();
    const path = createWebArtifactPath(finalUrl);
    const runtimeMapSources = runtimeChunkManifest.chunkMaps
      .filter((item) => runtimeChunkManifestUrlMatchesMap(item, finalUrl))
      .map((item) => item.sourcePath)
      .sort();
    const existing = assetsByPath.get(path);

    if (existing) {
      if (!existing.runtimeMapSources?.length && runtimeMapSources.length > 0) {
        existing.runtimeMapSources = runtimeMapSources;
      }
      continue;
    }

    let body: Uint8Array;

    try {
      body = await fetchBuffer(finalUrl);
    } catch {
      continue;
    }

    if (body.length === 0) {
      continue;
    }

    const resourceType = inferDeclaredResourceType(finalUrl);
    const kind = classifyWebArtifact(finalUrl, null, resourceType);

    if (kind === "web_unknown") {
      continue;
    }

    assetsByPath.set(path, {
      body,
      contentType: null,
      declarationKinds: [],
      finalUrl,
      kind,
      path,
      provenance: "runtime_map",
      resourceType,
      runtimeMapSources,
      sha256: hashBuffer(body),
      size: body.length,
      status: 200,
      url: finalUrl,
    });
  }

  return [...assetsByPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function extractRuntimeChunkManifest(assets: WebCapturedAsset[]): WebRuntimeChunkManifest {
  const derivedUrls = new Set<string>();
  const sourceMapUrls = new Set<string>();
  const chunkMaps: WebRuntimeChunkManifest["chunkMaps"] = [];

  for (const asset of assets) {
    if (asset.kind !== "web_script" || !asset.body) {
      continue;
    }

    const text = decodeUtf8Body(asset.body);

    for (const url of extractSourceMapUrls(text, asset.finalUrl)) {
      sourceMapUrls.add(url);
      derivedUrls.add(url);
    }

    for (const chunkMap of extractChunkMaps(text)) {
      chunkMaps.push({
        inferredExtension: chunkMap.inferredExtension,
        sampleEntries: chunkMap.entries.slice(0, 25).map(([chunkId, hash]) => ({ chunkId, hash })),
        sourcePath: asset.path,
      });

      for (const [chunkId, hash] of chunkMap.entries) {
        derivedUrls.add(createDiscordAssetUrl(chunkId, hash, chunkMap.inferredExtension));
      }
    }
  }

  return {
    chunkMaps: chunkMaps.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath)),
    derivedUrls: [...derivedUrls].sort(),
    sourceMapUrls: [...sourceMapUrls].sort(),
  };
}

function extractChunkMaps(text: string): Array<{ entries: Array<[string, string]>; inferredExtension: ".css" | ".js" }> {
  const matches = [...text.matchAll(/[,{]\s*(\d{1,6})\s*:\s*"([0-9a-f]{6,20})"/g)];
  const groups: Array<{ entries: Array<[string, string]>; inferredExtension: ".css" | ".js" }> = [];
  let current: Array<[string, string]> = [];
  let lastIndex = -1000;
  let groupStart = 0;

  for (const match of matches) {
    if (current.length > 0 && match.index - lastIndex > 8) {
      pushChunkMapGroup(groups, current, text, groupStart, lastIndex);
      current = [];
      groupStart = match.index;
    }

    if (current.length === 0) {
      groupStart = match.index;
    }

    current.push([match[1], match[2]]);
    lastIndex = match.index + match[0].length;
  }

  pushChunkMapGroup(groups, current, text, groupStart, lastIndex);
  return dedupeChunkMapGroups(groups);
}

function pushChunkMapGroup(
  groups: Array<{ entries: Array<[string, string]>; inferredExtension: ".css" | ".js" }>,
  entries: Array<[string, string]>,
  text: string,
  start: number,
  end: number,
): void {
  if (entries.length < 10) {
    return;
  }

  const context = text.slice(Math.max(0, start - 300), Math.min(text.length, end + 300));
  const inferredExtension: ".css" | ".js" = /\.css["'`]/.test(context) && !/\.js["'`]/.test(context) ? ".css" : ".js";
  groups.push({ entries: [...entries], inferredExtension });
}

function dedupeChunkMapGroups(
  groups: Array<{ entries: Array<[string, string]>; inferredExtension: ".css" | ".js" }>,
): Array<{ entries: Array<[string, string]>; inferredExtension: ".css" | ".js" }> {
  const seen = new Set<string>();
  const deduped: Array<{ entries: Array<[string, string]>; inferredExtension: ".css" | ".js" }> = [];

  for (const group of groups) {
    const key = `${group.inferredExtension}:${group.entries.length}:${group.entries.slice(0, 10).map(([id, hash]) => `${id}:${hash}`).join(",")}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(group);
  }

  return deduped;
}

function extractSourceMapUrls(text: string, baseUrl: string): string[] {
  const matches = new Set<string>();
  const pattern = /\/\/# sourceMappingURL=([^\s]+)/g;

  for (const match of text.matchAll(pattern)) {
    if (!match[1]) {
      continue;
    }

    try {
      matches.add(new URL(match[1], baseUrl).toString());
    } catch {
      continue;
    }
  }

  return [...matches];
}

function createDiscordAssetUrl(chunkId: string, hash: string, extension: ".css" | ".js"): string {
  return `https://discord.com/assets/${chunkId}.${hash}${extension}`;
}

function runtimeChunkManifestUrlMatchesMap(
  chunkMap: WebRuntimeChunkManifest["chunkMaps"][number],
  url: string,
): boolean {
  try {
    const pathname = new URL(url).pathname;
    return pathname.endsWith(chunkMap.inferredExtension);
  } catch {
    return false;
  }
}

function isDeclaredShellAssetUrl(url: URL): boolean {
  return url.origin === "https://discord.com" && url.pathname.startsWith("/assets/");
}

function inferDeclaredResourceType(url: string): string {
  const extension = path.posix.extname(new URL(url).pathname).toLowerCase();

  if (extension === ".css") {
    return "Stylesheet";
  }

  if (extension === ".js" || extension === ".mjs") {
    return "Script";
  }

  if (extension === ".html") {
    return "Document";
  }

  return "Other";
}

function mergeDeclarationKinds(current: string[] | undefined, next: string[]): string[] {
  return [...new Set([...(current ?? []), ...next])].sort();
}

function isExcludedContentResource(resource: DevtoolsCapturedResource): boolean {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(resource.finalUrl);
  } catch {
    return false;
  }

  if (parsedUrl.origin === "https://discord.com" && parsedUrl.pathname.toLowerCase().startsWith("/api/")) {
    return true;
  }

  if (parsedUrl.origin !== "https://cdn.discordapp.com" && parsedUrl.origin !== "https://media.discordapp.net") {
    return false;
  }

  const pathname = parsedUrl.pathname.toLowerCase();

  return pathname.startsWith("/app-assets/") ||
    pathname.startsWith("/app-icons/") ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/avatar-decoration-presets/") ||
    pathname.startsWith("/avatars/") ||
    pathname.startsWith("/guild-icons/") ||
    pathname.startsWith("/channel-icons/") ||
    pathname.startsWith("/role-icons/") ||
    pathname.startsWith("/embed/avatars/");
}

async function recoverPromotableResourceBody(
  resource: DevtoolsCapturedResource,
  webpackCandidate = false,
): Promise<Uint8Array | null> {
  if (resource.body && resource.body.length > 0) {
    return resource.body;
  }

  if (!shouldRecoverResourceByFetch(resource)) {
    return null;
  }

  try {
    const body = await fetchBuffer(resource.finalUrl);
    return body.length > 0 ? body : null;
  } catch {
    return null;
  }
}

function shouldRecoverResourceByFetch(resource: DevtoolsCapturedResource, webpackCandidate = false): boolean {
  try {
    const parsedUrl = new URL(resource.finalUrl);
    const extension = path.posix.extname(parsedUrl.pathname).toLowerCase();
    const contentType = resource.contentType?.toLowerCase() ?? "";
    const isAssetPath = parsedUrl.origin === "https://discord.com" && parsedUrl.pathname.startsWith("/assets/");

    if (resource.status !== null && (resource.status < 200 || resource.status >= 400)) {
      return false;
    }

    return webpackCandidate || isAssetPath || (
      extension === ".js" ||
      extension === ".mjs" ||
      extension === ".css" ||
      extension === ".html" ||
      extension === ".json" ||
      extension === ".map" ||
      extension === ".wasm" ||
      extension === ".webm" ||
      extension === ".mp3" ||
      extension === ".mp4" ||
      extension === ".woff" ||
      extension === ".woff2" ||
      extension === ".ttf" ||
      extension === ".png" ||
      extension === ".jpg" ||
      extension === ".jpeg" ||
      extension === ".gif" ||
      extension === ".webp" ||
      extension === ".svg" ||
      extension === ".ico" ||
      contentType.includes("javascript") ||
      contentType.includes("css") ||
      contentType.includes("json") ||
      contentType.includes("wasm") ||
      contentType.startsWith("video/") ||
      contentType.startsWith("audio/") ||
      contentType.startsWith("font/") ||
      contentType.startsWith("image/")
    );
  } catch {
    return false;
  }
}

function shouldReplacePromotedAsset(current: WebCapturedAsset, candidate: WebCapturedAsset): boolean {
  if ((candidate.body?.length ?? 0) !== (current.body?.length ?? 0)) {
    return (candidate.body?.length ?? 0) > (current.body?.length ?? 0);
  }

  if (candidate.sha256 !== current.sha256) {
    return candidate.sha256 !== EMPTY_SHA256 && current.sha256 === EMPTY_SHA256;
  }

  return candidate.finalUrl.localeCompare(current.finalUrl) < 0;
}

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function dedupeExcludedAssets(assets: WebExcludedAsset[]): WebExcludedAsset[] {
  const assetsByPath = new Map<string, WebExcludedAsset>();

  for (const asset of assets) {
    if (!assetsByPath.has(asset.path)) {
      assetsByPath.set(asset.path, asset);
    }
  }

  return [...assetsByPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function isWebpackCandidateResource(
  resource: DevtoolsCapturedResource,
  trustedOrigins: Set<string>,
  documentUrl: string,
): boolean {
  if (resource.finalUrl === documentUrl) {
    return false;
  }

  try {
    const parsedUrl = new URL(resource.finalUrl);
    const extension = path.posix.extname(parsedUrl.pathname).toLowerCase();

    return trustedOrigins.has(parsedUrl.origin) &&
      parsedUrl.pathname.startsWith("/assets/") && (
        extension === ".js" ||
        extension === ".mjs" ||
        extension === ".css" ||
        extension === ".html" ||
        extension === ".map" ||
        extension === ".wasm"
      );
  } catch {
    return false;
  }
}

function classifyUnrecoveredWebpackReason(resource: DevtoolsCapturedResource): string {
  if (resource.bodyState === "missing") {
    return "unobserved_response_body";
  }

  if (resource.bodyState === "failed") {
    return "body_retrieval_failed";
  }

  if (resource.bodyState === "skipped") {
    return "body_retrieval_skipped";
  }

  if (resource.status === null) {
    return "no_final_response_status";
  }

  return "unrecovered_after_capture";
}

function countAssetKinds(assets: WebCapturedAsset[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const asset of assets) {
    counts[asset.kind] = (counts[asset.kind] ?? 0) + 1;
  }

  return counts;
}

function getContentTypeFamily(contentType: string | null): string {
  if (!contentType) {
    return "unknown";
  }

  const normalized = contentType.split(";")[0].trim().toLowerCase();
  const slashIndex = normalized.indexOf("/");

  if (slashIndex === -1) {
    return normalized || "unknown";
  }

  return normalized.slice(0, slashIndex) || "unknown";
}

function getResourceOriginLabel(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "unknown";
  }
}

function isRemoteDiscordUrl(url: string): boolean {
  return url.startsWith("https://discord.com") ||
    url.startsWith("https://ptb.discord.com") ||
    url.startsWith("https://canary.discord.com");
}

function isSameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function sortCountMap(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts).sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }

      return left[0].localeCompare(right[0]);
    }),
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isChildRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function waitForProcessExit(child: ChildProcess): Promise<void> {
  if (!isChildRunning(child)) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    child.once("exit", () => resolve());
  });
}
