import type { AsarArchiveSummary } from "@discorpus/asar";
import type { DevtoolsNetworkCapture, DevtoolsTargetInfo, DevtoolsVersionInfo } from "@discorpus/runtime-cdp";
import type { WindowsDesktopLaunchPlan } from "@discorpus/platform-windows";
import { InMemorySnapshotStore } from "@discorpus/storage";
import type { ReleaseChannel } from "@discorpus/core";
import type { createVersionSet } from "@discorpus/versioning";

export type CliSnapshotRecord = ReturnType<InMemorySnapshotStore["createSnapshotRecord"]>;
export type CliArtifactRecord = ReturnType<InMemorySnapshotStore["createArtifactRecord"]>;
export type CliVersionSet = ReturnType<typeof createVersionSet>;

export interface DesktopAsarArchiveRecord extends AsarArchiveSummary {
  extractedFileCount: number;
  kind: string;
  relativePath: string;
  sourcePath: string;
}

export interface DesktopAsarExtraction {
  archives: DesktopAsarArchiveRecord[];
  extractedFileCount: number;
  unpackedFileCount: number;
}

export interface DesktopAsarExtractionResult extends DesktopAsarExtraction {
  records: CliArtifactRecord[];
}

export interface WebCapturedDocument {
  body?: Uint8Array;
  contentType: string | null;
  finalUrl: string;
  headers?: Record<string, unknown>;
  resourceType?: string;
  sha256: string;
  size: number;
  status: number;
  url: string;
}

export interface WebCapturedAsset {
  body?: Uint8Array;
  contentType: string | null;
  finalUrl: string;
  headers?: Record<string, unknown>;
  kind: string;
  path: string;
  resourceType?: string;
  sha256: string;
  size: number;
  status: number;
  url: string;
}

export interface WebCaptureManifest {
  assetUrls: string[];
  assets: WebCapturedAsset[];
  buildNumber: string | null;
  channel: ReleaseChannel;
  document: WebCapturedDocument;
  entryUrl: string;
  missedAssets: WebMissedAsset[];
  runtimeDiscovery: WebRuntimeDiscovery | null;
}

export interface WebMissedAsset {
  bodyError: string | null;
  bodyState: string;
  contentType: string | null;
  finalUrl: string;
  path: string;
  reason: string;
  resourceType: string;
  status: number | null;
}

export interface WebRuntimeSummary {
  bodyStates: Record<string, number>;
  capturedResourceCount: number;
  capturedWithBodyCount: number;
  missedAssetCount: number;
  contentTypeFamilies: Record<string, number>;
  origins: Record<string, number>;
  promotableResourceCount: number;
  promotedAssetCount: number;
  promotedKinds: Record<string, number>;
  resourceTypes: Record<string, number>;
  sameOriginResourceCount: number;
  sameOriginWithBodyCount: number;
}

export interface WebRuntimeDiscovery {
  devtoolsBaseUrl: string;
  launchPlan: WindowsDesktopLaunchPlan;
  selectedTarget: DevtoolsTargetInfo | null;
  summary: WebRuntimeSummary | null;
  targetCount: number;
  targets: DevtoolsTargetInfo[];
  version: DevtoolsVersionInfo;
  capture: DevtoolsNetworkCapture | null;
}
