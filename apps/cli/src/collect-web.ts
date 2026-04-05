import { createHash } from "node:crypto";
import path from "node:path";

import type { ReleaseChannel, VersionSignal } from "@discorpus/core";
import type { DiskBlobStore, InMemorySnapshotStore } from "@discorpus/storage";

import type { CliArtifactRecord, WebCaptureManifest, WebCapturedAsset, WebCapturedDocument } from "./collect-types.js";

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

export async function createWebArtifactRecords(
  snapshotId: string,
  snapshotStore: InMemorySnapshotStore,
  blobStore: DiskBlobStore,
  manifest: WebCaptureManifest,
): Promise<CliArtifactRecord[]> {
  const documentBuffer = await fetchBuffer(manifest.document.finalUrl);
  const documentBlob = await blobStore.persistBuffer(documentBuffer, manifest.document.sha256, "raw");
  const records: CliArtifactRecord[] = [
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

async function fetchWebDocument(url: string): Promise<WebCapturedDocument> {
  const response = await fetch(url, { headers: WEB_FETCH_HEADERS, redirect: "follow" });
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
  const response = await fetch(url, { headers: WEB_FETCH_HEADERS, redirect: "follow" });
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

async function fetchBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url, { headers: WEB_FETCH_HEADERS, redirect: "follow" });

  if (!response.ok) {
    throw new Error(`request failed: ${response.status} ${response.url}`);
  }

  return Buffer.from(await response.arrayBuffer());
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
