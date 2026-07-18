import fs from "node:fs";
import path from "node:path";
import { loadKeywordConfig } from "./accountingKeywords.js";
import { buildAuditPath, writeAuditSummary } from "./audit.js";
import { loadMonthlyConfig } from "./config.js";
import { ensureDirectory, readJsonFile, writeJsonAtomic } from "./fs.js";
import { createDeterministicZip, validateZipAgainstManifest } from "./zipPackage.js";
import { buildManifest } from "./manifest.js";
import { addDays, buildIncomingQuery, buildIncomingRangeQuery, buildSentQuery, buildSentRangeQuery, computePreviousCalendarMonth, periodFromString, periodStringFromDate } from "./period.js";
import { buildRunDirectory, buildRunStatePath, initializeRunState, updateRunState } from "./runState.js";
import { classifyDocuments, discoverPeriodAttachments, downloadAttachments, finalizeApprovedDocuments, mergeDownloadedAttachments } from "./gmailDiscovery.js";
import { compareDocumentsWithDrive, compareResultsWithDrive, syncApprovedDocumentsToDrive } from "./driveSync.js";
import { ClassifiedDocument, InvoiceMonthlyServices, PackageStatus, PreparedEmail, SendRecord, WorkflowMode } from "./types.js";

function parseArgs(argv: string[]): { account: string; period?: string; dryRun: boolean; prepareOnly: boolean; confirmSend: boolean; forceResend: boolean; forceReclassify: boolean; ocr: boolean; reconcileDrive: boolean; backfillReceivedFrom?: string; backfillReceivedTo?: string; routeByDocumentDate: boolean; } {
  function getArg(name: string): string | undefined {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  }
  return {
    account: getArg("account") ?? "equisix",
    period: getArg("period"),
    dryRun: argv.includes("--dry-run"),
    prepareOnly: argv.includes("--prepare-only"),
    confirmSend: getArg("confirm-send") === "YES",
    forceResend: getArg("force-resend") === "YES",
    forceReclassify: argv.includes("--force-reclassify"),
    ocr: argv.includes("--ocr"),
    reconcileDrive: argv.includes("--reconcile-drive"),
    backfillReceivedFrom: getArg("backfill-received-from"),
    backfillReceivedTo: getArg("backfill-received-to"),
    routeByDocumentDate: argv.includes("--route-by-document-date"),
  };
}

function buildEmail(params: { config: ReturnType<typeof loadMonthlyConfig>; period: string; folderUrl: string; zipUrl: string; registerUrl: string; approvedCount: number; reviewCount: number; incomingCount: number; sentCount: number; bothDirectionsCount: number; duplicateCount: number; zipPath: string; zipSha256: string; zipBytes: number; forceResend: boolean; }): PreparedEmail {
  const attachZip = params.zipBytes <= params.config.gmailAttachmentLimitBytes;
  return {
    idempotencyKey: `${params.config.accountId}:accounting-package:${params.period}:${params.config.accountantEmail}:${params.zipSha256}`,
    to: params.config.accountantEmail,
    from: params.config.senderEmail,
    subject: `${params.forceResend ? "[RESEND] " : ""}Equisix accounting documents — ${params.period}`,
    textBody: [
      `Automatically generated accounting package for ${params.period}.`,
      "",
      `Approved documents: ${params.approvedCount}`,
      `Review required: ${params.reviewCount}`,
      `Incoming-source attachments: ${params.incomingCount}`,
      `Sent-source attachments: ${params.sentCount}`,
      `Documents found in both directions: ${params.bothDirectionsCount}`,
      `Exact duplicates excluded: ${params.duplicateCount}`,
      "",
      "Google Drive folder:",
      params.folderUrl,
      "",
      "Google Drive ZIP:",
      params.zipUrl,
      "",
      "Invoice Register:",
      params.registerUrl,
      "",
      attachZip ? "The monthly ZIP is attached to this email." : "The monthly ZIP is not attached because it exceeds the configured Gmail attachment size limit.",
    ].join("\n"),
    attachZip,
    zipPath: params.zipPath,
    zipFilename: path.basename(params.zipPath),
  };
}

async function resolveInvoiceRegister(params: {
  config: ReturnType<typeof loadMonthlyConfig>;
  services: InvoiceMonthlyServices;
  accountingFolderId: string;
}): Promise<{ id: string; webViewLink: string | null }> {
  const byProperties = await params.services.drive.findFileByAppProperties(params.accountingFolderId, {
    marianAiOs: "true",
    accountingIdentity: params.config.accountingIdentity,
    resourceRole: "invoice_register",
  });
  if (byProperties) {
    return { id: byProperties.id, webViewLink: byProperties.webViewLink ?? null };
  }

  if (!params.services.drive.listFiles) {
    throw new Error("Drive service does not support listFiles, and invoice register could not be resolved by appProperties.");
  }

  const candidates = await params.services.drive.listFiles(params.accountingFolderId);
  const byName = candidates.find((file) =>
    file.mimeType === "application/vnd.google-apps.spreadsheet"
    && file.name === params.config.invoiceRegisterName,
  );
  if (!byName) {
    throw new Error(`Invoice register '${params.config.invoiceRegisterName}' was not found in the accounting folder.`);
  }

  return { id: byName.id, webViewLink: byName.webViewLink ?? null };
}

function uploadLog(event: string, payload: Record<string, unknown>) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: event.endsWith(".failed") ? "error" : "info",
    event,
    ...payload,
  }));
}

async function uploadOriginalDocuments(params: {
  config: ReturnType<typeof loadMonthlyConfig>;
  services: InvoiceMonthlyServices;
  folderTree: Awaited<ReturnType<InvoiceMonthlyServices["drive"]["ensureMonthlyFolder"]>>;
  runId: string;
  period: string;
  documents: ClassifiedDocument[];
}) {
  // Deterministic, retrying, quota-safe sync. Approved documents are guaranteed
  // to land in the "Approved Documents" folder (folder-scoped idempotency), and
  // transient/quota failures never sink the run — they are queued and reported.
  const summary = await syncApprovedDocumentsToDrive({
    config: params.config,
    services: params.services,
    folderTree: params.folderTree,
    runId: params.runId,
    period: params.period,
    documents: params.documents,
    mode: "run",
  });
  return {
    uploaded: summary.uploaded_now,
    reused: summary.already_present,
    failed: summary.failed + summary.quota_deferred,
  };
}

function writeClassifiedOutputs(runDirectory: string, documents: ClassifiedDocument[]) {
  const reviewRequired = documents.filter((document) => document.finalDecision === "review_required");
  writeJsonAtomic(path.join(runDirectory, "classified.json"), documents, 0o600);
  writeJsonAtomic(path.join(runDirectory, "approved.json"), documents.filter((document) => document.finalDecision === "approved_accounting_document"), 0o600);
  writeJsonAtomic(path.join(runDirectory, "review_required.json"), reviewRequired, 0o600);
  writeJsonAtomic(path.join(runDirectory, "review-required.json"), reviewRequired, 0o600);
  writeJsonAtomic(path.join(runDirectory, "rejected.json"), documents.filter((document) => !["approved_accounting_document", "review_required"].includes(document.finalDecision ?? "rejected_non_accounting")), 0o600);
}

function mergeFinalizedDocuments(params: {
  classified: ClassifiedDocument[];
  finalized: ReturnType<typeof finalizeApprovedDocuments>;
}): ClassifiedDocument[] {
  const approvedBySha = new Map(params.finalized.approved.map((document) => [document.sha256, document]));
  return params.classified.map((document) => {
    const finalized = approvedBySha.get(document.sha256);
    if (!finalized) return document;
    return {
      ...document,
      ...finalized,
      driveFileId: document.driveFileId ?? finalized.driveFileId ?? null,
      driveUrl: document.driveUrl ?? finalized.driveUrl ?? finalized.driveFileUrl ?? null,
      driveFileUrl: document.driveFileUrl ?? finalized.driveFileUrl ?? document.driveUrl ?? null,
      reviewDriveFileId: document.reviewDriveFileId ?? finalized.reviewDriveFileId ?? null,
      reviewDriveFileUrl: document.reviewDriveFileUrl ?? finalized.reviewDriveFileUrl ?? null,
      uploadError: document.uploadError ?? finalized.uploadError ?? null,
    };
  });
}

function printDriveSyncSummary(header: string, summary: { total_documents: number; approved_documents: number; uploaded_now: number; already_present: number; missing_after_run: number; }): void {
  console.log([
    "",
    `PRINT SUMMARY — ${header}`,
    `- total_documents:    ${summary.total_documents}`,
    `- approved_documents: ${summary.approved_documents}`,
    `- uploaded_now:       ${summary.uploaded_now}`,
    `- already_present:    ${summary.already_present}`,
    `- missing_after_run:  ${summary.missing_after_run}`,
    "",
  ].join("\n"));
}

/**
 * STEP 3 — reconciliation-only entry point. Reuses the classified results that
 * already exist on disk (no Gmail, no OCR, no LLM) and deterministically pushes
 * every approved document into Drive, then audits the result.
 */
async function runDriveReconciliation(params: {
  projectRoot: string;
  config: ReturnType<typeof loadMonthlyConfig>;
  services: InvoiceMonthlyServices;
  period: ReturnType<typeof periodFromString>;
  runDirectory: string;
  statePath: string;
  currentState: ReturnType<typeof initializeRunState>;
}): Promise<{ status: PackageStatus; output: Record<string, unknown>; }> {
  const { config, services, period } = params;
  const classifiedPath = path.join(params.runDirectory, "classified.json");
  if (!fs.existsSync(classifiedPath)) {
    throw new Error(`--reconcile-drive requires an existing run: classified.json not found at ${classifiedPath}. Run the monthly pipeline first.`);
  }
  const classified = readJsonFile<ClassifiedDocument[]>(classifiedPath);

  const driveAuthorizedEmail = await services.drive.getAuthorizedEmail();
  uploadLog("invoice.reconcile.started", {
    accountId: config.accountId,
    accountingIdentity: config.accountingIdentity,
    driveConnectionId: config.driveGoogleConnectionId,
    driveAuthorizedEmail,
    period: period.period,
    totalDocuments: classified.length,
    approvedDocuments: classified.filter((document) => document.finalDecision === "approved_accounting_document").length,
  });

  const folderTree = await services.drive.ensureMonthlyFolder(config, period);
  const summary = await syncApprovedDocumentsToDrive({
    config,
    services,
    folderTree,
    runId: params.currentState.runId,
    period: period.period,
    documents: classified,
    mode: "reconcile",
  });

  // Persist the resolved Drive state back so subsequent audits/passes see it.
  writeJsonAtomic(classifiedPath, classified, 0o600);
  writeClassifiedOutputs(params.runDirectory, classified);

  const audit = await compareResultsWithDrive({ projectRoot: params.projectRoot, services, config, period, folderTree });
  printDriveSyncSummary("reconcile-drive", summary);
  if (audit.missing_in_drive.length === 0 && summary.failed === 0) {
    console.log("DRIVE SYNC IS NOW DETERMINISTIC");
  }
  updateRunState(params.statePath, params.currentState, { stage: "completed" });

  return {
    status: "reconciled",
    output: {
      period: period.period,
      mode: "reconcile_drive",
      monthlyFolderUrl: folderTree.month.webViewLink,
      approvedFolderId: folderTree.approved?.id ?? folderTree.month.id,
      total_documents: summary.total_documents,
      approved_documents: summary.approved_documents,
      uploaded_now: summary.uploaded_now,
      already_present: summary.already_present,
      missing_after_run: summary.missing_after_run,
      failed: summary.failed,
      quota_deferred: summary.quota_deferred,
      audit,
    },
  };
}

/**
 * Backfill / document-date routing mode. Discovers attachments across an explicit
 * Gmail RECEIVED-date range for this inbox, classifies them, and routes each
 * APPROVED document into the Drive month folder of its OWN document date
 * (invoice/delivery date) — a May invoice received in June lands in 2026-05, not
 * 2026-06. Review/uncertain documents are never silently approved. Deterministic:
 * dedup by sha256, folder-scoped idempotent upload; re-running is a no-op.
 */
async function runBackfill(params: {
  projectRoot: string;
  config: ReturnType<typeof loadMonthlyConfig>;
  services: InvoiceMonthlyServices;
  keywordConfig: ReturnType<typeof loadKeywordConfig>;
  args: ReturnType<typeof parseArgs>;
}): Promise<{ status: PackageStatus; output: Record<string, unknown>; }> {
  const { projectRoot, config, services, keywordConfig, args } = params;
  const fromDate = args.backfillReceivedFrom!;
  const toDate = args.backfillReceivedTo ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    throw new Error(`--backfill-received-from/--backfill-received-to must be YYYY-MM-DD (got from='${fromDate}' to='${toDate}').`);
  }
  if (config.processing.mode === "hybrid") {
    throw new Error("Backfill requires processing.mode 'local' (hybrid needs the Mac worker). Set mode: local for this account before running the backfill.");
  }
  const beforeExclusive = addDays(toDate, 1); // `to` is inclusive; Gmail `before:` is exclusive.

  const runDirectory = buildRunDirectory(projectRoot, config.accountId, `backfill-${fromDate}_${toDate}`);
  const downloadsDirectory = path.join(runDirectory, "downloads");
  const textDirectory = path.join(runDirectory, "text");
  const ocrDirectory = path.join(runDirectory, "ocr");
  const llmResultsDirectory = path.join(runDirectory, "llm-results");
  [runDirectory, downloadsDirectory, textDirectory, ocrDirectory, llmResultsDirectory].forEach((dir) => ensureDirectory(dir));

  const representativePeriod = periodFromString(fromDate.slice(0, 7), config.timezone);
  const incomingQuery = config.scanIncomingMail ? buildIncomingRangeQuery(fromDate, beforeExclusive) : null;
  const sentQuery = config.scanSentMail ? buildSentRangeQuery(fromDate, beforeExclusive) : null;

  const driveAuthorizedEmail = await services.drive.getAuthorizedEmail();
  uploadLog("invoice.backfill.started", {
    accountId: config.accountId,
    sourceMailbox: config.sourceEmail,
    driveAuthorizedEmail,
    receivedFrom: fromDate,
    receivedToInclusive: toDate,
    incomingQuery,
    sentQuery,
  });

  const incomingDiscovery = incomingQuery ? await discoverPeriodAttachments({ config, period: representativePeriod, gmail: services.gmailRead, query: incomingQuery, direction: "incoming" }) : { messages: [], attachments: [] };
  const sentDiscovery = sentQuery ? await discoverPeriodAttachments({ config, period: representativePeriod, gmail: services.gmailRead, query: sentQuery, direction: "sent" }) : { messages: [], attachments: [] };
  const allAttachments = [...incomingDiscovery.attachments, ...sentDiscovery.attachments];
  const downloaded = await downloadAttachments({ attachments: allAttachments, gmail: services.gmailRead, downloadDirectory: downloadsDirectory });
  const merged = mergeDownloadedAttachments(downloaded);

  const classified = await classifyDocuments({
    config: { ...config, ocrEnabled: config.ocrEnabled ?? true },
    period: representativePeriod,
    keywordConfig,
    uniqueDocuments: merged.uniqueDocuments,
    textDirectory,
    ocrDirectory,
    llmResultsDirectory,
    openrouter: services.openrouter,
    routeByDocumentDate: true,
  });
  writeJsonAtomic(path.join(runDirectory, "classified.json"), classified, 0o600);

  // Group approved documents by their OWN document month (detectedPeriod).
  const approvedAll = classified.filter((document) => document.finalDecision === "approved_accounting_document");
  const byMonth = new Map<string, ClassifiedDocument[]>();
  const approvedUndated: ClassifiedDocument[] = [];
  for (const document of approvedAll) {
    const month = document.detectedPeriod ?? periodStringFromDate(document.invoiceDate) ?? periodStringFromDate(document.deliveryDate);
    if (!month) { approvedUndated.push(document); continue; }
    const list = byMonth.get(month) ?? [];
    list.push(document);
    byMonth.set(month, list);
  }

  const runId = `backfill-${config.accountId}-${fromDate}_${toDate}`;
  const perMonth: Array<Record<string, unknown>> = [];
  let totalUploaded = 0, totalPresent = 0, totalFailed = 0, totalMissing = 0, totalExtra = 0;
  for (const month of [...byMonth.keys()].sort()) {
    const docs = byMonth.get(month)!;
    const folderTree = await services.drive.ensureMonthlyFolder(config, periodFromString(month, config.timezone));
    const summary = await syncApprovedDocumentsToDrive({ config, services, folderTree, runId, period: month, documents: docs, mode: "run" });
    const audit = await compareDocumentsWithDrive({ services, accountId: config.accountId, period: month, folderTree, approved: docs, totalResults: docs.length });
    totalUploaded += summary.uploaded_now;
    totalPresent += summary.already_present;
    totalFailed += summary.failed + summary.quota_deferred;
    totalMissing += audit.missing_in_drive.length;
    totalExtra += audit.extra_in_drive.length;
    perMonth.push({ month, approvedFolderId: folderTree.approved?.id ?? folderTree.month.id, approved: docs.length, uploaded_now: summary.uploaded_now, already_present: summary.already_present, failed: summary.failed, quota_deferred: summary.quota_deferred, missing_in_drive: audit.missing_in_drive.length, extra_in_drive: audit.extra_in_drive.length });
  }

  const review = classified.filter((document) => document.finalDecision === "review_required");
  const rejected = classified.filter((document) => !["approved_accounting_document", "review_required"].includes(document.finalDecision ?? "rejected_non_accounting"));
  const ocrErrors = classified.filter((document) => ["parse_failed", "invalid_pdf", "ocr_unavailable", "needs_ocr", "encrypted_pdf"].includes(document.extractionStatus) || document.extractionMethod === "extraction_failed");
  const missingDateDocs = classified.filter((document) => (document.warnings ?? []).includes("missing_document_date"));

  console.log([
    "",
    `BACKFILL SUMMARY — ${config.accountId} (${config.sourceEmail})`,
    `- received range:        ${fromDate} .. ${toDate} (inclusive)`,
    `- attachments found:     ${allAttachments.length} (incoming ${incomingDiscovery.attachments.length}, sent ${sentDiscovery.attachments.length})`,
    `- duplicates removed:    ${merged.duplicateCount}`,
    `- unique classified:     ${classified.length}`,
    `- approved:              ${approvedAll.length}`,
    `- review / uncertain:    ${review.length}`,
    `- rejected / not-company:${rejected.length}`,
    `- OCR/extraction errors: ${ocrErrors.length}`,
    `- missing document date: ${missingDateDocs.length}`,
    `- approved without month:${approvedUndated.length}`,
    "- approved per month folder:",
    ...[...byMonth.keys()].sort().map((m) => `    ${m}: ${byMonth.get(m)!.length}`),
    `- Drive: uploaded ${totalUploaded}, already_present ${totalPresent}, failed ${totalFailed}, missing ${totalMissing}, extra ${totalExtra}`,
    "",
  ].join("\n"));
  if (totalMissing === 0 && totalFailed === 0) console.log("BACKFILL DRIVE SYNC IS DETERMINISTIC");

  return {
    status: "backfilled",
    output: {
      accountId: config.accountId,
      sourceMailbox: config.sourceEmail,
      receivedFrom: fromDate,
      receivedToInclusive: toDate,
      attachmentsFound: allAttachments.length,
      incomingAttachments: incomingDiscovery.attachments.length,
      sentAttachments: sentDiscovery.attachments.length,
      duplicatesRemoved: merged.duplicateCount,
      uniqueClassified: classified.length,
      approved: approvedAll.length,
      review: review.length,
      rejected: rejected.length,
      ocrErrors: ocrErrors.length,
      missingDocumentDate: missingDateDocs.length,
      approvedWithoutMonth: approvedUndated.length,
      approvedPerMonth: Object.fromEntries([...byMonth.entries()].map(([m, d]) => [m, d.length])),
      drive: { uploaded: totalUploaded, alreadyPresent: totalPresent, failed: totalFailed, missing: totalMissing, extra: totalExtra },
      perMonth,
    },
  };
}

export async function runInvoiceMonthlyWorkflow(projectRoot: string, services: InvoiceMonthlyServices, argv = process.argv.slice(2)): Promise<{ status: PackageStatus; output: Record<string, unknown>; }> {
  const args = parseArgs(argv);
  const config = loadMonthlyConfig(projectRoot, args.account);
  const keywordConfig = loadKeywordConfig(projectRoot, config.accountingKeywordsFile);

  // Backfill / document-date routing mode — self-contained; skips the single-period
  // package flow (no ZIP, no email) and routes approved docs by their document date.
  if (args.backfillReceivedFrom) {
    return runBackfill({ projectRoot, config, services, keywordConfig, args });
  }

  const period = args.period ? periodFromString(args.period, config.timezone) : computePreviousCalendarMonth(new Date(), config.timezone);
  const mode: WorkflowMode = args.dryRun ? "dry_run" : args.prepareOnly ? "prepare_only" : args.confirmSend ? "confirmed_send" : "scheduled";

  const runDirectory = buildRunDirectory(projectRoot, config.accountId, period.period);
  ensureDirectory(runDirectory);
  const state = initializeRunState({ runDirectory, accountId: config.accountId, period: period.period, mode, forcedResend: args.forceResend });
  let currentState = state;
  const statePath = buildRunStatePath(runDirectory);
  const auditPath = buildAuditPath(projectRoot, config.accountId, period.period);
  const sendRecordsPath = path.join(runDirectory, "send-records.json");
  const discoveryPath = path.join(runDirectory, "discovery.json");
  const classifiedPath = path.join(runDirectory, "classified.json");
  const manifestPath = path.join(runDirectory, "manifest.json");
  const classificationSummaryPath = path.join(runDirectory, "classification-summary.json");
  const preparedEmailPath = path.join(runDirectory, "prepared-email.json");
  const downloadsDirectory = path.join(runDirectory, "downloads");
  const textDirectory = path.join(runDirectory, "text");
  const ocrDirectory = path.join(runDirectory, "ocr");
  const llmResultsDirectory = path.join(runDirectory, "llm-results");
  const packagesDirectory = path.join(runDirectory, "package");
  [downloadsDirectory, textDirectory, ocrDirectory, llmResultsDirectory, packagesDirectory].forEach((dir) => ensureDirectory(dir));

  const incomingQuery = config.scanIncomingMail ? buildIncomingQuery(period, config.ingestion.nextMonthScanDays) : null;
  const sentQuery = config.scanSentMail ? buildSentQuery(period, config.ingestion.nextMonthScanDays) : null;

  if (args.dryRun) {
    return { status: "dry_run", output: { period: period.period, incomingQuery, sentQuery, accountantEmail: config.accountantEmail } };
  }

  // STEP 3 — Force reconciliation mode. Skips Gmail scan and OCR entirely and
  // only reconciles the already-classified results with Drive, so a run that
  // ended in "prepared" (or hit a quota mid-way) can be recovered without a full
  // rerun. IF a document is approved AND not in Drive → upload.
  if (args.reconcileDrive) {
    return runDriveReconciliation({ projectRoot, config, services, period, runDirectory, statePath, currentState });
  }

  const [gmailAuthorizedEmail, driveAuthorizedEmail] = await Promise.all([
    services.gmailRead.getProfileEmail(),
    services.drive.getAuthorizedEmail(),
  ]);
  uploadLog("invoice.run.started", {
    accountId: config.accountId,
    accountingIdentity: config.accountingIdentity,
    sourceMailbox: config.sourceEmail,
    gmailConnectionId: config.googleConnectionId,
    gmailAuthorizedEmail,
    driveConnectionId: config.driveGoogleConnectionId,
    driveAuthorizedEmail,
    driveRootName: config.driveRootName,
    driveRootFolderId: config.driveRootFolderId ?? null,
    period: period.period,
  });

  const incomingDiscovery = incomingQuery ? await discoverPeriodAttachments({ config, period, gmail: services.gmailRead, query: incomingQuery, direction: "incoming" }) : { messages: [], attachments: [] };
  currentState = updateRunState(statePath, currentState, { stage: "incoming_gmail_discovered" });
  const sentDiscovery = sentQuery ? await discoverPeriodAttachments({ config, period, gmail: services.gmailRead, query: sentQuery, direction: "sent" }) : { messages: [], attachments: [] };
  currentState = updateRunState(statePath, currentState, { stage: "sent_gmail_discovered" });

  const allAttachments = [...incomingDiscovery.attachments, ...sentDiscovery.attachments];
  currentState = updateRunState(statePath, currentState, { stage: "source_sets_merged" });
  const downloaded = await downloadAttachments({ attachments: allAttachments, gmail: services.gmailRead, downloadDirectory: downloadsDirectory });
  currentState = updateRunState(statePath, currentState, { stage: "attachments_downloaded" });
  const merged = mergeDownloadedAttachments(downloaded);
  currentState = updateRunState(statePath, currentState, { stage: "duplicates_resolved" });

  const classified = await classifyDocuments({ config: { ...config, ocrEnabled: args.ocr ? config.ocrEnabled : false }, period, keywordConfig, uniqueDocuments: merged.uniqueDocuments, textDirectory, ocrDirectory, llmResultsDirectory, openrouter: services.openrouter });
  for (const document of classified) {
    uploadLog("invoice.document.processed", {
      sha256: document.sha256,
      filename: document.originalFilename,
      sourceMailboxes: [...new Set(document.sourceMessages.map((source) => source.mailbox))],
      deduplicated: document.sourceMessages.length > 1,
      finalDecision: document.finalDecision ?? null,
    });
  }
  writeJsonAtomic(classifiedPath, classified, 0o600);
  currentState = updateRunState(statePath, currentState, { stage: "classified" });

  const finalDocuments = finalizeApprovedDocuments(classified);
  currentState = updateRunState(statePath, currentState, { stage: "approved", documentHashes: finalDocuments.approved.map((document) => document.sha256) });

  const folderTree = await services.drive.ensureMonthlyFolder(config, period);
  currentState = updateRunState(statePath, currentState, { stage: "drive_pdfs_uploaded", monthlyFolderId: folderTree.month.id, monthlyFolderUrl: folderTree.month.webViewLink });

  const uploadStats = await uploadOriginalDocuments({
    config,
    services,
    folderTree,
    runId: currentState.runId,
    period: period.period,
    documents: classified,
  });
  let drivePdfsCreated = uploadStats.uploaded;
  let drivePdfsReused = uploadStats.reused;
  const allDocumentsForManifest: ClassifiedDocument[] = mergeFinalizedDocuments({
    classified,
    finalized: finalDocuments,
  });
  writeClassifiedOutputs(runDirectory, allDocumentsForManifest);

  const manifest = buildManifest({ config, period: period.period, duplicateCount: merged.duplicateCount, excludedCount: finalDocuments.excludedCount, documents: allDocumentsForManifest, generatedAt: currentState.startedAt });
  writeJsonAtomic(manifestPath, manifest, 0o600);
  writeJsonAtomic(classificationSummaryPath, {
    period: period.period,
    approved: manifest.approvedDocumentCount,
    reviewRequired: manifest.reviewRequiredCount,
    rejected: manifest.rejectedDocumentCount,
  }, 0o600);
  currentState = updateRunState(statePath, currentState, { stage: "manifest_created", manifestPath });

  const manifestUpload = await services.drive.uploadOrReplaceJson({
    parentId: folderTree.month.id,
    filename: "manifest.json",
    localPath: manifestPath,
    appProperties: { marianAiOs: "true", accountingIdentity: config.accountingIdentity, accountId: config.accountId, resourceRole: "monthly_accounting_manifest", packagePeriod: period.period, packageVersion: String(config.packageVersion), documentCount: String(manifest.documentCount), sourceRun: currentState.runId },
  });
  await services.drive.uploadOrReplaceJson({
    parentId: folderTree.month.id,
    filename: "classification-summary.json",
    localPath: classificationSummaryPath,
    appProperties: { marianAiOs: "true", accountingIdentity: config.accountingIdentity, accountId: config.accountId, resourceRole: "monthly_classification_summary", packagePeriod: period.period, packageVersion: String(config.packageVersion), sourceRun: currentState.runId },
  });
  currentState = updateRunState(statePath, currentState, { stage: "manifest_uploaded", manifestDriveFileId: manifestUpload.id, manifestDriveUrl: manifestUpload.webViewLink });

  const zipName = config.zipNameTemplate.replace("{period}", period.period);
  const zipPath = path.join(packagesDirectory, zipName);
  const zipResult = createDeterministicZip({
    outputPath: zipPath,
    pdfPathsByName: finalDocuments.approved.map((document) => ({ filename: document.safeStoredFilename, localPath: document.localPath })),
    manifestName: "manifest.json",
    manifestBuffer: Buffer.from(JSON.stringify(manifest, null, 2)),
  });
  currentState = updateRunState(statePath, currentState, { stage: "zip_created", zipPath: zipResult.zipPath, zipSha256: zipResult.sha256, zipBytes: zipResult.sizeBytes });
  validateZipAgainstManifest({
    approvedHashes: finalDocuments.approved.map((document) => document.sha256),
    manifestHashes: manifest.documents.filter((document) => document.zipIncluded).map((document) => document.sha256),
    manifestPdfFilenames: manifest.documents.filter((document) => document.zipIncluded).map((document) => document.safeStoredFilename ?? "").filter(Boolean),
    zipPdfFilenames: zipResult.filenames.filter((name) => name !== "manifest.json"),
  });
  currentState = updateRunState(statePath, currentState, { stage: "zip_validated" });

  const zipUpload = await services.drive.uploadOrReplaceBinary({
    parentId: folderTree.month.id,
    filename: zipName,
    localPath: zipPath,
    mimeType: "application/zip",
    appProperties: { marianAiOs: "true", accountingIdentity: config.accountingIdentity, accountId: config.accountId, resourceRole: "monthly_accounting_zip", packagePeriod: period.period, packageVersion: String(config.packageVersion), zipSha256: zipResult.sha256, documentCount: String(manifest.approvedDocumentCount), sourceRun: currentState.runId },
  });
  currentState = updateRunState(statePath, currentState, { stage: "zip_uploaded", zipDriveFileId: zipUpload.id, zipDriveUrl: zipUpload.webViewLink });

  const invoiceRegister = await resolveInvoiceRegister({
    config,
    services,
    accountingFolderId: folderTree.accounting.id,
  });
  const invoiceRegisterUrl = invoiceRegister.webViewLink ?? "";
  let sheetResult = { appended: 0, updated: 0 };
  try {
    await services.sheets.ensureDocumentsSheet(invoiceRegister.id);
    sheetResult = await services.sheets.upsertDocuments({
      spreadsheetId: invoiceRegister.id,
      sheetName: "Documents",
      monthlyFolderUrl: folderTree.month.webViewLink ?? "",
      zipPackageUrl: zipUpload.webViewLink ?? "",
      runId: currentState.runId,
      processedAt: new Date().toISOString(),
      documents: allDocumentsForManifest,
    });
  } catch (sheetError) {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      event: "sheets.quota_exceeded_final",
      message: sheetError instanceof Error ? sheetError.message : String(sheetError),
    }));
  }
  currentState = updateRunState(statePath, currentState, { stage: "sheet_updated", invoiceRegisterUrl });

  const preparedEmail = buildEmail({
    config,
    period: period.period,
    folderUrl: folderTree.month.webViewLink ?? "",
    zipUrl: zipUpload.webViewLink ?? "",
    registerUrl: invoiceRegisterUrl,
    approvedCount: finalDocuments.approved.length,
    reviewCount: finalDocuments.reviewRequired.length,
    incomingCount: incomingDiscovery.attachments.length,
    sentCount: sentDiscovery.attachments.length,
    bothDirectionsCount: merged.bothDirectionsCount,
    duplicateCount: merged.duplicateCount,
    zipPath,
    zipSha256: zipResult.sha256,
    zipBytes: zipResult.sizeBytes,
    forceResend: args.forceResend,
  });
  writeJsonAtomic(preparedEmailPath, preparedEmail, 0o600);
  currentState = updateRunState(statePath, currentState, { stage: "email_prepared", preparedEmailPath });

  let status: PackageStatus = "prepared";
  let emailMessageId: string | null = null;
  let sendRecords: SendRecord[] = fs.existsSync(sendRecordsPath) ? readJsonFile<SendRecord[]>(sendRecordsPath) : [];
  const priorSend = sendRecords.find((record) => record.idempotencyKey === preparedEmail.idempotencyKey);
  const shouldSend = !args.prepareOnly && args.confirmSend && !priorSend;

  if (priorSend && !args.forceResend) {
    status = "already_sent";
  } else if (shouldSend) {
    if (!services.gmailSend) throw new Error(`Gmail send token is not configured for connection '${config.googleConnectionId}'.`);
    const message = await services.gmailSend.sendPreparedEmail(preparedEmail);
    emailMessageId = message.id;
    const record: SendRecord = {
      idempotencyKey: preparedEmail.idempotencyKey,
      packagePeriod: period.period,
      accountId: config.accountId,
      recipient: preparedEmail.to,
      sender: preparedEmail.from,
      gmailMessageId: message.id,
      sentAt: new Date().toISOString(),
      zipSha256: zipResult.sha256,
      monthlyFolderId: folderTree.month.id,
      zipDriveId: zipUpload.id,
      documentHashes: finalDocuments.approved.map((document) => document.sha256),
      packageVersion: config.packageVersion,
      forceResend: args.forceResend,
    };
    sendRecords = [...sendRecords, record];
    writeJsonAtomic(sendRecordsPath, sendRecords, 0o600);
    currentState = updateRunState(statePath, currentState, { stage: "email_sent", emailMessageId, emailSentAt: record.sentAt });
    status = "sent";
  }

  currentState = updateRunState(statePath, currentState, { stage: "completed" });
  writeJsonAtomic(discoveryPath, { incoming: incomingDiscovery, sent: sentDiscovery, downloadedCount: downloaded.length }, 0o600);

  // STEP 1/4 — verify determinism at the end of every run: audit results vs Drive
  // and print the sync summary. Any gap is logged as "DRIVE SYNC GAP DETECTED".
  const driveAudit = await compareResultsWithDrive({ projectRoot, services, config, period, folderTree });
  printDriveSyncSummary("run", {
    total_documents: classified.length,
    approved_documents: finalDocuments.approved.length,
    uploaded_now: uploadStats.uploaded,
    already_present: uploadStats.reused,
    missing_after_run: driveAudit.missing_in_drive.length,
  });

  writeAuditSummary(auditPath, {
    runId: currentState.runId,
    packageVersion: config.packageVersion,
    accountId: config.accountId,
    sourceMailbox: config.sourceEmail,
    sender: config.senderEmail,
    recipient: config.accountantEmail,
    packagePeriod: period.period,
    timezone: config.timezone,
    startTimestamp: currentState.startedAt,
    endTimestamp: new Date().toISOString(),
    incomingQuery,
    sentQuery,
    incomingDiscoveredMessageCount: incomingDiscovery.messages.length,
    sentDiscoveredMessageCount: sentDiscovery.messages.length,
    mergedUniqueMessageCount: new Set([...incomingDiscovery.messages, ...sentDiscovery.messages].map((message) => message.messageId)).size,
    downloadedPdfCount: downloaded.length,
    incomingPdfCount: incomingDiscovery.attachments.length,
    sentPdfCount: sentDiscovery.attachments.length,
    foundInBothDirectionsCount: merged.bothDirectionsCount,
    validPdfCount: downloaded.filter((item) => item.isPdf).length,
    uniquePdfCount: merged.uniqueDocuments.length,
    duplicateCount: merged.duplicateCount,
    includedDocumentCount: finalDocuments.approved.length,
    excludedDocumentCount: finalDocuments.rejected.length,
    unverifiedDocumentCount: finalDocuments.reviewRequired.length,
    matchedAccountingKeywordTotals: classified.reduce((sum, item) => sum + item.keywordAnalysis.matchedAccountingKeywords.length, 0),
    matchedSupportingSignalTotals: classified.reduce((sum, item) => sum + item.keywordAnalysis.matchedSupportingSignals.length, 0),
    matchedNegativeSignalTotals: classified.reduce((sum, item) => sum + item.keywordAnalysis.matchedNegativeSignals.length, 0),
    classificationFailures: classified.filter((item) => item.approvalStatus === "failed").length,
    extractionFailures: classified.filter((item) => ["parse_failed", "invalid_pdf", "ocr_unavailable"].includes(item.extractionStatus)).length,
    openrouterModelRequested: config.openrouterModel,
    openrouterProviderReturned: null,
    openrouterRetries: 0,
    drivePdfsCreated,
    drivePdfsReused,
    manifestDriveId: manifestUpload.id,
    manifestDriveUrl: manifestUpload.webViewLink,
    sheetRowsAppended: sheetResult.appended,
    sheetRowsUpdated: sheetResult.updated,
    zipLocalPath: zipPath,
    zipByteSize: zipResult.sizeBytes,
    zipSha256: zipResult.sha256,
    zipDriveId: zipUpload.id,
    zipDriveUrl: zipUpload.webViewLink,
    monthlyFolderDriveId: folderTree.month.id,
    monthlyFolderDriveUrl: folderTree.month.webViewLink,
    invoiceRegisterUrl,
    emailAttachmentIncluded: false,
    emailDriveFolderLinkIncluded: true,
    gmailSentMessageId: emailMessageId,
    emailSentTimestamp: currentState.emailSentAt,
    forceResend: args.forceResend,
    finalStatus: status,
    errorSummary: null,
  });

  return {
    status,
    output: {
      period: period.period,
      runStatePath: statePath,
      auditPath,
      manifestPath,
      zipPath,
      zipSha256: zipResult.sha256,
      monthlyFolderUrl: folderTree.month.webViewLink,
      manifestDriveUrl: manifestUpload.webViewLink,
      zipDriveUrl: zipUpload.webViewLink,
      invoiceRegisterUrl,
      incomingMessageCount: incomingDiscovery.messages.length,
      sentMessageCount: sentDiscovery.messages.length,
      duplicateCount: merged.duplicateCount,
      recipient: config.accountantEmail,
      preparedEmailPath,
      emailSent: false,
      uploadFailedCount: uploadStats.failed,
      approvedCount: finalDocuments.approved.length,
      reviewCount: finalDocuments.reviewRequired.length,
      rejectedCount: finalDocuments.rejected.length,
      driveMissingCount: driveAudit.missing_in_drive.length,
      drivePresentCount: driveAudit.total_present_in_drive,
    },
  };
}

export function parseWorkflowArgs(argv = process.argv.slice(2)) {
  return parseArgs(argv);
}
