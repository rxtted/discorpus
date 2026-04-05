import type { ArtifactRow } from "@discorpus/db";

export type SnapshotArtifact = Pick<ArtifactRow, "blob_path" | "kind" | "path" | "sha256" | "size" | "snapshot_id">;

export interface ArchiveEntry {
  kind: string;
  name: string;
  path: string;
  sha256: string;
  size: number;
}

export interface InspectableEntry {
  kind: string;
  path: string;
}

export interface ArtifactDiffChange {
  current: SnapshotArtifact;
  previous: SnapshotArtifact;
}

export interface ArtifactDiff {
  added: SnapshotArtifact[];
  changed: ArtifactDiffChange[];
  removed: SnapshotArtifact[];
}
