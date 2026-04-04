import { access, readdir } from "node:fs/promises";
import path from "node:path";

import type { ReleaseChannel } from "@discorpus/core";

export interface WindowsDesktopInstall {
  channel: ReleaseChannel;
  rootDir: string;
  updateExePath: string | null;
  currentAppDir: string | null;
  executablePath: string | null;
  resourcesDir: string | null;
  appAsarPath: string | null;
  installedVersions: string[];
}

const channelDirs: Record<ReleaseChannel, string> = {
  stable: "Discord",
  ptb: "DiscordPTB",
  canary: "DiscordCanary",
};

const channelExecutables: Record<ReleaseChannel, string> = {
  stable: "Discord.exe",
  ptb: "DiscordPTB.exe",
  canary: "DiscordCanary.exe",
};

export async function discoverWindowsDesktopInstall(
  channel: ReleaseChannel,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WindowsDesktopInstall | null> {
  const localAppData = env.LOCALAPPDATA;

  if (!localAppData) {
    return null;
  }

  const rootDir = path.join(localAppData, channelDirs[channel]);

  if (!(await pathExists(rootDir))) {
    return null;
  }

  const appDirs = await findAppDirs(rootDir);
  const currentAppDir = appDirs.at(-1) ?? null;
  const updateExePath = await pickExistingPath(path.join(rootDir, "Update.exe"));
  const executablePath = currentAppDir
    ? await pickExistingPath(path.join(currentAppDir, channelExecutables[channel]))
    : null;
  const resourcesDir = currentAppDir
    ? await pickExistingPath(path.join(currentAppDir, "resources"))
    : null;
  const appAsarPath = resourcesDir
    ? await pickExistingPath(path.join(resourcesDir, "app.asar"))
    : null;

  return {
    channel,
    rootDir,
    updateExePath,
    currentAppDir,
    executablePath,
    resourcesDir,
    appAsarPath,
    installedVersions: appDirs.map(getVersionFromAppDir),
  };
}

async function findAppDirs(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("app-"))
    .map((entry) => path.join(rootDir, entry.name))
    .sort(compareAppDirs);
}

function compareAppDirs(left: string, right: string): number {
  return compareVersions(getVersionFromAppDir(left), getVersionFromAppDir(right));
}

function getVersionFromAppDir(appDir: string): string {
  return path.basename(appDir).slice(4);
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(toVersionNumber);
  const rightParts = right.split(".").map(toVersionNumber);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;

    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }

  return left.localeCompare(right);
}

function toVersionNumber(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function pickExistingPath(value: string): Promise<string | null> {
  return (await pathExists(value)) ? value : null;
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}
