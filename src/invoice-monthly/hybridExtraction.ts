import fs from "node:fs";
import path from "node:path";
import { ensureDirectory, readJsonFile, writeFileAtomic, writeJsonAtomic } from "./fs.js";
import { LocalExtractionResult, ProcessingConfig } from "./types.js";
import {
  HYBRID_PROTOCOL_VERSION,
  HybridExtractionResult,
  HybridJob,
  deriveJobId,
  jobFilename,
  resultFilename,
} from "./hybridProtocol.js";

function log(event: string, payload: Record<string, unknown>): void {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: event.endsWith(".failed") || event.endsWith(".timed_out") ? "error" : "info",
    event,
    ...payload,
  }));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function failedExtraction(error: string): LocalExtractionResult {
  return {
    extractionStatus: "parse_failed",
    extractionMethod: "extraction_failed",
    pageCount: null,
    textPath: null,
    ocrTextPath: null,
    extractedCharacterCount: 0,
    normalizedText: "",
    pageTexts: [],
    error,
    ocr: { provider: "none", language: null, quality: "failed", outputTextPath: null, warnings: [error], available: false },
  };
}

/** Re-materialize the worker's inline text into Pi-local files so downstream code
 *  sees valid textPath/ocrTextPath exactly as in the local extraction path. */
function rematerialize(
  result: HybridExtractionResult,
  textDirectory: string,
  ocrDirectory: string,
  id: string,
): LocalExtractionResult {
  const extraction = result.extraction;
  let textPath: string | null = null;
  let ocrTextPath: string | null = null;

  if (result.textContent != null) {
    ensureDirectory(textDirectory);
    textPath = path.join(textDirectory, `${id}.txt`);
    writeFileAtomic(textPath, result.textContent, 0o600);
  }
  if (result.ocrTextContent != null) {
    ensureDirectory(ocrDirectory);
    ocrTextPath = path.join(ocrDirectory, `${id}.ocr.txt`);
    writeFileAtomic(ocrTextPath, result.ocrTextContent, 0o600);
  }

  return {
    ...extraction,
    textPath,
    ocrTextPath,
    ocr: { ...extraction.ocr, outputTextPath: ocrTextPath },
  };
}

async function waitForResult(resultPath: string, processing: ProcessingConfig): Promise<boolean> {
  const deadline = Date.now() + processing.timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(resultPath)) return true;
    await sleep(processing.pollIntervalMs);
  }
  return fs.existsSync(resultPath);
}

/**
 * Drop-in replacement for `extractDocumentText` that offloads the CPU-heavy PDF
 * parsing + OCR to the Mac worker via the shared folder, then blocks until the
 * result arrives. Idempotent: an existing result file is reused without
 * re-dispatching, so interrupted runs resume cleanly and no file is processed
 * twice.
 */
export async function extractDocumentTextHybrid(
  params: {
    sha256: string;
    localPath: string;
    textDirectory: string;
    ocrDirectory: string;
    isPdf: boolean;
    isImage: boolean;
    ocrEnabled: boolean;
    ocrLanguages: string[];
    account: string;
    period: string;
    sourceEmail: string | null;
    receivedDate: string | null;
  },
  processing: ProcessingConfig,
): Promise<LocalExtractionResult> {
  const id = deriveJobId(params.sha256);
  const incomingDir = processing.incomingPath;
  const resultsDir = processing.resultsPath;
  const resultPath = path.join(resultsDir, resultFilename(id));

  // Reuse a result the worker already produced (resume / retry safe).
  if (!fs.existsSync(resultPath)) {
    const ext = path.extname(params.localPath) || (params.isPdf ? ".pdf" : params.isImage ? ".img" : ".bin");
    const fileBasename = `${id}${ext}`;
    const filePath = path.join(incomingDir, fileBasename);
    const jobPath = path.join(incomingDir, jobFilename(id));
    ensureDirectory(incomingDir);

    // Write the attachment first, then the job descriptor — the worker triggers
    // on the job file, so the payload is guaranteed present when it fires.
    if (!fs.existsSync(filePath)) {
      writeFileAtomic(filePath, fs.readFileSync(params.localPath), 0o600);
    }
    if (!fs.existsSync(jobPath)) {
      const job: HybridJob = {
        id,
        sha256: params.sha256,
        file: fileBasename,
        account: params.account,
        period: params.period,
        sourceEmail: params.sourceEmail,
        receivedDate: params.receivedDate,
        isPdf: params.isPdf,
        isImage: params.isImage,
        ocrEnabled: params.ocrEnabled,
        ocrLanguages: params.ocrLanguages,
        protocolVersion: HYBRID_PROTOCOL_VERSION,
        createdAt: new Date().toISOString(),
      };
      writeJsonAtomic(jobPath, job, 0o600);
      log("invoice.hybrid.dispatched", { id, sha256: params.sha256, incomingDir, resultPath });
    }

    const ready = await waitForResult(resultPath, processing);
    if (!ready) {
      log("invoice.hybrid.timed_out", { id, sha256: params.sha256, timeoutMs: processing.timeoutMs, resultPath });
      // Fail this one document softly (it becomes review_required) rather than
      // sinking the whole monthly run.
      return failedExtraction(`Hybrid worker did not return a result within ${processing.timeoutMs}ms.`);
    }
  }

  let result: HybridExtractionResult;
  try {
    result = readJsonFile<HybridExtractionResult>(resultPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("invoice.hybrid.result_unreadable.failed", { id, sha256: params.sha256, resultPath, message });
    return failedExtraction(`Hybrid result was unreadable: ${message}`);
  }

  log("invoice.hybrid.result_received", {
    id,
    sha256: params.sha256,
    extractionStatus: result.extraction.extractionStatus,
    extractionMethod: result.extraction.extractionMethod,
  });
  return rematerialize(result, params.textDirectory, params.ocrDirectory, id);
}
