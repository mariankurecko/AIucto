/**
 * Deterministic Google Drive synchronisation for approved accounting documents.
 *
 * Guarantee: every document that was discovered, extracted and classified as
 * `approved_accounting_document` MUST exist in the month's "Approved Documents"
 * Drive folder after a run (unless explicitly rejected). This module makes that
 * guarantee hold even across quota errors, resumed runs and reused results:
 *
 *   - presence is checked against the ACTUAL target folder (not global dedup),
 *   - a missing document is force-uploaded,
 *   - uploads retry with exponential backoff (max 5),
 *   - quota errors never sink the pipeline — they are queued and the run
 *     continues, then reported so a `--reconcile-drive` pass can finish the job.
 */
import path from "node:path";
import { isQuotaError } from "./googleServices.js";
import { readJsonFile } from "./fs.js";
import { buildRunDirectory } from "./runState.js";
import {
  ClassifiedDocument,
  DriveFileRecord,
  DriveFolderTree,
  InvoiceMonthlyServices,
  MonthlyWorkflowConfig,
  PeriodInfo,
} from "./types.js";

const APPROVED_DECISION = "approved_accounting_document";
const DRIVE_MAX_RETRIES = 5;
const DRIVE_BASE_DELAY_MS = 1000;
const DRIVE_MAX_DELAY_MS = 16000;

/** Per-document Drive outcome, exactly as required by the hard-logging spec. */
export type DriveDocStatus = "uploaded" | "skipped_existing" | "missing" | "retrying" | "failed";

export type DriveSyncDocResult = {
  sha256: string;
  file: string;
  classification: string;
  driveStatus: DriveDocStatus;
  driveFileId: string | null;
  driveUrl: string | null;
  error: string | null;
  quotaDeferred: boolean;
};

export type DriveSyncSummary = {
  total_documents: number;
  approved_documents: number;
  uploaded_now: number;
  already_present: number;
  missing_after_run: number;
  failed: number;
  quota_deferred: number;
  results: DriveSyncDocResult[];
};

export type DriveAuditReport = {
  accountId: string;
  period: string;
  total_results: number;
  total_approved: number;
  total_present_in_drive: number;
  missing_in_drive: Array<{ sha256: string; filename: string }>;
  extra_in_drive: Array<{ sha256: string | null; name: string; driveFileId: string }>;
};

function driveLog(level: "info" | "warn" | "error", event: string, payload: Record<string, unknown>): void {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...payload }));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The folder an approved document must land in. */
export function approvedTargetFolderId(folderTree: DriveFolderTree): string {
  return folderTree.approved?.id ?? folderTree.month.id;
}

/** Stable filename used for the Drive object (mirrors workflow.uploadFilename). */
export function driveDocumentFilename(document: ClassifiedDocument): string {
  return document.safeStoredFilename
    ?? document.storedFilename
    ?? document.originalFilename
    ?? `${document.sha256.slice(0, 12)}.${document.fileExtension ?? "bin"}`;
}

function buildAppProperties(params: {
  config: MonthlyWorkflowConfig;
  runId: string;
  period: string;
  document: ClassifiedDocument;
}): Record<string, string> {
  const { config, document } = params;
  return {
    marianAiOs: "true",
    accountingIdentity: config.accountingIdentity,
    accountId: config.accountId,
    sha256: document.sha256,
    sourceRun: params.runId,
    sourcePeriod: params.period,
    packagePeriod: params.period,
    sourceMailbox: [...new Set(document.sourceMessages.map((source) => source.mailbox))].join(","),
    documentType: document.documentType,
    finalDecision: document.finalDecision ?? "rejected_non_accounting",
    resourceRole: "original_document",
  };
}

/**
 * Idempotently place a single approved document into the target folder, with
 * retry + quota-safe semantics. Never throws — always resolves to a status so
 * the caller can keep the pipeline alive and report the gap.
 */
export async function syncApprovedDocument(params: {
  config: MonthlyWorkflowConfig;
  services: InvoiceMonthlyServices;
  folderTree: DriveFolderTree;
  runId: string;
  period: string;
  document: ClassifiedDocument;
}): Promise<DriveSyncDocResult> {
  const { document } = params;
  const parentId = approvedTargetFolderId(params.folderTree);
  const filename = driveDocumentFilename(document);
  const appProperties = buildAppProperties(params);
  const base: Omit<DriveSyncDocResult, "driveStatus" | "driveFileId" | "driveUrl" | "error" | "quotaDeferred"> = {
    sha256: document.sha256,
    file: document.originalFilename ?? filename,
    classification: document.finalDecision ?? "unknown",
  };

  const drive = params.services.drive;
  const hasEnsure = typeof drive.ensureFileInFolder === "function";
  if (!hasEnsure) {
    // Fall back to the (global-dedup) uploader if the deterministic method is unavailable.
    driveLog("warn", "invoice.drive_sync.ensure_unavailable", { sha256: document.sha256 });
  }

  let lastError: string | null = null;
  for (let attempt = 1; attempt <= DRIVE_MAX_RETRIES; attempt++) {
    try {
      let fileId: string | null = null;
      let webViewLink: string | null = null;
      let created = false;

      if (hasEnsure) {
        // Call on the object so `this` binds inside the Drive service.
        const outcome = await drive.ensureFileInFolder!({
          parentId,
          localPath: document.localPath,
          filename,
          mimeType: document.mimeType,
          appProperties,
        });
        created = outcome.created;
        fileId = outcome.file?.id ?? document.driveFileId ?? null;
        webViewLink = outcome.file?.webViewLink
          ?? (fileId ? `https://drive.google.com/file/d/${fileId}/view` : document.driveUrl ?? null);
      } else {
        const outcome = await drive.uploadOrReuseFile!({
          parentId,
          localPath: document.localPath,
          filename,
          mimeType: document.mimeType,
          appProperties,
        });
        created = outcome.created;
        fileId = outcome.file.id;
        webViewLink = outcome.file.webViewLink ?? `https://drive.google.com/file/d/${outcome.file.id}/view`;
      }

      const status: DriveDocStatus = created ? "uploaded" : "skipped_existing";
      return { ...base, driveStatus: status, driveFileId: fileId, driveUrl: webViewLink, error: null, quotaDeferred: false };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      const quota = isQuotaError(error);
      if (attempt < DRIVE_MAX_RETRIES) {
        const delayMs = Math.min(DRIVE_BASE_DELAY_MS * 2 ** (attempt - 1), DRIVE_MAX_DELAY_MS);
        driveLog("warn", "drive_upload_retry_attempt", {
          sha256: document.sha256,
          file: base.file,
          attempt,
          maxRetries: DRIVE_MAX_RETRIES,
          delayMs,
          quota,
          message: lastError,
        });
        await sleep(delayMs);
        continue;
      }
      // Exhausted retries. Quota errors are queued (deferred), never fatal.
      if (quota) {
        driveLog("warn", "invoice.drive_sync.quota_deferred", { sha256: document.sha256, file: base.file, message: lastError });
        return { ...base, driveStatus: "retrying", driveFileId: document.driveFileId ?? null, driveUrl: document.driveUrl ?? null, error: lastError, quotaDeferred: true };
      }
      driveLog("error", "invoice.drive_sync.failed", { sha256: document.sha256, file: base.file, message: lastError });
      return { ...base, driveStatus: "failed", driveFileId: document.driveFileId ?? null, driveUrl: document.driveUrl ?? null, error: lastError, quotaDeferred: false };
    }
  }
  // Unreachable, but keeps the type checker happy.
  return { ...base, driveStatus: "failed", driveFileId: null, driveUrl: null, error: lastError, quotaDeferred: false };
}

/**
 * Sync every approved document to Drive deterministically and emit hard
 * per-document logs plus a final summary. Mutates each document's driveFileId /
 * driveUrl / driveFileUrl / uploadError in place so downstream (manifest, sheet)
 * sees the resolved Drive state. In `run` mode, non-approved documents have
 * their Drive fields cleared (matching prior behaviour); in `reconcile` mode
 * only approved documents are touched.
 */
export async function syncApprovedDocumentsToDrive(params: {
  config: MonthlyWorkflowConfig;
  services: InvoiceMonthlyServices;
  folderTree: DriveFolderTree;
  runId: string;
  period: string;
  documents: ClassifiedDocument[];
  mode: "run" | "reconcile";
}): Promise<DriveSyncSummary> {
  const approved = params.documents.filter((document) => document.finalDecision === APPROVED_DECISION);
  const results: DriveSyncDocResult[] = [];

  if (params.mode === "run") {
    for (const document of params.documents) {
      if (document.finalDecision !== APPROVED_DECISION) {
        document.driveFileId = null;
        document.driveUrl = null;
        document.driveFileUrl = null;
        document.reviewDriveFileId = null;
        document.reviewDriveFileUrl = null;
        document.uploadError = null;
      }
    }
  }

  for (const document of approved) {
    const result = await syncApprovedDocument({
      config: params.config,
      services: params.services,
      folderTree: params.folderTree,
      runId: params.runId,
      period: params.period,
      document,
    });
    // Reflect resolved state back onto the document.
    document.driveFileId = result.driveFileId;
    document.driveUrl = result.driveUrl;
    document.driveFileUrl = result.driveUrl;
    document.uploadError = result.error;
    results.push(result);
    // Hard per-document log in exactly the required shape.
    driveLog(result.driveStatus === "failed" ? "error" : "info", "invoice.drive_sync.document", {
      file: result.file,
      classification: result.classification,
      driveStatus: result.driveStatus,
      sha256: result.sha256,
      driveFileId: result.driveFileId,
    });
  }

  const uploaded_now = results.filter((r) => r.driveStatus === "uploaded").length;
  const already_present = results.filter((r) => r.driveStatus === "skipped_existing").length;
  const failed = results.filter((r) => r.driveStatus === "failed").length;
  const quota_deferred = results.filter((r) => r.quotaDeferred).length;
  const missing_after_run = results.filter((r) => r.driveStatus === "failed" || r.driveStatus === "retrying" || r.driveStatus === "missing").length;

  const summary: DriveSyncSummary = {
    total_documents: params.documents.length,
    approved_documents: approved.length,
    uploaded_now,
    already_present,
    missing_after_run,
    failed,
    quota_deferred,
    results,
  };

  driveLog(missing_after_run > 0 ? "warn" : "info", "invoice.drive_sync.summary", {
    mode: params.mode,
    total_documents: summary.total_documents,
    approved_documents: summary.approved_documents,
    uploaded_now: summary.uploaded_now,
    already_present: summary.already_present,
    missing_after_run: summary.missing_after_run,
    failed: summary.failed,
    quota_deferred: summary.quota_deferred,
  });

  return summary;
}

/**
 * Core audit: compare a set of approved documents against the actual Drive
 * "Approved Documents" folder they should live in. Matches by sha256 (preferred,
 * stored as an appProperty) and falls back to filename. Works from in-memory
 * documents so both the disk-based audit and the backfill router can reuse it.
 */
export async function compareDocumentsWithDrive(params: {
  services: InvoiceMonthlyServices;
  accountId: string;
  period: string;
  folderTree: DriveFolderTree;
  approved: ClassifiedDocument[];
  totalResults: number;
}): Promise<DriveAuditReport> {
  const approvedFolderId = approvedTargetFolderId(params.folderTree);

  let driveFiles: DriveFileRecord[] = [];
  if (params.services.drive.listFiles) {
    driveFiles = (await params.services.drive.listFiles(approvedFolderId))
      .filter((file) => (file.appProperties?.resourceRole ?? "original_document") === "original_document")
      .filter((file) => file.mimeType !== "application/vnd.google-apps.folder");
  }

  const driveBySha = new Set(driveFiles.map((file) => file.appProperties?.sha256).filter(Boolean) as string[]);
  const driveByName = new Set(driveFiles.map((file) => file.name));
  const approvedShaSet = new Set(params.approved.map((document) => document.sha256));

  const missing_in_drive = params.approved
    .filter((document) => !driveBySha.has(document.sha256) && !driveByName.has(driveDocumentFilename(document)))
    .map((document) => ({ sha256: document.sha256, filename: driveDocumentFilename(document) }));

  const extra_in_drive = driveFiles
    .filter((file) => {
      const sha = file.appProperties?.sha256;
      return !sha || !approvedShaSet.has(sha);
    })
    .map((file) => ({ sha256: file.appProperties?.sha256 ?? null, name: file.name, driveFileId: file.id }));

  const total_present_in_drive = params.approved.length - missing_in_drive.length;

  const report: DriveAuditReport = {
    accountId: params.accountId,
    period: params.period,
    total_results: params.totalResults,
    total_approved: params.approved.length,
    total_present_in_drive,
    missing_in_drive,
    extra_in_drive,
  };

  driveLog(missing_in_drive.length > 0 ? "warn" : "info", "invoice.drive_audit.report", {
    accountId: report.accountId,
    period: report.period,
    total_results: report.total_results,
    total_approved: report.total_approved,
    total_present_in_drive: report.total_present_in_drive,
    missing_in_drive_count: missing_in_drive.length,
    extra_in_drive_count: extra_in_drive.length,
    missing_in_drive: missing_in_drive,
  });
  if (missing_in_drive.length > 0) {
    driveLog("warn", "DRIVE SYNC GAP DETECTED", {
      accountId: report.accountId,
      period: report.period,
      missing_count: missing_in_drive.length,
      missing: missing_in_drive,
    });
  }

  return report;
}

/**
 * STEP 1 audit: compare classified results on disk with the actual Drive
 * "Approved Documents" folder.
 */
export async function compareResultsWithDrive(params: {
  projectRoot: string;
  services: InvoiceMonthlyServices;
  config: MonthlyWorkflowConfig;
  period: PeriodInfo;
  folderTree?: DriveFolderTree;
}): Promise<DriveAuditReport> {
  const runDirectory = buildRunDirectory(params.projectRoot, params.config.accountId, params.period.period);
  const classifiedPath = path.join(runDirectory, "classified.json");
  let classified: ClassifiedDocument[] = [];
  try {
    classified = readJsonFile<ClassifiedDocument[]>(classifiedPath);
  } catch {
    driveLog("warn", "invoice.drive_audit.no_results", { classifiedPath });
  }
  const approved = classified.filter((document) => document.finalDecision === APPROVED_DECISION);
  const folderTree = params.folderTree ?? await params.services.drive.ensureMonthlyFolder(params.config, params.period);

  return compareDocumentsWithDrive({
    services: params.services,
    accountId: params.config.accountId,
    period: params.period.period,
    folderTree,
    approved,
    totalResults: classified.length,
  });
}
