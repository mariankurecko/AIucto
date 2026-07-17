import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function ensureDirectory(directoryPath: string, mode = 0o700): void {
  fs.mkdirSync(directoryPath, { recursive: true, mode });
  fs.chmodSync(directoryPath, mode);
}

export function writeJsonAtomic(
  filePath: string,
  value: unknown,
  mode = 0o600,
): void {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export function writeFileAtomic(
  filePath: string,
  contents: string | Buffer,
  mode = 0o600,
): void {
  ensureDirectory(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, contents, { mode });
  fs.chmodSync(tempPath, mode);
  fs.renameSync(tempPath, filePath);
  fs.chmodSync(filePath, mode);
}

export function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export function sha256Hex(input: Buffer | string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function sanitizePathSegment(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "-")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 120) || "unknown";
}

export function safeFileExtension(filename: string, mimeType: string): string {
  const lowered = filename.toLowerCase();
  if (lowered.endsWith(".pdf")) return "pdf";
  if (lowered.endsWith(".jpg") || lowered.endsWith(".jpeg")) return "jpg";
  if (lowered.endsWith(".png")) return "png";
  if (lowered.endsWith(".webp")) return "webp";
  if (lowered.endsWith(".heic")) return "heic";
  if (lowered.endsWith(".heif")) return "heif";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/heic") return "heic";
  if (mimeType === "image/heif") return "heif";
  return "bin";
}

export function validateSourceFilename(input: string): { valid: boolean; reason: string | null } {
  if (!input || input.includes("\0")) {
    return { valid: false, reason: "missing_or_null_filename" };
  }
  if (/[\r\n\t]/.test(input)) {
    return { valid: false, reason: "control_character" };
  }
  if (input.includes("/") || input.includes("\\") || input.includes("..")) {
    return { valid: false, reason: "path_like_filename" };
  }
  if (Buffer.byteLength(input, "utf8") > 512) {
    return { valid: false, reason: "filename_too_many_bytes" };
  }
  if (Array.from(input).length > 300) {
    return { valid: false, reason: "filename_too_many_characters" };
  }
  return { valid: true, reason: null };
}
