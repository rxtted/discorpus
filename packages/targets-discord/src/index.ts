import type { CorpusLayer, ReleaseChannel, SnapshotKey, TargetPlatform } from "@discorpus/core";

export const discordTargetId = "discord";

export const discordChannels: ReleaseChannel[] = ["stable", "ptb", "canary"];

export const discordLayers: CorpusLayer[] = ["desktop", "web", "unknown"];

export const discordPlatforms: TargetPlatform[] = ["windows"];

export function createDiscordSnapshotKey(
  channel: ReleaseChannel,
  platform: TargetPlatform,
  layer: CorpusLayer,
): SnapshotKey {
  return {
    target: discordTargetId,
    channel,
    platform,
    layer,
  };
}

export function isDiscordChannel(value: string): value is ReleaseChannel {
  return discordChannels.includes(value as ReleaseChannel);
}
