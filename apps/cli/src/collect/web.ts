import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ReleaseChannel, VersionSignal } from "@discorpus/core";
import {
  captureDevtoolsNetwork,
  listDevtoolsTargets,
  pickPreferredDevtoolsTarget,
  waitForDevtoolsVersion,
  type DevtoolsCapturedResource,
} from "@discorpus/runtime-cdp";
import { createWindowsDesktopLaunchPlan, discoverWindowsDesktopInstall, launchWindowsDesktopClient } from "@discorpus/platform-windows";
import type { DiskBlobStore, InMemorySnapshotStore } from "@discorpus/storage";

import type { CliArtifactRecord, WebCaptureManifest, WebCapturedAsset, WebCapturedDocument, WebRuntimeDiscovery } from "../types/collect.js";

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
  const runtimeDocument = selectRuntimeDocument(runtimeDiscovery.capture?.resources ?? [], entryUrl);

  if (!runtimeDocument) {
    const fallbackDocument = await fetchWebDocument(entryUrl);
    const fallbackHtml = decodeUtf8Body(fallbackDocument.body);
    const fallbackAssetUrls = discoverWebAssetUrls(fallbackHtml, fallbackDocument.finalUrl);
    const fallbackAssets = await Promise.all(fallbackAssetUrls.map(fetchWebAsset));

    return {
      assetUrls: fallbackAssetUrls,
      assets: fallbackAssets,
      buildNumber: extractWebBuildNumber(fallbackHtml),
      channel,
      document: fallbackDocument,
      entryUrl,
      runtimeDiscovery,
    };
  }

  const html = decodeUtf8Body(runtimeDocument.body);
  const runtimeAssets = collectRuntimeAssets(runtimeDiscovery.capture?.resources ?? [], runtimeDocument);
  const fallbackAssetUrls = discoverWebAssetUrls(html, runtimeDocument.finalUrl);
  const mergedAssets = mergeRuntimeAndFallbackAssets(runtimeAssets, fallbackAssetUrls);

  return {
    assetUrls: mergedAssets.map((asset) => asset.finalUrl),
    assets: mergedAssets,
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

async function fetchWebDocument(url: string): Promise<WebCapturedDocument> {
  const response = await fetch(url, { headers: WEB_FETCH_HEADERS, redirect: "follow" });
  const body = new Uint8Array(await response.arrayBuffer());

  if (!response.ok) {
    throw new Error(`web document request failed: ${response.status} ${response.url}`);
  }

  return {
    body,
    contentType: response.headers.get("content-type"),
    finalUrl: response.url,
    headers: Object.fromEntries(response.headers.entries()),
    resourceType: "Document",
    sha256: hashBuffer(body),
    size: body.length,
    status: response.status,
    url,
  };
}

async function fetchWebAsset(url: string): Promise<WebCapturedAsset> {
  const response = await fetch(url, { headers: WEB_FETCH_HEADERS, redirect: "follow" });
  const body = new Uint8Array(await response.arrayBuffer());

  if (!response.ok) {
    throw new Error(`web asset request failed: ${response.status} ${response.url}`);
  }

  return {
    body,
    contentType: response.headers.get("content-type"),
    finalUrl: response.url,
    headers: Object.fromEntries(response.headers.entries()),
    kind: classifyWebArtifact(response.url, response.headers.get("content-type"), "Other"),
    path: createWebArtifactPath(response.url),
    resourceType: "Other",
    sha256: hashBuffer(body),
    size: body.length,
    status: response.status,
    url,
  };
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
  const tempUserDataDir = await mkdtemp(path.join(os.tmpdir(), "discorpus-runtime-"));
  const launchOptions = {
    remoteDebuggingPort,
    startMinimized: false,
    useUpdater: false,
    userDataDir: tempUserDataDir,
  };
  const launchPlan = createWindowsDesktopLaunchPlan(install, launchOptions);
  const child = launchWindowsDesktopClient(install, launchOptions);
  const devtoolsBaseUrl = `http://127.0.0.1:${remoteDebuggingPort}`;

  try {
    const version = await waitForDevtoolsVersion(devtoolsBaseUrl, { timeoutMs: 15000 });
    const targets = await waitForDiscordTargets(devtoolsBaseUrl);
    const selectedTarget = pickPreferredDevtoolsTarget(targets);
    const capture = selectedTarget?.webSocketDebuggerUrl
      ? await captureDevtoolsNetwork(selectedTarget.webSocketDebuggerUrl, {
          overallTimeoutMs: 15000,
          quietPeriodMs: 3000,
          reloadOnAttach: true,
        })
      : null;

    return {
      capture,
      devtoolsBaseUrl,
      launchPlan,
      selectedTarget,
      targetCount: targets.length,
      targets,
      version,
    };
  } finally {
    child.kill();
    await rm(tempUserDataDir, { force: true, recursive: true });
  }
}

async function waitForDiscordTargets(baseUrl: string): Promise<ReturnType<typeof listDevtoolsTargets> extends Promise<infer T> ? T : never> {
  const startedAt = Date.now();
  let lastTargets = await listDevtoolsTargets(baseUrl);

  while (Date.now() - startedAt < 15000) {
    const preferredTarget = pickPreferredDevtoolsTarget(lastTargets);

    if (preferredTarget?.webSocketDebuggerUrl) {
      return lastTargets;
    }

    await sleep(250);
    lastTargets = await listDevtoolsTargets(baseUrl);
  }

  return lastTargets;
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
  return resources
    .filter((resource) => resource.body && resource.finalUrl !== document.finalUrl && resource.status !== null)
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

function mergeRuntimeAndFallbackAssets(runtimeAssets: WebCapturedAsset[], fallbackAssetUrls: string[]): WebCapturedAsset[] {
  const assetsByUrl = new Map(runtimeAssets.map((asset) => [asset.finalUrl, asset]));

  for (const assetUrl of fallbackAssetUrls) {
    if (assetsByUrl.has(assetUrl)) {
      continue;
    }

    assetsByUrl.set(assetUrl, {
      contentType: null,
      finalUrl: assetUrl,
      kind: classifyWebArtifact(assetUrl, null, "Other"),
      path: createWebArtifactPath(assetUrl),
      resourceType: "Other",
      sha256: "",
      size: 0,
      status: 0,
      url: assetUrl,
    });
  }

  return [...assetsByUrl.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function classifyWebArtifact(url: string, contentType: string | null, resourceType: string): string {
  const extension = path.posix.extname(new URL(url).pathname).toLowerCase();
  const normalizedContentType = contentType?.split(";")[0].trim().toLowerCase() ?? "";

  if (resourceType === "Document") {
    return "web_document";
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

  if (extension === ".map") {
    return "web_source_map";
  }

  if (normalizedContentType.startsWith("image/") || normalizedContentType.startsWith("font/") || extension === ".ico") {
    return "web_asset";
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

function hashBuffer(buffer: Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function sanitizePathComponent(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "_");
}

function decodeUtf8Body(body: Uint8Array | undefined): string {
  if (!body) {
    return "";
  }

  return Buffer.from(body).toString("utf8");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
