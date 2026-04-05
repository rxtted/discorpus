#!/usr/bin/env node

import { runCollect } from "./collect/index.js";
import {
  runDiffLatest,
  runFindArtifact,
  runInspectArchive,
  runInspectArchiveForLatest,
  runInspectLatest,
  runInspectSnapshot,
  runListEntries,
  runListEntriesForLatest,
  runListSnapshots,
} from "./inspect/index.js";
import { parseChannel, parseLayer, parseLayerFromOption, parseOption, printUsage } from "./shared.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const normalizedArgs = args.filter((value) => value !== "--json");

  if (normalizedArgs[0] === "snapshots") {
    const layer = parseLayerFromOption(normalizedArgs.slice(1));
    await runListSnapshots(layer, json);
    return;
  }

  if (normalizedArgs[0] === "collect") {
    const layer = parseLayer(normalizedArgs[1]);
    const channel = parseChannel(normalizedArgs.slice(2));

    if (!layer || !channel) {
      printUsage();
      process.exitCode = 1;
      return;
    }

    await runCollect(layer, channel, json);
    return;
  }

  if (normalizedArgs[0] === "snapshot") {
    const selector = normalizedArgs[1];

    if (!selector) {
      printUsage();
      process.exitCode = 1;
      return;
    }

    if (selector === "latest") {
      const layer = parseLayerFromOption(normalizedArgs.slice(2));
      const channel = parseChannel(normalizedArgs.slice(2));

      if (!layer || !channel) {
        printUsage();
        process.exitCode = 1;
        return;
      }

      await runInspectLatest(layer, channel, json);
      return;
    }

    await runInspectSnapshot(selector, json);
    return;
  }

  if (normalizedArgs[0] === "entries") {
    const selector = normalizedArgs[1];

    if (!selector) {
      printUsage();
      process.exitCode = 1;
      return;
    }

    if (selector === "latest") {
      const layer = parseLayerFromOption(normalizedArgs.slice(2));
      const channel = parseChannel(normalizedArgs.slice(2));

      if (!layer || !channel) {
        printUsage();
        process.exitCode = 1;
        return;
      }

      await runListEntriesForLatest(layer, channel, json);
      return;
    }

    await runListEntries(selector, json);
    return;
  }

  if (normalizedArgs[0] === "archive") {
    const selector = normalizedArgs[1];
    const archiveName = normalizedArgs[2];

    if (!selector || !archiveName) {
      printUsage();
      process.exitCode = 1;
      return;
    }

    if (selector === "latest") {
      const layer = parseLayerFromOption(normalizedArgs.slice(3));
      const channel = parseChannel(normalizedArgs.slice(3));

      if (!layer || !channel) {
        printUsage();
        process.exitCode = 1;
        return;
      }

      await runInspectArchiveForLatest(layer, channel, archiveName, json);
      return;
    }

    await runInspectArchive(selector, archiveName, json);
    return;
  }

  if (normalizedArgs[0] === "find" && normalizedArgs[1] === "artifact") {
    const sha256 = parseOption(normalizedArgs.slice(2), "--sha256");
    const kind = parseOption(normalizedArgs.slice(2), "--kind");
    const pathFragment = parseOption(normalizedArgs.slice(2), "--path");

    if (!sha256 && !kind && !pathFragment) {
      printUsage();
      process.exitCode = 1;
      return;
    }

    await runFindArtifact({ kind, pathFragment, sha256 }, json);
    return;
  }

  if (normalizedArgs[0] === "diff" && normalizedArgs[1] === "latest") {
    const layer = parseLayerFromOption(normalizedArgs.slice(2));
    const channel = parseChannel(normalizedArgs.slice(2));

    if (!layer || !channel) {
      printUsage();
      process.exitCode = 1;
      return;
    }

    await runDiffLatest(layer, channel, json);
    return;
  }

  printUsage();
  process.exitCode = 1;
}

void main().catch((error: unknown) => {
  if (error instanceof Error && error.message === "desktop install not found") {
    return;
  }

  console.error(error);
  process.exitCode = 1;
});
