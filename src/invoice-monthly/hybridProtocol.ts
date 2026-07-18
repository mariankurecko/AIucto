import { sanitizePathSegment } from "./fs.js";
import { LocalExtractionResult } from "./types.js";

/**
 * Shared contract between the Raspberry Pi pipeline and the Mac worker.
 *
 * The two machines communicate only through a shared (synced) folder, e.g.
 *
 *   /AIUCTO/
 *     incoming/     Pi drops <id>.<ext> + <id>.json job descriptors here
 *     processing/   worker moves the pair here while it works (double-run guard)
 *     processed/    worker parks the inputs here when finished
 *     results/      worker writes <id>.result.json; Pi polls for it
 *
 * The heavy work handed off is text extraction only (native PDF parsing + OCR).
 * Classification, company identity, period validation, Drive and Sheets all stay
 * on the Pi, so the wire contract is narrow and stable.
 */

export const HYBRID_DIRS = {
  incoming: "incoming",
  processing: "processing",
  processed: "processed",
  results: "results",
} as const;

/** Bump when the wire shape changes so stale results can be detected. */
export const HYBRID_PROTOCOL_VERSION = 1;

export type HybridJob = {
  id: string;
  sha256: string;
  /** Basename of the attachment file, stored alongside this job descriptor. */
  file: string;
  account: string;
  period: string;
  sourceEmail: string | null;
  receivedDate: string | null;
  isPdf: boolean;
  isImage: boolean;
  ocrEnabled: boolean;
  ocrLanguages: string[];
  protocolVersion: number;
  createdAt: string;
};

/**
 * A {@link LocalExtractionResult} with the extracted text carried inline instead
 * of as machine-local file paths. The Pi re-materializes the text into its own
 * text/ocr directories and rewrites the paths, keeping full compatibility with
 * the local (non-hybrid) code path.
 */
export type HybridExtractionResult = {
  id: string;
  sha256: string;
  extraction: LocalExtractionResult;
  textContent: string | null;
  ocrTextContent: string | null;
  protocolVersion: number;
  processedAt: string;
};

/** Filesystem-safe job id derived from a document sha256 (or unsafe:* pseudo-hash). */
export function deriveJobId(sha256: string): string {
  return sanitizePathSegment(sha256);
}

export function jobFilename(id: string): string {
  return `${id}.json`;
}

export function resultFilename(id: string): string {
  return `${id}.result.json`;
}

/** A job descriptor (but not a result) awaiting the worker. */
export function isJobFile(basename: string): boolean {
  return basename.endsWith(".json") && !basename.endsWith(".result.json");
}

export function jobIdFromFilename(basename: string): string {
  return basename.replace(/\.json$/, "");
}
