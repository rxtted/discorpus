import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ArtifactRecord, CorpusVersionRecord, SnapshotRecord, UpstreamVersionRecord, VersionDecision } from "@discorpus/core";
import { createSnapshotDirName } from "@discorpus/storage";

export interface DbPaths {
  databasePath: string;
}

export interface IndexedVersionSet {
  corpusVersion: CorpusVersionRecord;
  decision: VersionDecision;
  upstreamVersion: UpstreamVersionRecord;
}

export interface LatestSnapshotRow {
  app_version: string | null;
  channel: string;
  corpus_version_id: string;
  id: string;
  is_new_corpus_version: number;
  is_new_upstream_version: number;
  layer: string;
  observed_at: string;
  platform: string;
  release_id: string | null;
  target: string;
  upstream_version_id: string;
}

export interface ArtifactKindCountRow {
  count: number;
  kind: string;
}

export interface SnapshotLookupRow extends LatestSnapshotRow {}

export interface SnapshotListRow extends LatestSnapshotRow {}

export interface ArtifactSearchFilters {
  kind?: string;
  pathFragment?: string;
  sha256?: string;
}

export interface ArtifactSearchRow {
  blob_kind: string | null;
  blob_path: string | null;
  channel: string;
  kind: string;
  layer: string;
  observed_at: string;
  path: string;
  platform: string;
  sha256: string;
  size: number;
  snapshot_id: string;
  source: string;
  target: string;
}

export interface ArtifactRow {
  blob_kind: string | null;
  blob_path: string | null;
  id: string;
  kind: string;
  path: string;
  sha256: string;
  size: number;
  snapshot_id: string;
  source: string;
}

export async function ensureCorpusDatabase(baseDir: string): Promise<DbPaths> {
  await mkdir(baseDir, { recursive: true });

  const databasePath = path.join(baseDir, "discorpus.sqlite");
  const database = new DatabaseSync(databasePath);

  try {
    initializeSchema(database);
  } finally {
    database.close();
  }

  return { databasePath };
}

export function indexSnapshot(
  databasePath: string,
  snapshot: SnapshotRecord,
  versions: IndexedVersionSet,
  artifacts: ArtifactRecord[],
): void {
  const database = new DatabaseSync(databasePath);

  try {
    database.exec("begin");

    upsertUpstreamVersion(database, versions.upstreamVersion);
    upsertCorpusVersion(database, versions.corpusVersion);
    upsertSnapshot(database, snapshot, versions.decision);
    upsertArtifacts(database, artifacts);

    database.exec("commit");
  } catch (error) {
    database.exec("rollback");
    throw error;
  } finally {
    database.close();
  }
}

export function getLatestSnapshot(
  databasePath: string,
  channel: string,
  layer: string,
): LatestSnapshotRow | null {
  const database = new DatabaseSync(databasePath);

  try {
    const row = database.prepare(`
      select
        id,
        target,
        channel,
        platform,
        layer,
        observed_at,
        app_version,
        release_id,
        upstream_version_id,
        corpus_version_id,
        is_new_upstream_version,
        is_new_corpus_version
      from snapshots
      where channel = ? and layer = ?
      order by observed_at desc
      limit 1
    `).get(channel, layer);

    return ((row as unknown) as LatestSnapshotRow | undefined) ?? null;
  } finally {
    database.close();
  }
}

export function getPreviousSnapshot(
  databasePath: string,
  channel: string,
  layer: string,
  observedAt: string,
): LatestSnapshotRow | null {
  const database = new DatabaseSync(databasePath);

  try {
    const row = database.prepare(`
      select
        id,
        target,
        channel,
        platform,
        layer,
        observed_at,
        app_version,
        release_id,
        upstream_version_id,
        corpus_version_id,
        is_new_upstream_version,
        is_new_corpus_version
      from snapshots
      where channel = ? and layer = ? and observed_at < ?
      order by observed_at desc
      limit 1
    `).get(channel, layer, observedAt);

    return ((row as unknown) as LatestSnapshotRow | undefined) ?? null;
  } finally {
    database.close();
  }
}

export function getArtifactKindCounts(
  databasePath: string,
  snapshotId: string,
): ArtifactKindCountRow[] {
  const database = new DatabaseSync(databasePath);

  try {
    const rows = database.prepare(`
      select kind, count(*) as count
      from artifacts
      where snapshot_id = ?
      group by kind
      order by kind asc
    `).all(snapshotId);

    return (rows as unknown) as ArtifactKindCountRow[];
  } finally {
    database.close();
  }
}

export function getArtifactsBySnapshotId(
  databasePath: string,
  snapshotId: string,
): ArtifactRow[] {
  const database = new DatabaseSync(databasePath);

  try {
    const rows = database.prepare(`
      select
        id,
        snapshot_id,
        kind,
        path,
        sha256,
        size,
        source,
        blob_kind,
        blob_path
      from artifacts
      where snapshot_id = ?
      order by path asc
    `).all(snapshotId);

    return (rows as unknown) as ArtifactRow[];
  } finally {
    database.close();
  }
}

export function getSnapshotById(
  databasePath: string,
  snapshotId: string,
): SnapshotLookupRow | null {
  const database = new DatabaseSync(databasePath);

  try {
    const row = database.prepare(`
      select
        id,
        target,
        channel,
        platform,
        layer,
        observed_at,
        app_version,
        release_id,
        upstream_version_id,
        corpus_version_id,
        is_new_upstream_version,
        is_new_corpus_version
      from snapshots
      where id = ?
      limit 1
    `).get(snapshotId);

    return ((row as unknown) as SnapshotLookupRow | undefined) ?? null;
  } finally {
    database.close();
  }
}

export function getSnapshotByIdOrDirName(
  databasePath: string,
  value: string,
): SnapshotLookupRow | null {
  const byId = getSnapshotById(databasePath, value);

  if (byId) {
    return byId;
  }

  const database = new DatabaseSync(databasePath);

  try {
    const rows = database.prepare(`
      select
        id,
        target,
        channel,
        platform,
        layer,
        observed_at,
        app_version,
        release_id,
        upstream_version_id,
        corpus_version_id,
        is_new_upstream_version,
        is_new_corpus_version
      from snapshots
      order by observed_at desc
    `).all();

    for (const row of rows as unknown as SnapshotLookupRow[]) {
      if (createSnapshotDirName(row.id) === value) {
        return row;
      }
    }

    return null;
  } finally {
    database.close();
  }
}

export function listSnapshots(
  databasePath: string,
  layer?: string,
): SnapshotListRow[] {
  const database = new DatabaseSync(databasePath);

  try {
    const rows = layer
      ? database.prepare(`
        select
          id,
          target,
          channel,
          platform,
          layer,
          observed_at,
          app_version,
          release_id,
          upstream_version_id,
          corpus_version_id,
          is_new_upstream_version,
          is_new_corpus_version
        from snapshots
        where layer = ?
        order by
          case channel
            when 'stable' then 1
            when 'ptb' then 2
            when 'canary' then 3
            else 4
          end asc,
          observed_at desc
      `).all(layer)
      : database.prepare(`
        select
          id,
          target,
          channel,
          platform,
          layer,
          observed_at,
          app_version,
          release_id,
          upstream_version_id,
          corpus_version_id,
          is_new_upstream_version,
          is_new_corpus_version
        from snapshots
        order by
          case channel
            when 'stable' then 1
            when 'ptb' then 2
            when 'canary' then 3
            else 4
          end asc,
          observed_at desc
      `).all();

    return (rows as unknown) as SnapshotListRow[];
  } finally {
    database.close();
  }
}

export function findArtifacts(
  databasePath: string,
  filters: ArtifactSearchFilters,
  limit = 50,
): ArtifactSearchRow[] {
  const database = new DatabaseSync(databasePath);

  try {
    const whereParts: string[] = [];
    const values: Array<string | number> = [];

    if (filters.sha256) {
      whereParts.push("artifacts.sha256 = ?");
      values.push(filters.sha256);
    }

    if (filters.kind) {
      whereParts.push("artifacts.kind = ?");
      values.push(filters.kind);
    }

    if (filters.pathFragment) {
      whereParts.push("artifacts.path like ?");
      values.push(`%${filters.pathFragment}%`);
    }

    if (whereParts.length === 0) {
      return [];
    }

    values.push(limit);

    const rows = database.prepare(`
      select
        artifacts.snapshot_id,
        artifacts.kind,
        artifacts.path,
        artifacts.sha256,
        artifacts.size,
        artifacts.source,
        artifacts.blob_kind,
        artifacts.blob_path,
        snapshots.target,
        snapshots.channel,
        snapshots.platform,
        snapshots.layer,
        snapshots.observed_at
      from artifacts
      inner join snapshots on snapshots.id = artifacts.snapshot_id
      where ${whereParts.join(" and ")}
      order by snapshots.observed_at desc, artifacts.path asc
      limit ?
    `).all(...values);

    return (rows as unknown) as ArtifactSearchRow[];
  } finally {
    database.close();
  }
}

function initializeSchema(database: DatabaseSync): void {
  database.exec(`
    create table if not exists upstream_versions (
      id text primary key,
      target text not null,
      channel text not null,
      platform text not null,
      layer text not null,
      fingerprint text not null,
      signals_json text not null,
      created_at text not null
    );

    create table if not exists corpus_versions (
      id text primary key,
      upstream_version_id text not null,
      target text not null,
      channel text not null,
      platform text not null,
      layer text not null,
      normalized_fingerprint text not null,
      created_at text not null,
      foreign key (upstream_version_id) references upstream_versions(id)
    );

    create table if not exists snapshots (
      id text primary key,
      target text not null,
      channel text not null,
      platform text not null,
      layer text not null,
      observed_at text not null,
      app_version text,
      build_id text,
      release_id text,
      upstream_version_id text not null,
      corpus_version_id text not null,
      is_new_upstream_version integer not null,
      is_new_corpus_version integer not null,
      foreign key (upstream_version_id) references upstream_versions(id),
      foreign key (corpus_version_id) references corpus_versions(id)
    );

    create table if not exists artifacts (
      id text primary key,
      snapshot_id text not null,
      kind text not null,
      path text not null,
      sha256 text not null,
      size integer not null,
      source text not null,
      blob_kind text,
      blob_path text,
      foreign key (snapshot_id) references snapshots(id)
    );

    create index if not exists idx_snapshots_scope on snapshots(channel, platform, layer, observed_at);
    create index if not exists idx_artifacts_snapshot on artifacts(snapshot_id);
    create index if not exists idx_artifacts_hash on artifacts(sha256);
    create index if not exists idx_artifacts_kind on artifacts(kind);
  `);
}

function upsertUpstreamVersion(database: DatabaseSync, version: UpstreamVersionRecord): void {
  database.prepare(`
    insert or replace into upstream_versions (
      id, target, channel, platform, layer, fingerprint, signals_json, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    version.id,
    version.target,
    version.channel,
    version.platform,
    version.layer,
    version.fingerprint,
    JSON.stringify(version.signals),
    version.createdAt,
  );
}

function upsertCorpusVersion(database: DatabaseSync, version: CorpusVersionRecord): void {
  database.prepare(`
    insert or replace into corpus_versions (
      id, upstream_version_id, target, channel, platform, layer, normalized_fingerprint, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    version.id,
    version.upstreamVersionId,
    version.target,
    version.channel,
    version.platform,
    version.layer,
    version.normalizedFingerprint,
    version.createdAt,
  );
}

function upsertSnapshot(database: DatabaseSync, snapshot: SnapshotRecord, decision: VersionDecision): void {
  database.prepare(`
    insert or replace into snapshots (
      id, target, channel, platform, layer, observed_at, app_version, build_id, release_id,
      upstream_version_id, corpus_version_id, is_new_upstream_version, is_new_corpus_version
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    snapshot.id,
    snapshot.target,
    snapshot.channel,
    snapshot.platform,
    snapshot.layer,
    snapshot.observedAt,
    snapshot.release.appVersion ?? null,
    snapshot.release.buildId ?? null,
    snapshot.release.releaseId ?? null,
    decision.upstreamVersionId,
    decision.corpusVersionId,
    decision.isNewUpstreamVersion ? 1 : 0,
    decision.isNewCorpusVersion ? 1 : 0,
  );
}

function upsertArtifacts(database: DatabaseSync, artifacts: ArtifactRecord[]): void {
  const statement = database.prepare(`
    insert or replace into artifacts (
      id, snapshot_id, kind, path, sha256, size, source, blob_kind, blob_path
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const artifact of artifacts) {
    statement.run(
      artifact.id,
      artifact.snapshotId,
      artifact.kind,
      artifact.path,
      artifact.sha256,
      artifact.size,
      artifact.source,
      artifact.blob?.kind ?? null,
      artifact.blob?.relativePath ?? null,
    );
  }
}
