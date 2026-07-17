import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { OcrResult } from "./types.js";
import { ensureDirectory, writeFileAtomic } from "./fs.js";

const execFileAsync = promisify(execFile);

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync("bash", ["-lc", `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}

export async function performLocalOcr(params: {
  inputPath: string;
  outputDirectory: string;
  sha256: string;
  languages: string[];
}): Promise<OcrResult> {
  const hasTesseract = await commandExists("tesseract");
  if (!hasTesseract) {
    return {
      provider: "none",
      language: null,
      quality: "failed",
      outputTextPath: null,
      warnings: ["Local OCR unavailable: tesseract is not installed."],
      available: false,
    };
  }

  ensureDirectory(params.outputDirectory);
  const base = path.join(params.outputDirectory, `${params.sha256}.ocr`);
  const languages = params.languages.join("+");
  const tempPrefix = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "invoice-ocr-")), "ocr");

  try {
    await execFileAsync("tesseract", [params.inputPath, tempPrefix, "-l", languages]);
    const content = fs.readFileSync(`${tempPrefix}.txt`, "utf8");
    const outputTextPath = `${base}.txt`;
    writeFileAtomic(outputTextPath, content, 0o600);
    return {
      provider: "local_tesseract",
      language: languages,
      quality: content.trim().length >= 80 ? "medium" : "low",
      outputTextPath,
      warnings: [],
      available: true,
    };
  } catch (error) {
    return {
      provider: "none",
      language: null,
      quality: "failed",
      outputTextPath: null,
      warnings: [error instanceof Error ? error.message : String(error)],
      available: true,
    };
  }
}
