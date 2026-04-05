import { createHash } from "node:crypto";
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
  dirName: string;
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
  const dirName = createSnapshotDirName(snapshotId);
  const rootDir = path.join(baseDir, dirName);
  const desktopDir = path.join(rootDir, "desktop");

  await mkdir(desktopDir, { recursive: true });

  return {
    dirName,
    rootDir,
    desktopDir,
  };
}

export function createSnapshotDirName(snapshotId: string): string {
  return buildSnapshotDirName(snapshotId);
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

function toSafePathSegment(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
}

function buildSnapshotDirName(snapshotId: string): string {
  const parts = snapshotId.split(":");
  const target = parts[0] ?? "snapshot";
  const channel = parts[1] ?? "unknown";
  const platform = parts[2] ?? "unknown";
  const layer = parts[3] ?? "unknown";
  const observedAt = extractObservedAt(snapshotId);
  const datePart = observedAt
    ? observedAt.slice(0, 10).replace(/-/g, "")
    : "unknown";
  const timePart = observedAt
    ? observedAt.slice(11, 19).replace(/:/g, "")
    : "unknown";
  const hash = createHash("sha256").update(snapshotId).digest("hex").slice(0, 8);
  const scope = `${toCode(target)}${toCode(channel)}${toCode(platform)}${toCode(layer)}`;

  return toSafePathSegment(`${scope}-${datePart}-${timePart}-${hash}`);
}

function extractObservedAt(snapshotId: string): string | null {
  const match = snapshotId.match(/\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}\.\d{3}z$/i);
  return match?.[0] ?? null;
}

function toCode(value: string): string {
  return value.charAt(0).toLowerCase() || "x";
}
