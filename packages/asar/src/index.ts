import { readFile } from "node:fs/promises";
import path from "node:path";

export interface AsarFileEntry {
  executable: boolean;
  offset: number | null;
  path: string;
  size: number;
  unpacked: boolean;
}

export interface AsarArchiveSummary {
  contentOffset: number;
  fileCount: number;
  filePath: string;
  headerSize: number;
  headerStringSize: number;
  unpackedFileCount: number;
}

export interface AsarExtractedFile extends AsarFileEntry {
  buffer: Buffer | null;
}

interface AsarNode {
  executable?: boolean;
  files?: Record<string, AsarNode>;
  offset?: string;
  size?: number;
  unpacked?: boolean;
}

interface AsarHeader {
  files?: Record<string, AsarNode>;
}

export async function extractAsarArchive(
  filePath: string,
  onFile?: (file: AsarExtractedFile) => Promise<void> | void,
): Promise<AsarArchiveSummary> {
  const archiveBuffer = await readFile(filePath);

  if (archiveBuffer.length < 16) {
    throw new Error(`invalid asar archive: ${filePath}`);
  }

  const headerSize = archiveBuffer.readUInt32LE(4);
  const headerStringSize = archiveBuffer.readUInt32LE(12);
  const headerStart = 16;
  const headerEnd = headerStart + headerStringSize;
  const contentOffset = 8 + headerSize;
  const headerJson = archiveBuffer.subarray(headerStart, headerEnd).toString("utf8");
  const header = JSON.parse(headerJson) as AsarHeader;
  const files = flattenAsarFiles(header.files ?? {});
  let unpackedFileCount = 0;

  for (const file of files) {
    if (file.unpacked) {
      unpackedFileCount += 1;
      await onFile?.({
        ...file,
        buffer: null,
      });
      continue;
    }

    const start = contentOffset + (file.offset ?? 0);
    const end = start + file.size;
    const buffer = archiveBuffer.subarray(start, end);

    await onFile?.({
      ...file,
      buffer,
    });
  }

  return {
    contentOffset,
    fileCount: files.length,
    filePath,
    headerSize,
    headerStringSize,
    unpackedFileCount,
  };
}

function flattenAsarFiles(
  files: Record<string, AsarNode>,
  prefix = "",
): AsarFileEntry[] {
  const entries: AsarFileEntry[] = [];

  for (const [name, node] of Object.entries(files)) {
    const entryPath = prefix ? path.posix.join(prefix, name) : name;

    if (node.files) {
      entries.push(...flattenAsarFiles(node.files, entryPath));
      continue;
    }

    entries.push({
      executable: node.executable ?? false,
      offset: node.offset === undefined ? null : Number.parseInt(node.offset, 10),
      path: entryPath,
      size: node.size ?? 0,
      unpacked: node.unpacked ?? false,
    });
  }

  return entries.sort((left, right) => left.path.localeCompare(right.path));
}
