import fs from "node:fs";
import path from "node:path";
import { loadKeywordConfig } from "./accountingKeywords.js";
import { buildAuditPath, writeAuditSummary } from "./audit.js";
import { loadMonthlyConfig } from "./config.js";
import { ensureDirectory, readJsonFile, writeJsonAtomic } from "./fs.js";
import { createDeterministicZip, validateZipAgainstManifest } from "./zipPackage.js";
import { buildManifest } from "./manifest.js";
import { buildIncomingQuery, buildSentQuery, computePreviousCalendarMonth, periodFromString } from "./period.js";
import { buildRunDirectory, buildRunStatePath, initializeRunState, updateRunState } from "./runState.js";
import { classifyDocuments, discoverPeriodAttachments, downloadAttachments, finalizeApprovedDocuments, mergeDownloadedAttachments } from "./gmailDiscovery.js";
import { ClassifiedDocument, InvoiceMonthlyServices, PackageStatus, PreparedEmail, SendRecord, WorkflowMode } from "./types.js";

function parseArgs(argv: string[]): { account: string; period?: string; dryRun: boolean; prepareOnly: boolean; confirmSend: boolean; forceResend: boolean; forceReclassify: boolean; ocr: boolean; } {
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

export async function runInvoiceMonthlyWorkflow(projectRoot: string, services: InvoiceMonthlyServices, argv = process.argv.slice(2)): Promise<{ status: PackageStatus; output: Record<string, unknown>; }> {
  const args = parseArgs(argv);
  const config = loadMonthlyConfig(projectRoot, args.account);
  const keywordConfig = loadKeywordConfig(projectRoot, config.accountingKeywordsFile);
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

  const incomingQuery = config.scanIncomingMail ? buildIncomingQuery(period) : null;
  const sentQuery = config.scanSentMail ? buildSentQuery(period) : null;

  if (args.dryRun) {
    return { status: "dry_run", output: { period: period.period, incomingQuery, sentQuery, accountantEmail: config.accountantEmail } };
  }

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

  const classified = await classifyDocuments({ config: { ...config, ocrEnabled: args.ocr ? config.ocrEnabled : false }, keywordConfig, uniqueDocuments: merged.uniqueDocuments, textDirectory, ocrDirectory, llmResultsDirectory, openrouter: services.openrouter });
  writeJsonAtomic(classifiedPath, classified, 0o600);
  currentState = updateRunState(statePath, currentState, { stage: "classified" });

  const finalDocuments = finalizeApprovedDocuments(classified);
  currentState = updateRunState(statePath, currentState, { stage: "approved", documentHashes: finalDocuments.approved.map((document) => document.sha256) });

  const folderTree = await services.drive.ensureMonthlyFolder(config, period);
  currentState = updateRunState(statePath, currentState, { stage: "drive_pdfs_uploaded", monthlyFolderId: folderTree.month.id, monthlyFolderUrl: folderTree.month.webViewLink });

  let drivePdfsCreated = 0;
  let drivePdfsReused = 0;
  const allDocumentsForManifest: ClassifiedDocument[] = [];

  for (const document of finalDocuments.approved) {
    const finalDecision = document.finalDecision ?? "approved_accounting_document";
    const upload = services.drive.uploadOrReusePdf
      ? await services.drive.uploadOrReusePdf({
        parentId: folderTree.approved?.id ?? folderTree.month.id,
        localPath: document.localPath,
        filename: document.safeStoredFilename,
        appProperties: {
          marianAiOs: "true",
          accountId: config.accountId,
          sha256: document.sha256,
          sourceRun: currentState.runId,
          sourcePeriod: period.period,
          packagePeriod: period.period,
          documentType: document.documentType,
          finalDecision,
        },
      })
      : await services.drive.uploadOrReuseFile!({
        parentId: folderTree.approved?.id ?? folderTree.month.id,
        localPath: document.localPath,
        filename: document.safeStoredFilename,
        mimeType: document.mimeType,
        appProperties: {
          marianAiOs: "true",
          accountId: config.accountId,
          sha256: document.sha256,
          sourceRun: currentState.runId,
          sourcePeriod: period.period,
          packagePeriod: period.period,
          documentType: document.documentType,
          finalDecision,
        },
      });
    if (upload.created) drivePdfsCreated += 1; else drivePdfsReused += 1;
    allDocumentsForManifest.push({ ...document, driveFileId: upload.file.id, driveFileUrl: upload.file.webViewLink });
  }

  for (const document of finalDocuments.reviewRequired) {
    const filename = document.safeStoredFilename ?? `${document.sha256.slice(0, 8)}.${document.fileExtension ?? "bin"}`;
    const finalDecision = document.finalDecision ?? "review_required";
    const upload = await services.drive.uploadOrReuseFile!({
      parentId: folderTree.review?.id ?? folderTree.month.id,
      localPath: document.localPath,
      filename,
      mimeType: document.mimeType,
      appProperties: {
        marianAiOs: "true",
        accountId: config.accountId,
        sha256: document.sha256,
        sourceRun: currentState.runId,
        packagePeriod: period.period,
        documentType: document.documentType,
        finalDecision,
      },
    });
    allDocumentsForManifest.push({ ...document, reviewDriveFileId: upload.file.id, reviewDriveFileUrl: upload.file.webViewLink, safeStoredFilename: filename, storedFilename: filename });
  }

  allDocumentsForManifest.push(...finalDocuments.rejected);

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
    appProperties: { marianAiOs: "true", accountId: config.accountId, resourceRole: "monthly_accounting_manifest", packagePeriod: period.period, packageVersion: String(config.packageVersion), documentCount: String(manifest.documentCount), sourceRun: currentState.runId },
  });
  await services.drive.uploadOrReplaceJson({
    parentId: folderTree.month.id,
    filename: "classification-summary.json",
    localPath: classificationSummaryPath,
    appProperties: { marianAiOs: "true", accountId: config.accountId, resourceRole: "monthly_classification_summary", packagePeriod: period.period, packageVersion: String(config.packageVersion), sourceRun: currentState.runId },
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
    appProperties: { marianAiOs: "true", accountId: config.accountId, resourceRole: "monthly_accounting_zip", packagePeriod: period.period, packageVersion: String(config.packageVersion), zipSha256: zipResult.sha256, documentCount: String(manifest.approvedDocumentCount), sourceRun: currentState.runId },
  });
  currentState = updateRunState(statePath, currentState, { stage: "zip_uploaded", zipDriveFileId: zipUpload.id, zipDriveUrl: zipUpload.webViewLink });

  const googleResourcesPath = path.join(projectRoot, "data", "google-resources", `${config.accountId}.json`);
  const googleResources = readJsonFile<any>(googleResourcesPath);
  const invoiceRegisterUrl = googleResources.resources.invoice_register.webViewLink;
  await services.sheets.ensureDocumentsSheet(googleResources.resources.invoice_register.id);
  const sheetResult = await services.sheets.upsertDocuments({
    spreadsheetId: googleResources.resources.invoice_register.id,
    sheetName: "Documents",
    monthlyFolderUrl: folderTree.month.webViewLink ?? "",
    zipPackageUrl: zipUpload.webViewLink ?? "",
    runId: currentState.runId,
    processedAt: new Date().toISOString(),
    documents: allDocumentsForManifest,
  });
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
      approvedCount: finalDocuments.approved.length,
      reviewCount: finalDocuments.reviewRequired.length,
      rejectedCount: finalDocuments.rejected.length,
    },
  };
}

export function parseWorkflowArgs(argv = process.argv.slice(2)) {
  return parseArgs(argv);
}
