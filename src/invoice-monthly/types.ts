export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type WorkflowMode =
  | "scheduled"
  | "dry_run"
  | "prepare_only"
  | "confirmed_send";

export type RunStage =
  | "initialized"
  | "incoming_gmail_discovered"
  | "sent_gmail_discovered"
  | "source_sets_merged"
  | "attachments_downloaded"
  | "duplicates_resolved"
  | "keyword_signals_extracted"
  | "locally_extracted"
  | "classified"
  | "approved"
  | "drive_pdfs_uploaded"
  | "manifest_created"
  | "manifest_uploaded"
  | "zip_created"
  | "zip_validated"
  | "zip_uploaded"
  | "sheet_updated"
  | "email_prepared"
  | "email_sent"
  | "completed";

export type GmailDirection = "incoming" | "sent";

export type ExtractionStatus =
  | "text_extracted"
  | "needs_ocr"
  | "encrypted_pdf"
  | "parse_failed"
  | "invalid_pdf"
  | "ocr_succeeded"
  | "mixed_extraction"
  | "ocr_unavailable";

export type ExtractionMethod =
  | "native_pdf_text"
  | "ocr_pdf"
  | "ocr_image"
  | "mixed_native_and_ocr"
  | "extraction_failed";

export type DocumentType =
  | "invoice"
  | "tax_document"
  | "billing_document"
  | "accounting_document"
  | "tax_invoice"
  | "credit_note"
  | "debit_note"
  | "proforma_invoice"
  | "receipt"
  | "fiscal_receipt"
  | "cash_register_receipt"
  | "proof_of_purchase"
  | "other_formal_accounting_document"
  | "contract"
  | "amendment"
  | "withdrawal_form"
  | "terms_and_conditions"
  | "price_list"
  | "brochure"
  | "offer"
  | "quotation"
  | "order_confirmation"
  | "delivery_tracking"
  | "newsletter"
  | "account_notification"
  | "booking_information"
  | "internal_memo"
  | "generic_correspondence"
  | "legal_document_unrelated_to_accounting"
  | "other"
  | "uncertain"
  | "unreadable"
  | "encrypted";

export type AccountingRelevance =
  | "accounting_document"
  | "non_accounting"
  | "uncertain";

export type FinalDecision =
  | "approved_accounting_document"
  | "review_required"
  | "rejected_non_accounting"
  | "rejected_wrong_company"
  | "rejected_unreadable"
  | "rejected_unsafe_source";

export type SecondPassRoute =
  | "APPROVED"
  | "REVIEW_REQUIRED"
  | "REJECTED";

export type CompanyRelation =
  | "supplier"
  | "issuer"
  | "seller"
  | "customer"
  | "buyer"
  | "recipient"
  | "billed_party"
  | "taxable_party"
  | "credit_note_recipient"
  | "credit_note_issuer"
  | "business_expense_candidate"
  | "none"
  | "uncertain";

export type InvoiceMatchType =
  | "customer_match"
  | "supplier_match"
  | "identity_match"
  | "no_match";

export type TransactionType =
  | "INCOME"
  | "EXPENSE";

export type ExpenseCategory =
  | "fuel"
  | "meals"
  | "software"
  | "other";

export type ApprovalStatus =
  | "auto_approved"
  | "auto_approved_unverified"
  | "excluded_non_accounting"
  | "excluded_duplicate"
  | "failed";

export type PackageStatus =
  | "prepared"
  | "already_sent"
  | "sent"
  | "dry_run"
  | "failed";

export type CompanyIdentityConfig = {
  legalName: string;
  knownNames: string[];
  companyRegistrationNumber: {
    value: string;
    labelSk: string;
    aliases: string[];
  };
  taxIdentificationNumber: {
    value: string;
    labelSk: string;
    aliases: string[];
  };
  vatIdentificationNumber: {
    value: string;
    labelSk: string;
    aliases: string[];
  };
  registeredAddress: {
    street: string;
    postalCode: string;
    city: string;
    country: string;
  };
  registeredAddressVariants: string[];
  knownEmails: string[];
  companyCountry: string[];
  companyCreationDate: string[];
  businessActivityReference: {
    primarySkNace: string;
  };
};

export type WorkflowThresholds = {
  invoiceAutoApproveOverall: number;
  invoiceAutoApproveRelation: number;
  invoiceAutoApproveDocumentType: number;
  receiptAutoApproveOverall: number;
  reviewFloor: number;
};

export type ClassificationRulesConfig = {
  invoiceKeywords: string[];
  receiptKeywords: string[];
  receiptTaxPatterns: string[];
  fuelVendors: string[];
  fuelKeywords: string[];
  mealKeywords: string[];
  softwareKeywords: string[];
  visaLast4: string;
  fuzzyNameDistance: number;
  shortReceiptTextThreshold: number;
};

export type MonthlyWorkflowConfig = {
  accountId: string;
  sourceEmail: string;
  senderEmail: string;
  accountantEmail: string;
  timezone: string;
  scheduleDay: number;
  scheduleTime: string;
  googleConnectionId: string;
  scanIncomingMail: boolean;
  scanSentMail: boolean;
  accountingKeywordsFile: string;
  openrouterModel: string;
  driveRootName: string;
  driveAccountingFolder: string;
  driveInvoicesFolder: string;
  invoiceRegisterName: string;
  highRecall: boolean;
  automaticDocumentApproval: boolean;
  automaticMonthlyEmailSend: boolean;
  includeManifestInZip: boolean;
  alwaysIncludeMonthlyDriveFolderLink: boolean;
  alwaysIncludeZipDriveLink: boolean;
  zipNameTemplate: string;
  gmailAttachmentLimitBytes: number;
  packageVersion: number;
  companyIdentity?: CompanyIdentityConfig;
  thresholds?: WorkflowThresholds;
  ocrEnabled?: boolean;
  ocrLanguages?: string[];
  allowExternalModelsForDocuments?: boolean;
  classification?: ClassificationRulesConfig;
};

export type PeriodInfo = {
  period: string;
  year: number;
  month: number;
  startDate: string;
  endExclusiveDate: string;
  queryAfter: string;
  queryBefore: string;
  timezone: string;
};

export type KeywordConfig = {
  positiveKeywords: Record<string, string[]>;
  supportingSignals: string[];
  negativeKeywords: string[];
};

export type GmailAttachmentRef = {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number | null;
  partPath: string;
};

export type GmailSourceMessage = {
  messageId: string;
  threadId: string | null;
  internalDateMs: number;
  localDate: string;
  timestampIso: string;
  direction: GmailDirection;
  mailbox: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  attachments: GmailAttachmentRef[];
};

export type AttachmentSourceRef = {
  messageId: string;
  threadId: string | null;
  direction: GmailDirection;
  mailbox: string;
  from: string;
  recipients: string[];
  subject: string;
  timestampIso: string;
  localDate: string;
  attachmentId: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number | null;
  partPath?: string;
};

export type DiscoveredAttachment = {
  source: AttachmentSourceRef;
  packagePeriod: string;
};

export type DownloadedAttachment = DiscoveredAttachment & {
  localPath: string;
  normalizedFilename: string;
  isPdf: boolean;
  isImage?: boolean;
  sha256: string;
  sizeBytes: number;
  fileExtension?: string;
  unsafeSource?: boolean;
  unsafeReason?: string | null;
};

export type KeywordMatch = {
  category: string;
  keyword: string;
  field: "subject" | "filename" | "text";
};

export type SignalMatch = {
  keyword: string;
  field: "subject" | "filename" | "text";
};

export type NegativeMatch = {
  keyword: string;
  field: "subject" | "filename" | "text";
};

export type KeywordAnalysis = {
  matchedAccountingKeywords: KeywordMatch[];
  matchedSupportingSignals: SignalMatch[];
  matchedNegativeSignals: NegativeMatch[];
};

export type OcrResult = {
  provider: "local_tesseract" | "none";
  language: string | null;
  quality: "high" | "medium" | "low" | "failed";
  outputTextPath: string | null;
  warnings: string[];
  available: boolean;
};

export type LocalExtractionResult = {
  extractionStatus: ExtractionStatus;
  extractionMethod: ExtractionMethod;
  pageCount: number | null;
  textPath: string | null;
  ocrTextPath: string | null;
  extractedCharacterCount: number;
  normalizedText: string;
  pageTexts: Array<{ pageNumber: number; source: "native" | "ocr"; text: string }>;
  error: string | null;
  ocr: OcrResult;
};

export type OpenRouterExtractionResult = {
  documentType: DocumentType;
  accountingRelevance: AccountingRelevance;
  supplierName: string | null;
  supplierCompanyId: string | null;
  supplierTaxId: string | null;
  supplierVatId: string | null;
  customerName: string | null;
  customerCompanyId: string | null;
  customerTaxId: string | null;
  customerVatId: string | null;
  documentNumber: string | null;
  issueDate: string | null;
  dueDate: string | null;
  taxableSupplyDate: string | null;
  subtotalAmount: string | null;
  vatAmount: string | null;
  totalAmount: string | null;
  currency: string | null;
  confidence: number;
  warnings: string[];
  evidenceFragments: string[];
  retriesUsed: number;
  provider: string | null;
};

export type ExtractedParty = {
  legalName: string | null;
  registrationNumber: string | null;
  taxId: string | null;
  vatId: string | null;
  address: string | null;
  email: string | null;
};

export type AmountFields = {
  subtotal: string | null;
  vatBase: string | null;
  vatAmount: string | null;
  vatRates: string[];
  totalAmount: string | null;
  currency: string | null;
};

export type BankingFields = {
  iban: string | null;
  swift: string | null;
  bankAccount: string | null;
};

export type DocumentFields = {
  documentNumber: string | null;
  variableSymbol: string | null;
  issueDate: string | null;
  taxableSupplyDate: string | null;
  dueDate: string | null;
  orderNumber: string | null;
  receiptNumber: string | null;
  cashRegisterNumber: string | null;
  paymentMethod: string | null;
};

export type IdentityMatchSummary = {
  legalName: boolean;
  registrationNumber: boolean;
  taxId: boolean;
  vatId: boolean;
  address: boolean;
  email: boolean;
  matchedFields: string[];
};

export type ClassifiedDocument = {
  sha256: string;
  sourceMessages: AttachmentSourceRef[];
  localPath: string;
  originalFilename: string;
  safeStoredFilename?: string | null;
  mimeType: string;
  sizeBytes: number;
  fileExtension?: string;
  extractionStatus: ExtractionStatus;
  extractionMethod?: ExtractionMethod;
  textPath: string | null;
  ocrTextPath?: string | null;
  pageCount?: number | null;
  keywordAnalysis: KeywordAnalysis;
  localAccountingScore: number;
  localSignals: string[];
  localDecisionReason: string;
  decisionConfidence?: number;
  documentType: DocumentType;
  detectionReason?: string;
  accountingRelevance: AccountingRelevance;
  approvalStatus: ApprovalStatus;
  finalDecision?: FinalDecision;
  invoiceMatchType?: InvoiceMatchType;
  transactionType?: TransactionType;
  expenseCategory?: ExpenseCategory;
  vendor?: string | null;
  companyRelation?: CompanyRelation;
  supplier?: ExtractedParty;
  customer?: ExtractedParty;
  supplierName?: string | null;
  supplierCompanyId?: string | null;
  supplierTaxId?: string | null;
  supplierVatId?: string | null;
  customerName?: string | null;
  customerCompanyId?: string | null;
  customerTaxId?: string | null;
  customerVatId?: string | null;
  document?: DocumentFields;
  documentNumber?: string | null;
  issueDate?: string | null;
  taxableSupplyDate?: string | null;
  dueDate?: string | null;
  amounts?: AmountFields;
  subtotalAmount?: string | null;
  vatAmount?: string | null;
  totalAmount?: string | null;
  currency?: string | null;
  banking?: BankingFields;
  identityMatches?: IdentityMatchSummary;
  confidence: number;
  documentTypeConfidence?: number;
  companyRelationConfidence?: number;
  overallConfidence?: number;
  warnings: string[];
  validationReasons?: string[];
  rejectionReasons?: string[];
  llmResultPath: string | null;
  llmRetriesUsed: number;
  storedFilename?: string | null;
  duplicateOfSha256?: string | null;
  driveFileId?: string | null;
  driveFileUrl?: string | null;
  reviewDriveFileId?: string | null;
  reviewDriveFileUrl?: string | null;
  zipIncluded?: boolean;
  ocrUsed?: boolean;
  ocrLanguage?: string | null;
  ocrQuality?: string | null;
  providerAudit?: {
    externalModelUsed: boolean;
    provider: string | null;
    model: string | null;
    rawDocumentSent: boolean;
  };
};

export type FinalApprovedDocument = ClassifiedDocument & {
  safeStoredFilename: string;
  zipIncluded: true;
};

export type CleanupMoveRecord = {
  sourceRunId: string | null;
  driveFileId: string;
  originalFilename: string;
  mimeType: string;
  originalParentFolderId: string | null;
  destinationFolderId: string;
  originalDriveUrl: string | null;
  cleanupAction: "move";
  cleanupTimestamp: string;
  sha256: string | null;
  reason: "reclassification_with_ocr_and_company_validation";
};

export type RunState = {
  runId: string;
  accountId: string;
  period: string;
  mode: WorkflowMode;
  stage: RunStage;
  startedAt: string;
  updatedAt: string;
  preparedEmailPath: string | null;
  monthlyFolderId: string | null;
  monthlyFolderUrl: string | null;
  manifestPath: string | null;
  manifestDriveFileId: string | null;
  manifestDriveUrl: string | null;
  zipPath: string | null;
  zipSha256: string | null;
  zipBytes: number | null;
  zipDriveFileId: string | null;
  zipDriveUrl: string | null;
  invoiceRegisterUrl: string | null;
  emailMessageId: string | null;
  emailSentAt: string | null;
  documentHashes: string[];
  forcedResend: boolean;
};

export type AuditSummary = {
  runId: string;
  packageVersion: number;
  accountId: string;
  sourceMailbox: string;
  sender: string;
  recipient: string;
  packagePeriod: string;
  timezone: string;
  startTimestamp: string;
  endTimestamp: string | null;
  incomingQuery: string | null;
  sentQuery: string | null;
  incomingDiscoveredMessageCount: number;
  sentDiscoveredMessageCount: number;
  mergedUniqueMessageCount: number;
  downloadedPdfCount: number;
  incomingPdfCount: number;
  sentPdfCount: number;
  foundInBothDirectionsCount: number;
  validPdfCount: number;
  uniquePdfCount: number;
  duplicateCount: number;
  includedDocumentCount: number;
  excludedDocumentCount: number;
  unverifiedDocumentCount: number;
  matchedAccountingKeywordTotals: number;
  matchedSupportingSignalTotals: number;
  matchedNegativeSignalTotals: number;
  classificationFailures: number;
  extractionFailures: number;
  openrouterModelRequested: string;
  openrouterProviderReturned: string | null;
  openrouterRetries: number;
  drivePdfsCreated: number;
  drivePdfsReused: number;
  manifestDriveId: string | null;
  manifestDriveUrl: string | null;
  sheetRowsAppended: number;
  sheetRowsUpdated: number;
  zipLocalPath: string | null;
  zipByteSize: number | null;
  zipSha256: string | null;
  zipDriveId: string | null;
  zipDriveUrl: string | null;
  monthlyFolderDriveId: string | null;
  monthlyFolderDriveUrl: string | null;
  invoiceRegisterUrl: string | null;
  emailAttachmentIncluded: boolean;
  emailDriveFolderLinkIncluded: boolean;
  gmailSentMessageId: string | null;
  emailSentTimestamp: string | null;
  forceResend: boolean;
  finalStatus: PackageStatus | "running";
  errorSummary: string | null;
};

export type ManifestDocumentRecord = {
  sha256: string;
  originalFilename: string;
  safeStoredFilename?: string | null;
  storedFilename: string | null;
  sourceMailbox: string[];
  gmailMessageIds: string[];
  gmailThreadIds: string[];
  gmailDirections: GmailDirection[];
  gmailSender: string;
  gmailRecipients: string[];
  gmailSubject: string;
  gmailTimestamp: string;
  sourceMessages: AttachmentSourceRef[];
  mimeType: string;
  extractionMethod: ExtractionMethod;
  extractionStatus: ExtractionStatus;
  ocrUsed: boolean;
  ocrLanguage: string | null;
  ocrQuality: string | null;
  documentType: DocumentType;
  companyRelation: CompanyRelation;
  matchedEquisixIdentityFields: string[];
  supplier: ExtractedParty;
  customer: ExtractedParty;
  document: DocumentFields;
  amounts: AmountFields;
  banking: BankingFields;
  documentTypeConfidence: number;
  companyRelationConfidence: number;
  overallConfidence: number;
  finalDecision: FinalDecision;
  validationReasons: string[];
  rejectionReasons: string[];
  warnings: string[];
  driveFileId: string | null;
  driveFileUrl: string | null;
  zipIncluded: boolean;
  matchedAccountingKeywords?: string[];
};

export type ManifestFile = {
  packagePeriod: string;
  packageVersion: number;
  classificationVersion: number;
  generatedAt: string;
  sourceMailbox: string;
  senderEmail: string;
  recipientEmail: string;
  documentCount: number;
  approvedDocumentCount: number;
  reviewRequiredCount: number;
  rejectedDocumentCount: number;
  duplicateCount: number;
  excludedDocumentCount: number;
  documents: ManifestDocumentRecord[];
};

export type PreparedEmail = {
  idempotencyKey: string;
  to: string;
  from: string;
  subject: string;
  textBody: string;
  attachZip: boolean;
  zipPath: string;
  zipFilename: string;
};

export type SendRecord = {
  idempotencyKey: string;
  packagePeriod: string;
  accountId: string;
  recipient: string;
  sender: string;
  gmailMessageId: string;
  sentAt: string;
  zipSha256: string;
  monthlyFolderId: string;
  zipDriveId: string;
  documentHashes: string[];
  packageVersion: number;
  forceResend: boolean;
};

export type InvoiceMonthlyServices = {
  gmailRead: GmailReadService;
  drive: DriveService;
  sheets: SheetsService;
  openrouter: OpenRouterService;
  gmailSend: GmailSendService | null;
};

export type GmailMessageListPage = {
  messageIds: string[];
  nextPageToken: string | null;
};

export type GmailReadService = {
  getProfileEmail(): Promise<string>;
  listMessages(query: string, pageToken?: string | null): Promise<GmailMessageListPage>;
  getMessage(messageId: string): Promise<GmailSourceMessage>;
  getAttachment(messageId: string, attachmentId: string): Promise<Buffer>;
};

export type DriveFileRecord = {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string | null;
  appProperties: Record<string, string>;
  parents: string[];
};

export type DriveFolderTree = {
  accountRoot: DriveFileRecord;
  accounting: DriveFileRecord;
  invoices: DriveFileRecord;
  year: DriveFileRecord;
  month: DriveFileRecord;
  approved?: DriveFileRecord;
  review?: DriveFileRecord;
  previousRunUnverified?: DriveFileRecord;
};

export type DriveService = {
  getAuthorizedEmail(): Promise<string>;
  ensureMonthlyFolder(config: MonthlyWorkflowConfig, period: PeriodInfo): Promise<DriveFolderTree>;
  ensureChildFolder?(name: string, parentId: string, appProperties: Record<string, string>): Promise<DriveFileRecord>;
  findFileByAppProperties(parentId: string, appProperties: Record<string, string>): Promise<DriveFileRecord | null>;
  listFiles?(parentId: string): Promise<DriveFileRecord[]>;
  getFile?(fileId: string): Promise<DriveFileRecord | null>;
  moveFile?(fileId: string, addParentId: string, removeParentIds: string[]): Promise<DriveFileRecord>;
  uploadOrReusePdf?(input: {
    parentId: string;
    localPath: string;
    filename: string;
    appProperties: Record<string, string>;
  }): Promise<{ file: DriveFileRecord; created: boolean }>;
  uploadOrReuseFile?(input: {
    parentId: string;
    localPath: string;
    filename: string;
    mimeType: string;
    appProperties: Record<string, string>;
  }): Promise<{ file: DriveFileRecord; created: boolean }>;
  uploadOrReplaceJson(input: {
    parentId: string;
    filename: string;
    localPath: string;
    appProperties: Record<string, string>;
  }): Promise<DriveFileRecord>;
  uploadOrReplaceBinary(input: {
    parentId: string;
    filename: string;
    localPath: string;
    mimeType: string;
    appProperties: Record<string, string>;
  }): Promise<DriveFileRecord>;
};

export type SheetsService = {
  ensureDocumentsSheet(spreadsheetId: string): Promise<void>;
  upsertDocuments(params: {
    spreadsheetId: string;
    sheetName: string;
    monthlyFolderUrl: string;
    zipPackageUrl: string;
    runId: string;
    processedAt: string;
    documents: ClassifiedDocument[];
  }): Promise<{ appended: number; updated: number }>;
};

export type OpenRouterService = {
  extractDocument(params: {
    config: MonthlyWorkflowConfig;
    document: DownloadedAttachment;
    text: string;
    matchedAccountingKeywords: string[];
    matchedSupportingSignals: string[];
    matchedNegativeSignals: string[];
    outputPath: string;
  }): Promise<OpenRouterExtractionResult>;
};

export type GmailSendService = {
  getProfileEmail(): Promise<string>;
  sendPreparedEmail(email: PreparedEmail): Promise<{ id: string }>;
};
