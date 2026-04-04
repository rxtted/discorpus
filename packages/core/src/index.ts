export type CorpusLayer = "desktop" | "web" | "unknown";

export type ReleaseChannel = "stable" | "ptb" | "canary";

export type TargetPlatform = "windows";

export interface ReleaseIdentity {
  appVersion?: string;
  buildId?: string;
  releaseId?: string;
}

export interface SnapshotKey {
  target: string;
  channel: ReleaseChannel;
  platform: TargetPlatform;
  layer: CorpusLayer;
}

export interface SnapshotRecord extends SnapshotKey {
  id: string;
  observedAt: string;
  release: ReleaseIdentity;
}

export interface ArtifactRecord {
  id: string;
  snapshotId: string;
  kind: string;
  path: string;
  sha256: string;
  size: number;
  source: string;
}

export interface VersionSignal {
  scope: "desktop" | "web";
  name: string;
  value: string;
  confidence: "low" | "medium" | "high";
}

export interface UpstreamVersionRecord extends SnapshotKey {
  id: string;
  fingerprint: string;
  signals: VersionSignal[];
  createdAt: string;
}

export interface CorpusVersionRecord extends SnapshotKey {
  id: string;
  upstreamVersionId: string;
  normalizedFingerprint: string;
  createdAt: string;
}

export interface VersionDecision {
  upstreamVersionId: string;
  corpusVersionId: string;
  isNewUpstreamVersion: boolean;
  isNewCorpusVersion: boolean;
}

export function formatSnapshotKey(key: SnapshotKey): string {
  return [key.target, key.channel, key.platform, key.layer].join(":");
}

export function createSnapshotId(key: SnapshotKey, observedAt: string): string {
  return `${formatSnapshotKey(key)}:${observedAt}`;
}

export function createArtifactId(snapshotId: string, path: string, sha256: string): string {
  return `${snapshotId}:${path}:${sha256}`;
}
