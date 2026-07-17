import fs from "node:fs";

export function isPdfSignature(bytes: Buffer): boolean {
  return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
}

export function validatePdfFile(filePath: string): { isPdf: boolean; bytes: Buffer } {
  const bytes = fs.readFileSync(filePath);
  return {
    isPdf: isPdfSignature(bytes),
    bytes,
  };
}
