import { ClassifiedDocument, ManifestDocumentRecord, ManifestFile, MonthlyWorkflowConfig } from "./types.js";

export function buildManifest(params: {
  config: MonthlyWorkflowConfig;
  period: string;
  duplicateCount: number;
  excludedCount: number;
  documents: ClassifiedDocument[];
  generatedAt?: string;
}): ManifestFile {
  const documents: ManifestDocumentRecord[] = params.documents.map((document) => ({
    sha256: document.sha256,
    originalFilename: document.originalFilename,
    safeStoredFilename: document.safeStoredFilename ?? null,
    storedFilename: document.safeStoredFilename ?? document.storedFilename ?? null,
    sourceMailbox: [...new Set(document.sourceMessages.map((source) => source.mailbox))],
    gmailMessageIds: [...new Set(document.sourceMessages.map((source) => source.messageId))],
    gmailThreadIds: [...new Set(document.sourceMessages.map((source) => source.threadId).filter((value): value is string => Boolean(value)))],
    gmailDirections: [...new Set(document.sourceMessages.map((source) => source.direction))],
    gmailSender: document.sourceMessages[0]?.from ?? "",
    gmailRecipients: [...new Set(document.sourceMessages.flatMap((source) => source.recipients))],
    gmailSubject: document.sourceMessages[0]?.subject ?? "",
    gmailTimestamp: document.sourceMessages[0]?.timestampIso ?? "",
    sourceMessages: document.sourceMessages,
    mimeType: document.mimeType,
    extractionMethod: document.extractionMethod ?? "extraction_failed",
    extractionStatus: document.extractionStatus,
    ocrUsed: document.ocrUsed ?? false,
    ocrLanguage: document.ocrLanguage ?? null,
    ocrQuality: document.ocrQuality ?? null,
    documentType: document.documentType,
    companyRelation: document.companyRelation ?? "none",
    matchedEquisixIdentityFields: document.identityMatches?.matchedFields ?? [],
    supplier: document.supplier ?? { legalName: null, registrationNumber: null, taxId: null, vatId: null, address: null, email: null },
    customer: document.customer ?? { legalName: null, registrationNumber: null, taxId: null, vatId: null, address: null, email: null },
    document: document.document ?? { documentNumber: null, variableSymbol: null, issueDate: null, taxableSupplyDate: null, dueDate: null, orderNumber: null, receiptNumber: null, cashRegisterNumber: null, paymentMethod: null },
    amounts: document.amounts ?? { subtotal: null, vatBase: null, vatAmount: null, vatRates: [], totalAmount: null, currency: null },
    banking: document.banking ?? { iban: null, swift: null, bankAccount: null },
    documentTypeConfidence: document.documentTypeConfidence ?? 0,
    companyRelationConfidence: document.companyRelationConfidence ?? 0,
    overallConfidence: document.overallConfidence ?? document.confidence,
    finalDecision: document.finalDecision ?? "rejected_non_accounting",
    validationReasons: document.validationReasons ?? [],
    rejectionReasons: document.rejectionReasons ?? [],
    warnings: document.warnings,
    driveFileId: document.driveFileId ?? document.reviewDriveFileId ?? null,
    driveFileUrl: document.driveFileUrl ?? document.reviewDriveFileUrl ?? null,
    zipIncluded: document.zipIncluded ?? false,
    matchedAccountingKeywords: [...new Set(document.keywordAnalysis.matchedAccountingKeywords.map((match) => match.keyword))],
  }));

  return {
    packagePeriod: params.period,
    packageVersion: params.config.packageVersion,
    classificationVersion: params.config.packageVersion,
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    sourceMailbox: params.config.sourceEmail,
    senderEmail: params.config.senderEmail,
    recipientEmail: params.config.accountantEmail,
    documentCount: documents.length,
    approvedDocumentCount: documents.filter((document) => document.finalDecision === "approved_accounting_document").length,
    reviewRequiredCount: documents.filter((document) => document.finalDecision === "review_required").length,
    rejectedDocumentCount: documents.filter((document) => document.finalDecision.startsWith("rejected_")).length,
    duplicateCount: params.duplicateCount,
    excludedDocumentCount: params.excludedCount,
    documents,
  };
}
