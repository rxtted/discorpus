import { formatSnapshotKey, type CorpusVersionRecord, type SnapshotKey, type UpstreamVersionRecord, type VersionDecision, type VersionSignal } from "@discorpus/core";

export interface VersionInput {
  key: SnapshotKey;
  signals: VersionSignal[];
  normalizedFingerprint: string;
  observedAt: string;
}

export function createUpstreamFingerprint(signals: VersionSignal[]): string {
  return signals
    .map((signal) => `${signal.scope}:${signal.name}:${signal.value}:${signal.confidence}`)
    .sort()
    .join("|");
}

export function createUpstreamVersionRecord(input: VersionInput): UpstreamVersionRecord {
  const fingerprint = createUpstreamFingerprint(input.signals);
  const scope = formatSnapshotKey(input.key);

  return {
    ...input.key,
    id: `${scope}:upstream:${fingerprint}`,
    fingerprint,
    signals: input.signals,
    createdAt: input.observedAt,
  };
}

export function createCorpusVersionRecord(
  upstreamVersion: UpstreamVersionRecord,
  normalizedFingerprint: string,
  createdAt: string,
): CorpusVersionRecord {
  const scope = formatSnapshotKey(upstreamVersion);

  return {
    target: upstreamVersion.target,
    channel: upstreamVersion.channel,
    platform: upstreamVersion.platform,
    layer: upstreamVersion.layer,
    id: `${scope}:corpus:${normalizedFingerprint}`,
    upstreamVersionId: upstreamVersion.id,
    normalizedFingerprint,
    createdAt,
  };
}

export function decideVersion(input: VersionInput): VersionDecision {
  const upstreamVersion = createUpstreamVersionRecord(input);
  const corpusVersion = createCorpusVersionRecord(upstreamVersion, input.normalizedFingerprint, input.observedAt);

  return {
    upstreamVersionId: upstreamVersion.id,
    corpusVersionId: corpusVersion.id,
    isNewUpstreamVersion: true,
    isNewCorpusVersion: true,
  };
}

export function createVersionSet(input: VersionInput): {
  corpusVersion: CorpusVersionRecord;
  decision: VersionDecision;
  upstreamVersion: UpstreamVersionRecord;
} {
  const upstreamVersion = createUpstreamVersionRecord(input);
  const corpusVersion = createCorpusVersionRecord(upstreamVersion, input.normalizedFingerprint, input.observedAt);

  return {
    upstreamVersion,
    corpusVersion,
    decision: {
      upstreamVersionId: upstreamVersion.id,
      corpusVersionId: corpusVersion.id,
      isNewUpstreamVersion: true,
      isNewCorpusVersion: true,
    },
  };
}
