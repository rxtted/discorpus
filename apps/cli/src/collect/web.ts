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
  WebCaptureManifest,
  WebCapturedAsset,
  WebCapturedDocument,
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

export async function collectDiscordWebManifest(channel: ReleaseChannel): Promise<WebCaptureManifest> {
  const entryUrl = getDiscordWebEntryUrl(channel);
  const runtimeDiscovery = await collectDiscordWebRuntimeDiscovery(channel);
  const capturedResources = runtimeDiscovery.capture?.resources ?? [];
  const runtimeDocument = selectRuntimeDocument(capturedResources, entryUrl);

  if (!runtimeDiscovery.capture || capturedResources.length === 0) {
    throw new Error("live runtime capture produced no resources");
  }

  if (!runtimeDocument) {
    throw new Error(createMissingRuntimeDocumentError(runtimeDiscovery, capturedResources));
  }

  const html = decodeUtf8Body(runtimeDocument.body);
  const runtimeAssets = collectRuntimeAssets(capturedResources, runtimeDocument);
  runtimeDiscovery.summary = summarizeRuntimeCapture(
    capturedResources,
    runtimeDocument,
    runtimeAssets,
  );

  return {
    assetUrls: runtimeAssets.map((asset) => asset.finalUrl),
    assets: runtimeAssets,
    buildNumber: extractWebBuildNumber(html),
    channel,
    document: runtimeDocument,
    entryUrl,
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

async function collectDiscordWebRuntimeDiscovery(channel: ReleaseChannel): Promise<WebRuntimeDiscovery> {
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
    const session = await collectRuntimeCaptureSession(devtoolsBaseUrl, child);
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
): Promise<Pick<WebRuntimeDiscovery, "capture" | "selectedTarget" | "targets">> {
  const resources = new Map<string, DevtoolsCapturedResource>();
  const seenTargets = new Map<string, DevtoolsTargetInfo>();
  const attachedTargetIds = new Set<string>();
  let captureFinishedAt = new Date().toISOString();
  let captureStartedAt: string | null = null;
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

    if (!selectedTarget || isRemoteDiscordTarget(nextTarget)) {
      selectedTarget = nextTarget;
    }

    const capture = await captureDevtoolsNetwork(nextTarget.webSocketDebuggerUrl, {
      captureUntilClose: true,
      reloadOnAttach: false,
    });

    if (!captureStartedAt) {
      captureStartedAt = capture.startedAt;
    }

    captureFinishedAt = capture.finishedAt;

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

function collectRuntimeAssets(resources: DevtoolsCapturedResource[], document: WebCapturedDocument): WebCapturedAsset[] {
  const documentOrigin = new URL(document.finalUrl).origin;

  return resources
    .filter((resource) => isPromotableDiscordResource(resource, documentOrigin, document.finalUrl))
    .map((resource) => ({
      body: resource.body ?? undefined,
      contentType: resource.contentType,
      finalUrl: resource.finalUrl,
      headers: resource.headers,
      kind: classifyWebArtifact(resource.finalUrl, resource.contentType, resource.resourceType),
      path: createWebArtifactPath(resource.finalUrl),
      resourceType: resource.resourceType,
      sha256: hashBuffer(resource.body as Uint8Array),
      size: (resource.body as Uint8Array).length,
      status: resource.status as number,
      url: resource.url,
    }))
    .filter((asset) => asset.kind !== "web_unknown")
    .sort((left, right) => left.path.localeCompare(right.path));
}

function summarizeRuntimeCapture(
  resources: DevtoolsCapturedResource[],
  document: WebCapturedDocument,
  promotedAssets: WebCapturedAsset[],
): WebRuntimeSummary {
  const documentOrigin = new URL(document.finalUrl).origin;
  const contentTypeFamilies: Record<string, number> = {};
  const origins: Record<string, number> = {};
  const bodyStates: Record<string, number> = {};
  const resourceTypes: Record<string, number> = {};
  let capturedWithBodyCount = 0;
  let promotableResourceCount = 0;
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

    if (origin === documentOrigin) {
      sameOriginResourceCount += 1;

      if (resource.body) {
        sameOriginWithBodyCount += 1;
      }
    }

    if (isPromotableDiscordResource(resource, documentOrigin, document.finalUrl)) {
      promotableResourceCount += 1;
    }
  }

  return {
    bodyStates: sortCountMap(bodyStates),
    capturedResourceCount: resources.length,
    capturedWithBodyCount,
    contentTypeFamilies: sortCountMap(contentTypeFamilies),
    origins: sortCountMap(origins),
    promotableResourceCount,
    promotedAssetCount: promotedAssets.length,
    promotedKinds: sortCountMap(countAssetKinds(promotedAssets)),
    resourceTypes: sortCountMap(resourceTypes),
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

  if (extension === ".map") {
    return "web_source_map";
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
  return target.url.startsWith("https://discord.com") ||
    target.url.startsWith("https://ptb.discord.com") ||
    target.url.startsWith("https://canary.discord.com");
}

function hashBuffer(buffer: Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function sanitizePathComponent(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "_");
}

function isPromotableDiscordResource(
  resource: DevtoolsCapturedResource,
  documentOrigin: string,
  documentUrl: string,
): boolean {
  if (!resource.body || resource.status === null || resource.status < 200 || resource.status >= 400) {
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

  if (parsedUrl.origin !== documentOrigin) {
    return false;
  }

  if (parsedUrl.pathname.startsWith("/assets/")) {
    return true;
  }

  if (resource.resourceType === "Script" || resource.resourceType === "Stylesheet") {
    return true;
  }

  const extension = path.posix.extname(parsedUrl.pathname).toLowerCase();

  return extension === ".js" ||
    extension === ".mjs" ||
    extension === ".css" ||
    extension === ".map" ||
    extension === ".wasm" ||
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
