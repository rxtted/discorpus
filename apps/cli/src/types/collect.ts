import type { AsarArchiveSummary } from "@discorpus/asar";
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
  contentType: string | null;
  finalUrl: string;
  sha256: string;
  size: number;
  status: number;
  url: string;
}

export interface WebCapturedAsset {
  contentType: string | null;
  finalUrl: string;
  kind: string;
  path: string;
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
}
