import { createSnapshotId, formatSnapshotKey } from "@discorpus/core";
import { createDiscordSnapshotKey, discordChannels, discordPlatforms } from "@discorpus/targets-discord";

function main(): void {
  const observedAt = new Date().toISOString();
  const snapshotKey = createDiscordSnapshotKey(discordChannels[0], discordPlatforms[0], "desktop");
  const snapshotId = createSnapshotId(snapshotKey, observedAt);

  console.log("discorpus");
  console.log(`snapshot key: ${formatSnapshotKey(snapshotKey)}`);
  console.log(`snapshot id: ${snapshotId}`);
  console.log("status: scaffold ready");
}

main();
