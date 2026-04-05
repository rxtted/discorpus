import os from "node:os";
import path from "node:path";

import type { CorpusLayer, ReleaseChannel, VersionSignal } from "@discorpus/core";
import { isDiscordChannel } from "@discorpus/targets-discord";

export type CollectLayer = Extract<CorpusLayer, "desktop" | "web">;

export function parseLayer(value: string | undefined): CollectLayer | null {
  if (value === "desktop" || value === "web") {
    return value;
  }

  return null;
}

export function parseLayerFromOption(args: string[]): CollectLayer | null {
  const index = args.findIndex((value) => value === "--layer");

  if (index === -1) {
    return null;
  }

  return parseLayer(args[index + 1]);
}

export function parseChannel(args: string[]): ReleaseChannel | null {
  const index = args.findIndex((value) => value === "--channel");

  if (index === -1) {
    return null;
  }

  const value = args[index + 1];

  if (!value || !isDiscordChannel(value)) {
    return null;
  }

  return value;
}

export function parseOption(args: string[], name: string): string | undefined {
  const index = args.findIndex((value) => value === name);

  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}

export function printUsage(): void {
  console.error("usage: discorpus collect <desktop|web> --channel <stable|ptb|canary>");
  console.error("usage: discorpus snapshots [--layer <desktop|web>]");
  console.error("usage: discorpus snapshot <snapshot-id>");
  console.error("usage: discorpus snapshot latest --channel <stable|ptb|canary> --layer <desktop|web>");
  console.error("usage: discorpus entries <snapshot-id>");
  console.error("usage: discorpus entries latest --channel <stable|ptb|canary> --layer <desktop|web>");
  console.error("usage: discorpus archive <snapshot-id> <archive-name>");
  console.error("usage: discorpus archive latest <archive-name> --channel <stable|ptb|canary> --layer <desktop|web>");
  console.error("usage: discorpus find artifact [--sha256 <hash>] [--kind <kind>] [--path <path-fragment>]");
  console.error("usage: discorpus diff latest --channel <stable|ptb|canary> --layer <desktop|web>");
  console.error("optional: add --json for structured output");
}

export function formatArtifactCounts(counts: Map<string, number>): string {
  return [...counts.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([kind, count]) => `${kind}=${count}`)
    .join(", ");
}

export function formatArtifactCountRows(rows: { count: number; kind: string }[]): string {
  return rows
    .map((row) => `${row.kind}=${row.count}`)
    .join(", ");
}

export function formatUpstreamSummary(
  appVersion: string | null | undefined,
  releaseId: string | null | undefined,
  signals: VersionSignal[],
): string {
  const parts = [releaseId ?? "unknown", appVersion ?? "unknown"];
  const signalCount = signals.length > 0 ? `signals=${signals.length}` : null;

  return [parts.join(" "), signalCount].filter(Boolean).join(", ");
}

export function formatCorpusSummary(corpusVersionId: string): string {
  const suffix = corpusVersionId.split(":").at(-1) ?? corpusVersionId;
  return suffix === "pending" ? "pending" : suffix;
}

export function toArtifactCountObject(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...counts.entries()].sort((left, right) => left[0].localeCompare(right[0])));
}

export function toArtifactCountObjectFromRows(rows: { count: number; kind: string }[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.kind, row.count]));
}

export function formatFindFilters(filters: { kind?: string; pathFragment?: string; sha256?: string }): string {
  const parts = [
    filters.sha256 ? ` --sha256 ${filters.sha256}` : "",
    filters.kind ? ` --kind ${filters.kind}` : "",
    filters.pathFragment ? ` --path ${filters.pathFragment}` : "",
  ];

  return parts.join("");
}

export function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

export function countKinds<T extends { kind: string }>(items: T[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const item of items) {
    counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  }

  return counts;
}

export function getCorpusDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DISCORPUS_DATA_DIR;

  if (override) {
    return path.resolve(override);
  }

  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA;

    if (localAppData) {
      return path.join(localAppData, "discorpus");
    }
  }

  const xdgStateHome = env.XDG_STATE_HOME;

  if (xdgStateHome) {
    return path.join(xdgStateHome, "discorpus");
  }

  return path.join(os.homedir(), ".discorpus");
}
