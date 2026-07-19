import path from "node:path";
import { dateBelongsToPeriod, periodStringFromDate } from "./period.js";
import { ClassifiedDocument, DriveFolderTree, DriveService, ManifestDocumentRecord, MonthlyWorkflowConfig, PeriodInfo } from "./types.js";

type PeriodDateInfo = {
  invoiceDate: string | null;
  deliveryDate: string | null;
  accountingDate: string | null;
  accountingPeriod: string | null;
  detectedPeriod: string | null;
  invalidDate: boolean;
};

export type PeriodValidationResult = PeriodDateInfo & {
  valid: boolean;
  usedFallbackDate: boolean;
  reason: "ok" | "out_of_period" | "missing_date" | "invalid_date";
};

export type PeriodCleanupAction = {
  sha256: string;
  filename: string;
  invoiceDate: string | null;
  deliveryDate: string | null;
  detectedPeriod: string | null;
  driveFileId: string | null;
  reason: "out_of_period";
};

function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.match(/\b(20\d{2})[./-](\d{1,2})[./-](\d{1,2})\b/);
  if (!match) return null;
  const [, year, month, day] = match;
  const normalized = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (
    parsed.getUTCFullYear() !== Number(year)
    || parsed.getUTCMonth() + 1 !== Number(month)
    || parsed.getUTCDate() !== Number(day)
  ) return null;
  return normalized;
}

function hasInvalidDate(value: string | null | undefined): boolean {
  return Boolean(value && /\b20\d{2}[./-]\d{1,2}[./-]\d{1,2}\b/.test(value) && !normalizeDate(value));
}

function hasInvalidPeriod(value: string | null | undefined): boolean {
  if (!value) return false;
  const match = value.match(/^(\d{4})-(\d{2})$/);
  return !match || Number(match[2]) < 1 || Number(match[2]) > 12;
}

export function documentPeriodDates(document: Pick<ClassifiedDocument, "invoiceDate" | "deliveryDate" | "accountingPeriod" | "detectedPeriod" | "issueDate" | "taxableSupplyDate" | "document">): PeriodDateInfo {
  const rawInvoiceDate = document.invoiceDate ?? document.document?.issueDate ?? document.issueDate ?? null;
  const rawDeliveryDate = document.deliveryDate ?? document.document?.taxableSupplyDate ?? document.taxableSupplyDate ?? null;
  const invoiceDate = normalizeDate(rawInvoiceDate);
  const deliveryDate = normalizeDate(rawDeliveryDate);
  // For receipts, the extracted issue date represents the transaction date. For
  // invoices, taxable supply/delivery is the accounting date when available.
  const accountingDate = deliveryDate ?? invoiceDate;
  const accountingPeriod = periodStringFromDate(accountingDate);
  return {
    invoiceDate,
    deliveryDate,
    accountingDate,
    accountingPeriod,
    detectedPeriod: accountingPeriod,
    invalidDate: hasInvalidDate(rawInvoiceDate) || hasInvalidDate(rawDeliveryDate) || hasInvalidPeriod(document.accountingPeriod ?? document.detectedPeriod),
  };
}

export function manifestPeriodDates(document: Pick<ManifestDocumentRecord, "invoiceDate" | "deliveryDate" | "detectedPeriod" | "document">): PeriodDateInfo {
  return documentPeriodDates(document);
}

export function validateDocumentPeriod(document: Pick<ClassifiedDocument, "invoiceDate" | "deliveryDate" | "accountingPeriod" | "detectedPeriod" | "issueDate" | "taxableSupplyDate" | "document">, period: PeriodInfo, config: MonthlyWorkflowConfig): PeriodValidationResult {
  const result = documentPeriodDates(document);
  const { invoiceDate, deliveryDate, accountingDate, accountingPeriod, detectedPeriod, invalidDate } = result;
  const invoiceInPeriod = dateBelongsToPeriod(invoiceDate, period);
  const deliveryInPeriod = dateBelongsToPeriod(deliveryDate, period);
  const usedFallbackDate = !invoiceInPeriod && deliveryInPeriod;

  if (!config.periodValidation.enabled) {
    return { ...result, valid: true, usedFallbackDate, reason: "ok" };
  }
  if (invalidDate) return { invoiceDate, deliveryDate, accountingDate, accountingPeriod, detectedPeriod, invalidDate, valid: false, usedFallbackDate: false, reason: "invalid_date" };
  if (!invoiceDate && !deliveryDate) {
    return { invoiceDate, deliveryDate, accountingDate, accountingPeriod, detectedPeriod, invalidDate, valid: false, usedFallbackDate: false, reason: "missing_date" };
  }
  if (invoiceInPeriod || deliveryInPeriod) {
    return { invoiceDate, deliveryDate, accountingDate, accountingPeriod, detectedPeriod, invalidDate, valid: true, usedFallbackDate, reason: "ok" };
  }
  return { invoiceDate, deliveryDate, accountingDate, accountingPeriod, detectedPeriod, invalidDate, valid: false, usedFallbackDate, reason: "out_of_period" };
}

// A parsed invoice date more than this many days BEFORE the email's received
// date is treated as implausible (almost always a contract/registration date
// picked up from the body). Legitimate late invoices in practice arrive within
// ~2-3 months; this leaves a wide safety margin.
const IMPLAUSIBLE_BACKDATE_DAYS = 180;

function daysBetween(laterIso: string, earlierIso: string): number {
  return Math.round((Date.parse(laterIso) - Date.parse(earlierIso)) / 86_400_000);
}

export function applyPeriodValidation(document: ClassifiedDocument, period: PeriodInfo, config: MonthlyWorkflowConfig, options?: { routeByDocumentDate?: boolean; receivedDate?: string | null }): ClassifiedDocument {
  const routeByDocumentDate = options?.routeByDocumentDate === true;
  const result = validateDocumentPeriod(document, period, config);
  document.invoiceDate = result.invoiceDate;
  document.deliveryDate = result.deliveryDate;

  // Routing guard: if the invoice date is implausibly older than the received
  // date, it is almost certainly a misparse — route by the delivery date instead
  // (when that one is plausible) and flag the document's date as uncertain. The
  // raw parsed dates are still surfaced on the document for transparency; only the
  // routing period (detectedPeriod) is corrected.
  const received = options?.receivedDate && /^\d{4}-\d{2}-\d{2}$/.test(options.receivedDate) ? options.receivedDate : null;
  let routingAccountingDate = result.accountingDate;
  let dateUncertain = false;
  if (received && routingAccountingDate && daysBetween(received, routingAccountingDate) > IMPLAUSIBLE_BACKDATE_DAYS) {
    dateUncertain = true;
    routingAccountingDate = null;
  }
  // Any invalid calendar value makes date extraction unreliable. Do not route
  // an otherwise-approved document using a different incidental date.
  document.accountingPeriod = result.invalidDate ? null : periodStringFromDate(routingAccountingDate);
  document.detectedPeriod = document.accountingPeriod;
  if (dateUncertain) {
    document.warnings = [...new Set([...(document.warnings ?? []), "uncertain_document_date"])];
    document.validationReasons = [...new Set([...(document.validationReasons ?? []), "invoice_date_implausible"])];
  }
  document.document = {
    ...(document.document ?? {
      documentNumber: null,
      variableSymbol: null,
      issueDate: null,
      taxableSupplyDate: null,
      dueDate: null,
      orderNumber: null,
      receiptNumber: null,
      cashRegisterNumber: null,
      paymentMethod: null,
    }),
    issueDate: result.invoiceDate,
    taxableSupplyDate: result.deliveryDate,
  };
  document.issueDate = result.invoiceDate;
  document.taxableSupplyDate = result.deliveryDate;
  document.validationReasons = [...new Set([...(document.validationReasons ?? []), ...(result.valid ? ["period_validated"] : [])])];

  if ((result.reason === "missing_date" || result.reason === "invalid_date" || !document.accountingPeriod || dateUncertain) && document.finalDecision === "approved_accounting_document") {
    // Only demote to review_required if we were about to approve the document; rejections stand as-is.
    // This holds in BOTH modes: a document with no usable date is never silently approved.
    document.finalDecision = "review_required";
    document.approvalStatus = "auto_approved_unverified";
    document.zipIncluded = false;
    document.warnings = [...new Set([...(document.warnings ?? []), result.reason === "invalid_date" ? "invalid_document_date" : !document.accountingPeriod ? "missing_accounting_period" : "uncertain_document_date"])];
    document.validationReasons = [...new Set([...(document.validationReasons ?? []), result.reason === "invalid_date" ? "invalid_routing_period" : "missing_accounting_period"])];
  } else if (result.reason === "out_of_period" && !routeByDocumentDate) {
    // Single-period mode: a document dated outside the run's month is not part of
    // this package.
    document.finalDecision = "rejected_non_accounting";
    document.approvalStatus = "excluded_non_accounting";
    document.zipIncluded = false;
    document.rejectionReasons = [...new Set([...(document.rejectionReasons ?? []), "out_of_period"])];
  } else if (result.reason === "out_of_period" && routeByDocumentDate) {
    // Backfill / route-by-document-date mode: the document is valid, it simply
    // belongs to a different month. Keep the classification decision and let the
    // caller route it to its detectedPeriod folder (e.g. a May invoice -> 2026-05).
    document.validationReasons = [...new Set([...(document.validationReasons ?? []), "routed_by_document_date"])];
  }

  return document;
}

export function periodCleanupCandidates(documents: ManifestDocumentRecord[], period: PeriodInfo): PeriodCleanupAction[] {
  return documents
    .map((document) => {
      const dates = manifestPeriodDates(document);
      const invoiceInPeriod = dateBelongsToPeriod(dates.invoiceDate, period);
      const deliveryInPeriod = dateBelongsToPeriod(dates.deliveryDate, period);
      if (invoiceInPeriod || deliveryInPeriod) return null;
      return {
        sha256: document.sha256,
        filename: document.safeStoredFilename ?? document.storedFilename ?? document.originalFilename,
        invoiceDate: dates.invoiceDate,
        deliveryDate: dates.deliveryDate,
        detectedPeriod: dates.detectedPeriod,
        driveFileId: document.driveFileId ?? null,
        reason: "out_of_period" as const,
      };
    })
    .filter((value): value is PeriodCleanupAction => Boolean(value));
}

export function buildOutOfPeriodFilename(document: PeriodCleanupAction): string {
  return path.basename(document.filename || `${document.sha256}.pdf`);
}

export async function reconcileOutOfPeriodDriveFiles(params: {
  config: MonthlyWorkflowConfig;
  drive: DriveService;
  folderTree: DriveFolderTree;
  period: string;
  actions: PeriodCleanupAction[];
}) {
  if (!params.actions.length) {
    return { moved: 0, deleted: 0, skipped: 0 };
  }

  let moved = 0;
  let deleted = 0;
  let skipped = 0;

  if (params.config.periodValidation.driveCleanupAction === "delete") {
    if (!params.drive.deleteFile) return { moved, deleted, skipped: params.actions.length };
    for (const action of params.actions) {
      if (!action.driveFileId) {
        skipped += 1;
        continue;
      }
      await params.drive.deleteFile(action.driveFileId);
      deleted += 1;
    }
    return { moved, deleted, skipped };
  }

  const ensureChildFolder = params.drive.ensureChildFolder;
  const moveFile = params.drive.moveFile;
  const approvedFolder = params.folderTree.approved;
  if (!ensureChildFolder || !moveFile || !approvedFolder) {
    return { moved, deleted, skipped: params.actions.length };
  }

  const outOfPeriodFolder = await ensureChildFolder("OutOfPeriod", params.folderTree.month.id, {
    marianAiOs: "true",
    accountId: params.config.accountId,
    resourceRole: "out_of_period",
    packagePeriod: params.period,
  });

  for (const action of params.actions) {
    if (!action.driveFileId) {
      skipped += 1;
      continue;
    }
    await moveFile(action.driveFileId, outOfPeriodFolder.id, [approvedFolder.id]);
    moved += 1;
  }

  return { moved, deleted, skipped };
}
