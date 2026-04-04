import { formatSnapshotKey, type CorpusLayer, type ReleaseChannel } from "@discorpus/core";
import { InMemorySnapshotStore } from "@discorpus/storage";
import { createDiscordSnapshotKey, discordPlatforms, isDiscordChannel } from "@discorpus/targets-discord";
import { decideVersion } from "@discorpus/versioning";

type CollectLayer = Extract<CorpusLayer, "desktop" | "web">;

function main(): void {
  const args = process.argv.slice(2);

  if (args[0] !== "collect") {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const layer = parseLayer(args[1]);
  const channel = parseChannel(args.slice(2));

  if (!layer || !channel) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  runCollect(layer, channel);
}

function runCollect(layer: CollectLayer, channel: ReleaseChannel): void {
  const observedAt = new Date().toISOString();
  const snapshotKey = createDiscordSnapshotKey(channel, discordPlatforms[0], layer);
  const snapshotStore = new InMemorySnapshotStore();
  const snapshot = snapshotStore.createSnapshotRecord(snapshotKey, observedAt);
  const version = decideVersion({
    key: snapshotKey,
    observedAt,
    normalizedFingerprint: "pending",
    signals: [
      {
        scope: layer,
        name: "collection_stub",
        value: channel,
        confidence: "medium",
      },
    ],
  });

  console.log("discorpus");
  console.log(`command: collect ${layer} --channel ${channel}`);
  console.log(`snapshot key: ${formatSnapshotKey(snapshotKey)}`);
  console.log(`snapshot id: ${snapshot.id}`);
  console.log(`upstream version: ${version.upstreamVersionId}`);
  console.log(`corpus version: ${version.corpusVersionId}`);
  console.log(`status: ${layer} collection stub ready`);
}

function parseLayer(value: string | undefined): CollectLayer | null {
  if (value === "desktop" || value === "web") {
    return value;
  }

  return null;
}

function parseChannel(args: string[]): ReleaseChannel | null {
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

function printUsage(): void {
  console.error("usage: discorpus collect <desktop|web> --channel <stable|ptb|canary>");
}

main();
