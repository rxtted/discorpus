import { access, copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createArtifactId, createSnapshotId, type ArtifactRecord, type BlobLocation, type SnapshotKey, type SnapshotRecord } from "@discorpus/core";

export interface BlobStore {
  createBlobPath(sha256: string): string;
  createBlobLocation(sha256: string, kind?: BlobLocation["kind"]): BlobLocation;
  persistFile(filePath: string, sha256: string, kind?: BlobLocation["kind"]): Promise<BlobLocation>;
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
    return path.join(this.rootDir, prefix, sha256);
  }

  createBlobLocation(sha256: string, kind: BlobLocation["kind"] = "raw"): BlobLocation {
    const prefix = sha256.slice(0, 2);

    return {
      kind,
      relativePath: path.join(prefix, sha256),
    };
  }

  async persistFile(filePath: string, sha256: string, kind: BlobLocation["kind"] = "raw"): Promise<BlobLocation> {
    const blobPath = this.createBlobPath(sha256);
    const blobLocation = this.createBlobLocation(sha256, kind);

    await mkdir(path.dirname(blobPath), { recursive: true });

    if (!(await pathExists(blobPath))) {
      await copyFile(filePath, blobPath);
    }

    return blobLocation;
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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
