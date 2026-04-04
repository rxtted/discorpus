import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createArtifactId, createSnapshotId, type ArtifactRecord, type SnapshotKey, type SnapshotRecord } from "@discorpus/core";

export interface BlobLocation {
  kind: "raw" | "derived" | "normalized";
  relativePath: string;
}

export interface BlobStore {
  createBlobPath(sha256: string): string;
}

export interface SnapshotStore {
  createSnapshotRecord(key: SnapshotKey, observedAt: string): SnapshotRecord;
  createArtifactRecord(input: Omit<ArtifactRecord, "id">): ArtifactRecord;
}

export interface SnapshotPaths {
  rootDir: string;
  desktopDir: string;
}

export class DiskBlobStore implements BlobStore {
  constructor(private readonly rootDir: string) {}

  createBlobPath(sha256: string): string {
    const prefix = sha256.slice(0, 2);
    return `${this.rootDir}/${prefix}/${sha256}`;
  }
}

export class InMemorySnapshotStore implements SnapshotStore {
  createSnapshotRecord(key: SnapshotKey, observedAt: string): SnapshotRecord {
    return {
      ...key,
      id: createSnapshotId(key, observedAt),
      observedAt,
      release: {},
    };
  }

  createArtifactRecord(input: Omit<ArtifactRecord, "id">): ArtifactRecord {
    return {
      ...input,
      id: createArtifactId(input.snapshotId, input.path, input.sha256),
    };
  }
}

export async function createSnapshotPaths(baseDir: string, snapshotId: string): Promise<SnapshotPaths> {
  const rootDir = path.join(baseDir, snapshotId);
  const desktopDir = path.join(rootDir, "desktop");

  await mkdir(desktopDir, { recursive: true });

  return {
    rootDir,
    desktopDir,
  };
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
