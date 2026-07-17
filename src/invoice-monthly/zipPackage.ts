import fs from "node:fs";
import path from "node:path";
import { sha256Hex, writeFileAtomic } from "./fs.js";

type ZipEntry = {
  name: string;
  data: Buffer;
};

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(date: Date): { time: number; date: number } {
  const seconds = Math.floor(date.getUTCSeconds() / 2);
  const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | seconds;
  const dosDate = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, date: dosDate };
}

export function createDeterministicZip(params: {
  outputPath: string;
  pdfPathsByName: Array<{ filename: string; localPath: string }>;
  manifestName: string;
  manifestBuffer: Buffer;
}): { zipPath: string; sizeBytes: number; sha256: string; filenames: string[] } {
  const generatedAt = new Date("2026-01-01T00:00:00.000Z");
  const timestamp = dosTime(generatedAt);
  const entries: ZipEntry[] = [
    ...params.pdfPathsByName
      .slice()
      .sort((a, b) => a.filename.localeCompare(b.filename))
      .map((entry) => ({
        name: entry.filename,
        data: fs.readFileSync(entry.localPath),
      })),
    { name: params.manifestName, data: params.manifestBuffer },
  ];

  let offset = 0;
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];

  for (const entry of entries) {
    const fileNameBuffer = Buffer.from(entry.name, "utf8");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(timestamp.time, 10);
    header.writeUInt16LE(timestamp.date, 12);
    header.writeUInt32LE(crc32(entry.data), 14);
    header.writeUInt32LE(entry.data.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(fileNameBuffer.length, 26);
    header.writeUInt16LE(0, 28);
    localParts.push(header, fileNameBuffer, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(timestamp.time, 12);
    central.writeUInt16LE(timestamp.date, 14);
    central.writeUInt32LE(crc32(entry.data), 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(fileNameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, fileNameBuffer);

    offset += header.length + fileNameBuffer.length + entry.data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  const zipBuffer = Buffer.concat([...localParts, centralDirectory, end]);
  writeFileAtomic(params.outputPath, zipBuffer, 0o600);
  return {
    zipPath: params.outputPath,
    sizeBytes: zipBuffer.length,
    sha256: sha256Hex(zipBuffer),
    filenames: entries.map((entry) => entry.name),
  };
}

export function validateZipAgainstManifest(params: {
  approvedHashes: string[];
  manifestHashes: string[];
  manifestPdfFilenames: string[];
  zipPdfFilenames: string[];
}): void {
  const normalized = (items: string[]) => items.slice().sort();
  const approvedHashes = normalized(params.approvedHashes);
  const manifestHashes = normalized(params.manifestHashes);
  const manifestPdfFilenames = normalized(params.manifestPdfFilenames);
  const zipPdfFilenames = normalized(params.zipPdfFilenames);

  if (JSON.stringify(approvedHashes) !== JSON.stringify(manifestHashes)) {
    throw new Error("Manifest hashes do not match the final approved SHA-256 set.");
  }
  if (JSON.stringify(manifestPdfFilenames) !== JSON.stringify(zipPdfFilenames)) {
    throw new Error("ZIP filenames do not match manifest PDF filenames.");
  }
}
