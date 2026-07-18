/**
 * Mac worker for the hybrid invoice pipeline.
 *
 * Watches a shared folder for extraction jobs dropped by the Raspberry Pi,
 * runs the CPU-heavy PDF parsing + OCR (reusing the pipeline's own
 * `extractDocumentText`, so behaviour is identical to local mode), and writes
 * the result back for the Pi to pick up.
 *
 * Run (from the aiucto repo root on the Mac):
 *   node --import tsx worker/worker.ts --root /AIUCTO
 *   # or: AIUCTO_ROOT=/AIUCTO node --import tsx worker/worker.ts
 *
 * Requirements on the Mac:
 *   - tesseract installed (brew install tesseract tesseract-lang) for OCR
 *   - this repo checked out with `npm install` (chokidar, pdfjs-dist, tsx)
 *   - the /AIUCTO folder synced with the Pi (Syncthing / iCloud / SMB share)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import chokidar from "chokidar";
import { extractDocumentText } from "../src/invoice-monthly/pdfExtraction.js";
import { ensureDirectory, readJsonFile, writeJsonAtomic } from "../src/invoice-monthly/fs.js";
import {
  HYBRID_DIRS,
  HYBRID_PROTOCOL_VERSION,
  HybridExtractionResult,
  HybridJob,
  isJobFile,
  jobIdFromFilename,
  resultFilename,
} from "../src/invoice-monthly/hybridProtocol.js";

function log(event: string, payload: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: event.endsWith(".failed") ? "error" : "info",
    event,
    ...payload,
  }));
}

function resolveRoot(): string {
  const argIndex = process.argv.indexOf("--root");
  const fromArg = argIndex >= 0 ? process.argv[argIndex + 1] : undefined;
  const root = fromArg ?? process.env.AIUCTO_ROOT;
  if (!root) {
    throw new Error("Shared folder root is required. Pass --root /AIUCTO or set AIUCTO_ROOT.");
  }
  return path.resolve(root);
}

const root = resolveRoot();
const dirs = {
  incoming: path.join(root, HYBRID_DIRS.incoming),
  processing: path.join(root, HYBRID_DIRS.processing),
  processed: path.join(root, HYBRID_DIRS.processed),
  results: path.join(root, HYBRID_DIRS.results),
};
for (const dir of Object.values(dirs)) ensureDirectory(dir);

/** Read a text file if it exists, else null. */
function readIfPresent(filePath: string | null): string | null {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf8");
}

/** Move a file if it is still where we expect; returns false if it is gone
 *  (another worker instance already claimed it). */
function tryMove(from: string, to: string): boolean {
  try {
    fs.renameSync(from, to);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function processJob(jobBasename: string): Promise<void> {
  const id = jobIdFromFilename(jobBasename);
  const resultPath = path.join(dirs.results, resultFilename(id));
  if (fs.existsSync(resultPath)) {
    // Already done on a previous run; make sure the inputs are parked and skip.
    tryMove(path.join(dirs.incoming, jobBasename), path.join(dirs.processed, jobBasename));
    return;
  }

  const incomingJobPath = path.join(dirs.incoming, jobBasename);
  const processingJobPath = path.join(dirs.processing, jobBasename);

  // Atomic claim: whichever process wins the rename owns the job. This is the
  // "do not process the same file twice" guard.
  if (!tryMove(incomingJobPath, processingJobPath)) return;

  let job: HybridJob;
  try {
    job = readJsonFile<HybridJob>(processingJobPath);
  } catch (error) {
    log("worker.job.failed", { id, reason: "unreadable_job", message: error instanceof Error ? error.message : String(error) });
    tryMove(processingJobPath, path.join(dirs.processed, jobBasename));
    return;
  }

  if (job.protocolVersion !== HYBRID_PROTOCOL_VERSION) {
    log("worker.job.failed", { id, reason: "protocol_mismatch", jobVersion: job.protocolVersion, workerVersion: HYBRID_PROTOCOL_VERSION });
  }

  log("worker.job.started", { id, sha256: job.sha256, account: job.account, period: job.period, file: job.file });

  // Move the payload alongside the job so both live in processing/.
  const payloadIncoming = path.join(dirs.incoming, job.file);
  const payloadProcessing = path.join(dirs.processing, job.file);
  if (fs.existsSync(payloadIncoming)) tryMove(payloadIncoming, payloadProcessing);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `aiucto-worker-${id}-`));
  const textDirectory = path.join(scratch, "text");
  const ocrDirectory = path.join(scratch, "ocr");

  let result: HybridExtractionResult;
  try {
    if (!fs.existsSync(payloadProcessing)) {
      throw new Error(`Payload file '${job.file}' was not found in incoming/ or processing/.`);
    }
    const extraction = await extractDocumentText({
      sha256: job.sha256,
      localPath: payloadProcessing,
      textDirectory,
      ocrDirectory,
      isPdf: job.isPdf,
      isImage: job.isImage,
      ocrEnabled: job.ocrEnabled,
      ocrLanguages: job.ocrLanguages,
    });
    result = {
      id,
      sha256: job.sha256,
      extraction,
      textContent: readIfPresent(extraction.textPath),
      ocrTextContent: readIfPresent(extraction.ocrTextPath ?? extraction.ocr.outputTextPath),
      protocolVersion: HYBRID_PROTOCOL_VERSION,
      processedAt: new Date().toISOString(),
    };
    log("worker.job.extracted", {
      id,
      sha256: job.sha256,
      extractionStatus: extraction.extractionStatus,
      extractionMethod: extraction.extractionMethod,
      pageCount: extraction.pageCount,
      characters: extraction.extractedCharacterCount,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("worker.job.failed", { id, sha256: job.sha256, reason: "extraction_error", message });
    result = {
      id,
      sha256: job.sha256,
      extraction: {
        extractionStatus: "parse_failed",
        extractionMethod: "extraction_failed",
        pageCount: null,
        textPath: null,
        ocrTextPath: null,
        extractedCharacterCount: 0,
        normalizedText: "",
        pageTexts: [],
        error: message,
        ocr: { provider: "none", language: null, quality: "failed", outputTextPath: null, warnings: [message], available: false },
      },
      textContent: null,
      ocrTextContent: null,
      protocolVersion: HYBRID_PROTOCOL_VERSION,
      processedAt: new Date().toISOString(),
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  // Publish the result atomically, then park the inputs.
  writeJsonAtomic(resultPath, result, 0o600);
  tryMove(processingJobPath, path.join(dirs.processed, jobBasename));
  if (fs.existsSync(payloadProcessing)) tryMove(payloadProcessing, path.join(dirs.processed, job.file));
  log("worker.job.completed", { id, sha256: job.sha256, resultPath });
}

// Serialize jobs through a single-lane queue so we never overload the Mac.
let chain: Promise<void> = Promise.resolve();
function enqueue(jobBasename: string): void {
  chain = chain
    .then(() => processJob(jobBasename))
    .catch((error) => log("worker.job.failed", { jobBasename, reason: "unhandled", message: error instanceof Error ? error.message : String(error) }));
}

log("worker.started", { root, dirs });

chokidar
  .watch(dirs.incoming, {
    ignoreInitial: false, // pick up any backlog on startup
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  })
  .on("add", (filePath: string) => {
    const basename = path.basename(filePath);
    if (!isJobFile(basename)) return; // ignore payload files; jobs drive the work
    enqueue(basename);
  })
  .on("error", (error: unknown) => log("worker.watch.failed", { message: error instanceof Error ? error.message : String(error) }));

process.on("SIGINT", () => { log("worker.stopped", { reason: "SIGINT" }); process.exit(0); });
process.on("SIGTERM", () => { log("worker.stopped", { reason: "SIGTERM" }); process.exit(0); });
