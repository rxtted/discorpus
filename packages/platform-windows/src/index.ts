import { createHash } from "node:crypto";
import { access, readdir, readFile, stat } from "node:fs/promises";
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

export interface WindowsDesktopArtifact {
  kind: string;
  path: string;
  relativePath: string;
  sha256: string;
  size: number;
}

export interface WindowsDesktopManifest {
  install: WindowsDesktopInstall;
  artifacts: WindowsDesktopArtifact[];
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

export async function collectWindowsDesktopManifest(
  install: WindowsDesktopInstall,
): Promise<WindowsDesktopManifest> {
  const paths = new Set<string>();

  if (install.updateExePath) {
    paths.add(install.updateExePath);
  }

  if (install.currentAppDir) {
    const appPaths = await walkFiles(install.currentAppDir);

    for (const value of appPaths) {
      paths.add(value);
    }
  }

  const artifacts = await Promise.all(
    [...paths].sort().map(async (filePath) => {
      const fileStat = await stat(filePath);
      const sha256 = await hashFile(filePath);

      return {
        kind: classifyArtifact(filePath, install),
        path: filePath,
        relativePath: toRelativeArtifactPath(filePath, install),
        sha256,
        size: fileStat.size,
      };
    }),
  );

  return {
    install,
    artifacts,
  };
}

async function findAppDirs(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("app-"))
    .map((entry) => path.join(rootDir, entry.name))
    .sort(compareAppDirs);
}

async function walkFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      const nestedFiles = await walkFiles(fullPath);
      files.push(...nestedFiles);
      continue;
    }

    if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
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

async function hashFile(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

function classifyArtifact(filePath: string, install: WindowsDesktopInstall): string {
  if (install.updateExePath && filePath === install.updateExePath) {
    return "updater";
  }

  if (install.executablePath && filePath === install.executablePath) {
    return "desktop_executable";
  }

  if (install.appAsarPath && filePath === install.appAsarPath) {
    return "app_asar";
  }

  if (filePath.endsWith(".dll")) {
    return "dll";
  }

  if (filePath.includes(`${path.sep}locales${path.sep}`)) {
    return "locale";
  }

  if (filePath.endsWith(".pak")) {
    return "pak";
  }

  if (filePath.endsWith(".bin") || filePath.endsWith(".dat")) {
    return "runtime_blob";
  }

  return "file";
}

function toRelativeArtifactPath(filePath: string, install: WindowsDesktopInstall): string {
  if (install.updateExePath && filePath === install.updateExePath) {
    return path.basename(filePath);
  }

  if (install.currentAppDir) {
    return path.relative(install.currentAppDir, filePath);
  }

  return path.basename(filePath);
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}
