import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { analyzeKeywords } from "./accountingKeywords.js";
import { matchEquisixIdentity } from "./companyIdentity.js";
import { buildClassification as buildClassificationEngine } from "../../packages/classification/src/index.js";
import { extractDocumentText } from "./pdfExtraction.js";
import { buildStoredFilename, ensureUniqueStoredFilenames } from "./filename.js";
import { ensureDirectory, safeFileExtension, sha256Hex, validateSourceFilename, writeFileAtomic } from "./fs.js";
import { normalizeCompact, normalizeForMatching } from "./textNormalization.js";
import { isInternalDateInPeriod } from "./period.js";
import {
  AttachmentSourceRef,
  ClassifiedDocument,
  CompanyRelation,
  DiscoveredAttachment,
  DownloadedAttachment,
  ExtractedParty,
  FinalApprovedDocument,
  GmailDirection,
  GmailReadService,
  GmailSourceMessage,
  InvoiceMatchType,
  KeywordConfig,
  MonthlyWorkflowConfig,
  PeriodInfo,
} from "./types.js";

const SUPPORTED_EXTENSIONS = new Set(["pdf", "jpg", "jpeg", "png", "webp", "heic", "heif"]);
const SUPPORTED_MIME_PREFIXES = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
function isSupportedAttachment(attachment: { filename: string; mimeType: string }): boolean {
  const extension = path.extname(attachment.filename).replace(/^\./, "").toLowerCase();
  return SUPPORTED_EXTENSIONS.has(extension) || SUPPORTED_MIME_PREFIXES.includes(attachment.mimeType.toLowerCase());
}

function buildSourceFingerprint(source: AttachmentSourceRef): string {
  return sha256Hex(`${source.messageId}|${source.partPath ?? ""}|${source.originalFilename}|${source.mimeType}`).slice(0, 16);
}

function parseDate(text: string): string | null {
  const match = text.match(/\b(20\d{2})[./-](\d{1,2})[./-](\d{1,2})\b/);
  if (!match) return null;
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function firstMatch(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function extractParty(text: string, labels: string[]): ExtractedParty {
  const normalized = text;
  const labelPattern = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const legalName = firstMatch(normalized, new RegExp(`(?:${labelPattern})\\s*[:\\-]?\\s*([^\\n]+)`, "i"));
  return {
    legalName,
    registrationNumber: firstMatch(normalized, /\b(?:ičo|ico|company id)\s*[:\-]?\s*([0-9 ]{6,20})/i)?.replace(/\s+/g, "") ?? null,
    taxId: firstMatch(normalized, /\b(?:dič|dic|tax id)\s*[:\-]?\s*([a-z0-9 ]{8,20})/i)?.replace(/\s+/g, "") ?? null,
    vatId: firstMatch(normalized, /\b(?:ič dph|ic dph|vat id)\s*[:\-]?\s*([a-z0-9 ]{8,24})/i)?.replace(/\s+/g, "") ?? null,
    address: firstMatch(normalized, /\b(?:adresa|address)\s*[:\-]?\s*([^\n]+)/i),
    email: firstMatch(normalized, /\b([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\b/i),
  };
}

function detectDocumentType(params: {
  text: string;
  isImage: boolean;
  extractionMethod?: string;
}): { documentType: ClassifiedDocument["documentType"]; confidence: number; reason: string } {
  const text = params.text;
  const normalized = normalizeForMatching(text);
  if (!normalized.trim()) return { documentType: "unreadable", confidence: 5, reason: "empty_text" };

  const charCount = normalized.length;
  const digitCount = (text.match(/\d/g) ?? []).length;
  const lineCount = text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  const sectionCount = [
    /\b(dodavatel|supplier)\b/i.test(normalized),
    /\b(odberatel|customer|buyer|recipient)\b/i.test(normalized),
    /\b(invoice no|invoice number|cislo faktury|čislo faktury)\b/i.test(normalized),
    /\b(ico|dic|ic dph|vat id)\b/i.test(normalized),
    /\b(total|spolu|celkom|na uhradu)\b/i.test(normalized),
  ].filter(Boolean).length;
  const hasReceiptKeywords = /\b(receipt|blok|blocek|bloček|pokladnicny doklad|pokladnicny blok|uctenka)\b/i.test(normalized);
  const hasInvoiceKeywords = /\b(faktura|faktury|invoice)\b/i.test(normalized);
  const hasReceiptTaxPatterns = /\b(dph|zaklad dane|základ dane|cena spolu)\b/i.test(normalized);
  const hasStructuredInvoiceFields = sectionCount >= 3;
  const shortOcrLikeText = charCount > 0 && charCount < 1000;
  const manyNumbers = digitCount >= 12;
  const posStyleFormatting = manyNumbers && lineCount >= 4 && sectionCount <= 1 && !hasInvoiceKeywords;
  const scanLikeReceipt =
    (params.isImage || params.extractionMethod === "ocr_image") &&
    shortOcrLikeText &&
    !hasStructuredInvoiceFields &&
    (manyNumbers || hasReceiptTaxPatterns || lineCount >= 5);

  let invoiceScore = 0;
  let receiptScore = 0;

  if (hasInvoiceKeywords) invoiceScore += 5;
  if (hasStructuredInvoiceFields) invoiceScore += 4;
  if (sectionCount >= 4) invoiceScore += 2;

  if (hasReceiptKeywords) receiptScore += 5;
  if (hasReceiptTaxPatterns) receiptScore += 3;
  if (shortOcrLikeText && !hasStructuredInvoiceFields) receiptScore += 2;
  if (posStyleFormatting) receiptScore += 3;
  if (scanLikeReceipt) receiptScore += 2;

  if (invoiceScore >= 5 && invoiceScore >= receiptScore + 1) {
    return {
      documentType: "invoice",
      confidence: Math.min(99, 65 + invoiceScore * 5),
      reason: hasInvoiceKeywords ? "invoice_keyword" : "invoice_structure",
    };
  }

  if (receiptScore >= 5 && receiptScore >= invoiceScore + 1) {
    let reason = "receipt_pos_style";
    if (hasReceiptKeywords) reason = "receipt_keyword";
    else if (hasReceiptTaxPatterns) reason = "receipt_tax_pattern";
    else if (scanLikeReceipt) reason = "receipt_short_ocr_scan";
    return {
      documentType: "receipt",
      confidence: Math.min(99, 60 + receiptScore * 5),
      reason,
    };
  }

  return {
    documentType: "other",
    confidence: 45,
    reason: invoiceScore === receiptScore ? "uncertain_mixed_signals" : "uncertain_unstructured",
  };
}

function inferRelation(identityMatches: ReturnType<typeof matchEquisixIdentity>, supplier: ExtractedParty, customer: ExtractedParty): CompanyRelation {
  const supplierName = normalizeForMatching(supplier.legalName ?? "");
  const customerName = normalizeForMatching(customer.legalName ?? "");
  if (!identityMatches.matchedFields.length) return "none";
  if (supplierName.includes("equisix")) return "supplier";
  if (customerName.includes("equisix")) return "customer";
  if (identityMatches.vatId || identityMatches.registrationNumber || identityMatches.taxId) return "recipient";
  return "uncertain";
}

function compactText(value: string | null | undefined): string {
  return normalizeCompact(value ?? "");
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const matrix = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[a.length][b.length];
}

function classifyPartyNameMatch(name: string | null | undefined, knownNames: string[]): "strong" | "partial" | "none" {
  const target = compactText(name);
  if (!target) return "none";
  const compactNames = knownNames.map((item) => compactText(item)).filter(Boolean);
  for (const known of compactNames) {
    if (target === known || target.includes(known) || known.includes(target)) return "strong";
    if (levenshteinDistance(target, known) <= 1) return "partial";
    if (target.includes("equis") || target.includes("equisi") || known.includes(target.slice(0, Math.min(target.length, 5)))) {
      return "partial";
    }
  }
  return "none";
}

function isUnknownParty(party: ExtractedParty): boolean {
  return !party.legalName && !party.registrationNumber && !party.taxId && !party.vatId;
}

function hasVisa8627Evidence(text: string): boolean {
  const normalized = normalizeForMatching(text);
  const compact = normalizeCompact(text);
  return (
    /\bvisa\b/.test(normalized) &&
    (
      /\b8627\b/.test(normalized) ||
      compact.includes("visa8627") ||
      compact.includes("card8627") ||
      compact.includes("xx8627") ||
      compact.includes("xxxx8627")
    )
  );
}

function computeDecisionConfidence(input: {
  isInvoice: boolean;
  isReceipt: boolean;
  invoiceMatchType: InvoiceMatchType;
  partialNameMatch: boolean;
  visa8627Matched: boolean;
}): number {
  if (input.isInvoice) {
    if (input.invoiceMatchType === "identity_match") return 0.97;
    if (input.invoiceMatchType === "customer_match" || input.invoiceMatchType === "supplier_match") return 0.8;
    if (input.partialNameMatch) return 0.5;
    return 0.5;
  }

  if (input.isReceipt) {
    if (input.visa8627Matched) return 0.9;
    return 0.5;
  }

  return 0.3;
}

const FUEL_VENDORS = ["shell", "omv", "slovnaft", "lukoil", "benzina"];
const FUEL_KEYWORDS = ["fuel", "diesel", "benzin", "benzin", "nafta", "tank", "cerpacia stanica", "čerpa", "phm"];
const MEAL_KEYWORDS = ["restaurant", "restauracia", "reštaurácia", "food", "meal", "obed", "vecera", "večera", "cafe", "coffee", "bistro"];
const SOFTWARE_KEYWORDS = ["software", "saas", "subscription", "licence", "license", "hosting", "domain", "cloud", "api", "openai", "google workspace", "microsoft 365"];

function detectVendor(text: string, supplier: ExtractedParty): string | null {
  const explicit =
    firstMatch(text, /\b(?:merchant|vendor|prevadzka|predajca)\s*[:\-]?\s*([^\n]+)/i) ??
    supplier.legalName ??
    null;
  const normalized = normalizeForMatching(text);
  for (const vendor of FUEL_VENDORS) {
    if (normalized.includes(vendor)) return vendor.toUpperCase();
  }
  return explicit?.trim() ?? null;
}

function classifyReceiptCategory(text: string, vendor: string | null): "fuel" | "meals" | "software" | "other" {
  const normalized = normalizeForMatching(text);
  const vendorNormalized = normalizeForMatching(vendor ?? "");
  if (FUEL_VENDORS.some((item) => vendorNormalized.includes(item)) || FUEL_KEYWORDS.some((item) => normalized.includes(normalizeForMatching(item)))) {
    return "fuel";
  }
  if (MEAL_KEYWORDS.some((item) => normalized.includes(normalizeForMatching(item)))) {
    return "meals";
  }
  if (SOFTWARE_KEYWORDS.some((item) => normalized.includes(normalizeForMatching(item)))) {
    return "software";
  }
  return "other";
}

export function buildClassification(params: {
  config: MonthlyWorkflowConfig;
  document: DownloadedAttachment;
  text: string;
  keywordConfig: KeywordConfig;
  extraction: Awaited<ReturnType<typeof extractDocumentText>>;
}): ClassifiedDocument {
  const supplier = extractParty(params.text, ["supplier", "dodavatel", "seller"]);
  const customer = extractParty(params.text, ["customer", "odberatel", "buyer", "recipient"]);
  const keywordAnalysis = analyzeKeywords({
    subject: params.document.source.subject,
    filename: params.document.source.originalFilename,
    text: params.text,
  }, params.keywordConfig);
  const identity = params.config.companyIdentity ?? {
    legalName: "Equisix s.r.o.",
    knownNames: ["Equisix s.r.o.", "Equisix"],
    companyRegistrationNumber: { value: "", labelSk: "IČO", aliases: [] },
    taxIdentificationNumber: { value: "", labelSk: "DIČ", aliases: [] },
    vatIdentificationNumber: { value: "", labelSk: "IČ DPH", aliases: [] },
    registeredAddress: { street: "", postalCode: "", city: "", country: "" },
    registeredAddressVariants: [],
    knownEmails: [],
    companyCountry: [],
    companyCreationDate: [],
    businessActivityReference: { primarySkNace: "" },
  };
  const thresholds = params.config.thresholds ?? {
    invoiceAutoApproveOverall: 90,
    invoiceAutoApproveRelation: 90,
    invoiceAutoApproveDocumentType: 90,
    receiptAutoApproveOverall: 88,
    reviewFloor: 55,
  };
  const identityMatches = matchEquisixIdentity({
    identity,
    text: params.text,
    supplier,
    customer,
  });
  const detectedType = detectDocumentType({
    text: params.text,
    isImage: params.document.isImage ?? false,
    extractionMethod: params.extraction.extractionMethod,
  });
  const documentType = detectedType.documentType;
  const companyRelation = inferRelation(identityMatches, supplier, customer);
  const normalized = normalizeForMatching(params.text);
  const compact = normalizeCompact(params.text);
  const totalAmount = firstMatch(params.text, /\b(?:total|spolu|na uhradu)\s*[:\-]?\s*([0-9]+[.,][0-9]{2})/i);
  const currency = firstMatch(params.text, /\b(EUR|CZK|USD|GBP|HUF|PLN)\b/i)?.toUpperCase() ?? null;
  const receiptNumber = firstMatch(params.text, /\b(?:receipt no|receipt number|doklad c|doklad č|pokladna)\s*[:\-]?\s*([a-z0-9\-\/]+)/i);

  const isInvoice = documentType === "invoice";
  const isReceipt = documentType === "receipt";
  const visa8627Matched = hasVisa8627Evidence(params.text);
  const identityMatched = identityMatches.legalName || identityMatches.registrationNumber || identityMatches.taxId || identityMatches.vatId;
  const supplierNameMatch = classifyPartyNameMatch(supplier.legalName, identity.knownNames);
  const customerNameMatch = classifyPartyNameMatch(customer.legalName, identity.knownNames);
  const supplierStrongMatch = supplierNameMatch === "strong";
  const customerStrongMatch = customerNameMatch === "strong";
  const partialNameMatch = supplierNameMatch === "partial" || customerNameMatch === "partial";
  const supplierUnknown = isUnknownParty(supplier);
  const customerUnknown = isUnknownParty(customer);
  const vendor = detectVendor(params.text, supplier);
  const expenseCategory = isReceipt ? classifyReceiptCategory(params.text, vendor) : undefined;

  let finalDecision: ClassifiedDocument["finalDecision"] = "rejected_non_accounting";
  let invoiceMatchType: InvoiceMatchType = "no_match";
  let resolvedCompanyRelation: CompanyRelation = companyRelation;
  const validationReasons: string[] = [];
  const rejectionReasons: string[] = [];
  const warnings = [...params.extraction.ocr.warnings];
  let documentTypeConfidence = detectedType.confidence;
  let companyRelationConfidence = 0;
  let overallConfidence = 20;
  let decisionReason = "missing_data";
  let detectionReason = detectedType.reason;
  let transactionType: "INCOME" | "EXPENSE" | undefined;

  if (params.document.unsafeSource) {
    finalDecision = "rejected_unsafe_source";
    rejectionReasons.push(params.document.unsafeReason ?? "unsafe source filename");
  } else if (documentType === "unreadable" || !normalized) {
    finalDecision = "rejected_unreadable";
    rejectionReasons.push("missing_data");
  } else if (isReceipt) {
    companyRelationConfidence = 90;
    resolvedCompanyRelation = "business_expense_candidate";
    transactionType = "EXPENSE";
    if (visa8627Matched) {
      overallConfidence = 91;
      finalDecision = "approved_accounting_document";
      decisionReason = "visa_match";
      validationReasons.push("visa_match");
    } else {
      overallConfidence = 60;
      finalDecision = "review_required";
      warnings.push("missing_data");
    }
  } else if (isInvoice) {
    if (customerStrongMatch) {
      invoiceMatchType = "customer_match";
      resolvedCompanyRelation = "customer";
      transactionType = "EXPENSE";
    } else if (supplierStrongMatch) {
      invoiceMatchType = "supplier_match";
      resolvedCompanyRelation = "supplier";
      transactionType = "INCOME";
    } else if (identityMatched) {
      invoiceMatchType = "identity_match";
      resolvedCompanyRelation = resolvedCompanyRelation === "none" ? "recipient" : resolvedCompanyRelation;
      transactionType = resolvedCompanyRelation === "supplier" ? "INCOME" : "EXPENSE";
    }

    companyRelationConfidence = invoiceMatchType === "no_match" ? 40 : 98;
    overallConfidence = Math.min(99, Math.round((documentTypeConfidence + companyRelationConfidence) / 2));
    if (customerStrongMatch) {
      finalDecision = "approved_accounting_document";
      decisionReason = "invoice_match";
      validationReasons.push("invoice_match");
    } else if (supplierStrongMatch) {
      finalDecision = "approved_accounting_document";
      decisionReason = "invoice_match";
      validationReasons.push("invoice_match");
    } else if (identityMatched) {
      finalDecision = "approved_accounting_document";
      decisionReason = "invoice_match";
      validationReasons.push("invoice_match");
    } else if (supplierUnknown && customerUnknown) {
      finalDecision = "rejected_non_accounting";
      rejectionReasons.push("missing_data");
    } else if (partialNameMatch) {
      finalDecision = "review_required";
      warnings.push("missing_data");
    } else {
      finalDecision = "review_required";
      warnings.push("missing_data");
    }
  } else {
    finalDecision = "review_required";
    warnings.push("missing_data");
  }

  const accountingRelevance = finalDecision === "approved_accounting_document"
    ? "accounting_document"
    : finalDecision === "review_required"
      ? "uncertain"
      : "non_accounting";
  const decisionConfidence = computeDecisionConfidence({
    isInvoice,
    isReceipt,
    invoiceMatchType,
    partialNameMatch,
    visa8627Matched,
  });

  const approvalStatus =
    finalDecision === "approved_accounting_document"
      ? "auto_approved"
      : finalDecision === "review_required"
        ? "auto_approved_unverified"
        : finalDecision === "rejected_unsafe_source"
          ? "failed"
          : "excluded_non_accounting";

  return buildClassificationEngine({
    config: params.config,
    document: params.document,
    text: params.text,
    keywordConfig: params.keywordConfig,
    extraction: params.extraction,
  });
  return {
    sha256: params.document.sha256,
    sourceMessages: [params.document.source],
    localPath: params.document.localPath,
    originalFilename: params.document.source.originalFilename,
    safeStoredFilename: null,
    mimeType: params.document.source.mimeType,
    sizeBytes: params.document.sizeBytes,
    fileExtension: params.document.fileExtension,
    extractionStatus: params.extraction.extractionStatus,
    extractionMethod: params.extraction.extractionMethod,
    textPath: params.extraction.textPath,
    ocrTextPath: params.extraction.ocrTextPath,
    pageCount: params.extraction.pageCount,
    keywordAnalysis,
    localAccountingScore: keywordAnalysis.matchedAccountingKeywords.length * 10 - keywordAnalysis.matchedNegativeSignals.length * 15,
    localSignals: [
      ...keywordAnalysis.matchedAccountingKeywords.map((match) => `positive:${match.keyword}:${match.field}`),
      ...keywordAnalysis.matchedNegativeSignals.map((match) => `negative:${match.keyword}:${match.field}`),
    ],
    localDecisionReason: decisionReason,
    decisionConfidence,
    documentType,
    detectionReason,
    accountingRelevance,
    approvalStatus,
    finalDecision,
    invoiceMatchType,
    transactionType,
    expenseCategory,
    vendor,
    companyRelation: resolvedCompanyRelation,
    supplier,
    customer,
    supplierName: supplier.legalName,
    supplierCompanyId: supplier.registrationNumber,
    supplierTaxId: supplier.taxId,
    supplierVatId: supplier.vatId,
    customerName: customer.legalName,
    customerCompanyId: customer.registrationNumber,
    customerTaxId: customer.taxId,
    customerVatId: customer.vatId,
    document: {
      documentNumber: firstMatch(params.text, /\b(?:invoice no|invoice number|cislo faktury|čislo faktury|doklad)\s*[:\-]?\s*([a-z0-9\-\/]+)/i),
      variableSymbol: firstMatch(params.text, /\b(?:variabilny symbol|variable symbol)\s*[:\-]?\s*([a-z0-9\-\/]+)/i),
      issueDate: parseDate(params.text),
      taxableSupplyDate: firstMatch(params.text, /\b(?:datum dodania|taxable supply date)\s*[:\-]?\s*(20\d{2}[./-]\d{1,2}[./-]\d{1,2})/i),
      dueDate: firstMatch(params.text, /\b(?:splatnost|due date)\s*[:\-]?\s*(20\d{2}[./-]\d{1,2}[./-]\d{1,2})/i),
      orderNumber: firstMatch(params.text, /\b(?:order no|objednavka)\s*[:\-]?\s*([a-z0-9\-\/]+)/i),
      receiptNumber,
      cashRegisterNumber: firstMatch(params.text, /\b(?:cash register|pokladna)\s*[:\-]?\s*([a-z0-9\-\/]+)/i),
      paymentMethod: firstMatch(params.text, /\b(?:payment method|platba)\s*[:\-]?\s*([^\n]+)/i),
    },
    documentNumber: firstMatch(params.text, /\b(?:invoice no|invoice number|cislo faktury|čislo faktury|doklad)\s*[:\-]?\s*([a-z0-9\-\/]+)/i),
    issueDate: parseDate(params.text),
    taxableSupplyDate: firstMatch(params.text, /\b(?:datum dodania|taxable supply date)\s*[:\-]?\s*(20\d{2}[./-]\d{1,2}[./-]\d{1,2})/i),
    dueDate: firstMatch(params.text, /\b(?:splatnost|due date)\s*[:\-]?\s*(20\d{2}[./-]\d{1,2}[./-]\d{1,2})/i),
    amounts: {
      subtotal: firstMatch(params.text, /\b(?:subtotal|medzisucet|zaklad)\s*[:\-]?\s*([0-9]+[.,][0-9]{2})/i),
      vatBase: null,
      vatAmount: firstMatch(params.text, /\b(?:vat|dph)\s*[:\-]?\s*([0-9]+[.,][0-9]{2})/i),
      vatRates: [...new Set(Array.from(params.text.matchAll(/\b(10|20|23)\s?%/g), (match) => match[1]))],
      totalAmount,
      currency,
    },
    subtotalAmount: firstMatch(params.text, /\b(?:subtotal|medzisucet|zaklad)\s*[:\-]?\s*([0-9]+[.,][0-9]{2})/i),
    vatAmount: firstMatch(params.text, /\b(?:vat|dph)\s*[:\-]?\s*([0-9]+[.,][0-9]{2})/i),
    totalAmount,
    currency,
    banking: {
      iban: firstMatch(compact, /\b([a-z]{2}\d{2}[a-z0-9]{10,30})\b/i),
      swift: firstMatch(params.text, /\b([A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?)\b/i),
      bankAccount: null,
    },
    identityMatches,
    confidence: overallConfidence,
    documentTypeConfidence,
    companyRelationConfidence,
    overallConfidence,
    warnings,
    validationReasons,
    rejectionReasons,
    llmResultPath: null,
    llmRetriesUsed: 0,
    storedFilename: null,
    duplicateOfSha256: null,
    driveFileId: null,
    driveFileUrl: null,
    reviewDriveFileId: null,
    reviewDriveFileUrl: null,
    zipIncluded: finalDecision === "approved_accounting_document",
    ocrUsed: Boolean(params.extraction.ocr.outputTextPath),
    ocrLanguage: params.extraction.ocr.language ?? null,
    ocrQuality: params.extraction.ocr.quality ?? null,
    providerAudit: {
      externalModelUsed: false,
      provider: null,
      model: null,
      rawDocumentSent: false,
    },
  };
}

export async function discoverPeriodAttachments(params: {
  config: MonthlyWorkflowConfig;
  period: PeriodInfo;
  gmail: GmailReadService;
  query: string;
  direction: GmailDirection;
}): Promise<{ messages: GmailSourceMessage[]; attachments: DiscoveredAttachment[] }> {
  const messages: GmailSourceMessage[] = [];
  const attachments: DiscoveredAttachment[] = [];
  let pageToken: string | null = null;

  do {
    const page = await params.gmail.listMessages(params.query, pageToken);
    for (const messageId of page.messageIds) {
      const message = await params.gmail.getMessage(messageId);
      if (!isInternalDateInPeriod(message.internalDateMs, params.period)) continue;
      message.direction = params.direction;
      messages.push(message);
      for (const attachment of message.attachments) {
        if (!isSupportedAttachment(attachment)) continue;
        attachments.push({
          source: {
            messageId: message.messageId,
            threadId: message.threadId,
            direction: params.direction,
            mailbox: message.mailbox,
            from: message.from,
            recipients: [...message.to, ...message.cc, ...message.bcc],
            subject: message.subject,
            timestampIso: message.timestampIso,
            localDate: message.localDate,
            attachmentId: attachment.attachmentId,
            originalFilename: attachment.filename || "attachment",
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          },
          packagePeriod: params.period.period,
        });
      }
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  return { messages, attachments };
}

export async function downloadAttachments(params: {
  attachments: DiscoveredAttachment[];
  gmail: GmailReadService;
  downloadDirectory: string;
}): Promise<DownloadedAttachment[]> {
  ensureDirectory(params.downloadDirectory);
  const results: DownloadedAttachment[] = [];

  for (const attachment of params.attachments) {
    const validation = validateSourceFilename(attachment.source.originalFilename);
    const extension = safeFileExtension(attachment.source.originalFilename, attachment.source.mimeType);
    const outputPath = path.join(
      params.downloadDirectory,
      `att-${attachment.source.messageId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}-${buildSourceFingerprint(attachment.source)}.${extension}`,
    );

    if (!validation.valid) {
      results.push({
        ...attachment,
        localPath: outputPath,
        normalizedFilename: path.basename(outputPath),
        isPdf: extension === "pdf",
        isImage: ["jpg", "jpeg", "png", "webp", "heic", "heif"].includes(extension),
        sha256: "",
        sizeBytes: 0,
        fileExtension: extension,
        unsafeSource: true,
        unsafeReason: validation.reason,
      });
      continue;
    }

    const data = await params.gmail.getAttachment(attachment.source.messageId, attachment.source.attachmentId);
    writeFileAtomic(outputPath, data, 0o600);
    results.push({
      ...attachment,
      localPath: outputPath,
      normalizedFilename: path.basename(outputPath),
      isPdf: extension === "pdf",
      isImage: ["jpg", "jpeg", "png", "webp", "heic", "heif"].includes(extension),
      sha256: sha256Hex(data),
      sizeBytes: data.length,
      fileExtension: extension,
      unsafeSource: false,
      unsafeReason: null,
    });
  }

  return results;
}

export function mergeDownloadedAttachments(downloaded: DownloadedAttachment[]): {
  uniqueDocuments: Array<{
    sha256: string;
    localPath: string;
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
    isPdf: boolean;
    isImage: boolean;
    fileExtension: string;
    unsafeSource: boolean;
    unsafeReason: string | null;
    sourceMessages: AttachmentSourceRef[];
    duplicateOfSha256: string | null;
  }>;
  duplicateCount: number;
  bothDirectionsCount: number;
} {
  const unsafe = downloaded.filter((item) => item.unsafeSource);
  const safe = downloaded.filter((item) => !item.unsafeSource);
  const bySha = new Map<string, DownloadedAttachment[]>();

  for (const item of safe) {
    const group = bySha.get(item.sha256) ?? [];
    group.push(item);
    bySha.set(item.sha256, group);
  }

  let duplicateCount = 0;
  let bothDirectionsCount = 0;
  const uniqueDocuments: Array<{
    sha256: string;
    localPath: string;
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
    isPdf: boolean;
    isImage: boolean;
    fileExtension: string;
    unsafeSource: boolean;
    unsafeReason: string | null;
    sourceMessages: AttachmentSourceRef[];
    duplicateOfSha256: string | null;
  }> = [...bySha.entries()].map(([sha256, group]) => {
    duplicateCount += group.length - 1;
    const directions = new Set(group.map((item) => item.source.direction));
    if (directions.size > 1) bothDirectionsCount += 1;
    return {
      sha256,
      localPath: group[0].localPath,
      originalFilename: group[0].source.originalFilename,
      mimeType: group[0].source.mimeType,
      sizeBytes: group[0].sizeBytes,
      isPdf: group[0].isPdf,
      isImage: group[0].isImage ?? false,
      fileExtension: group[0].fileExtension ?? "bin",
      unsafeSource: false,
      unsafeReason: null,
      sourceMessages: group.map((item) => item.source),
      duplicateOfSha256: group.length > 1 ? sha256 : null,
    };
  });

  for (const item of unsafe) {
    uniqueDocuments.push({
      sha256: `unsafe:${createHash("sha256").update(`${item.source.messageId}:${item.source.originalFilename}`).digest("hex")}`,
      localPath: item.localPath,
      originalFilename: item.source.originalFilename,
      mimeType: item.source.mimeType,
      sizeBytes: 0,
      isPdf: item.isPdf,
      isImage: item.isImage ?? false,
      fileExtension: item.fileExtension ?? "bin",
      unsafeSource: true,
      unsafeReason: item.unsafeReason ?? null,
      sourceMessages: [item.source],
      duplicateOfSha256: null,
    });
  }

  return { uniqueDocuments, duplicateCount, bothDirectionsCount };
}

export async function classifyDocuments(params: {
  config: MonthlyWorkflowConfig;
  keywordConfig: KeywordConfig;
  uniqueDocuments: ReturnType<typeof mergeDownloadedAttachments>["uniqueDocuments"];
  textDirectory: string;
  ocrDirectory: string;
  llmResultsDirectory: string;
  openrouter: import("./types.js").OpenRouterService;
}): Promise<ClassifiedDocument[]> {
  const results: ClassifiedDocument[] = [];
  ensureDirectory(params.textDirectory);
  ensureDirectory(params.ocrDirectory);
  ensureDirectory(params.llmResultsDirectory);

  for (const item of params.uniqueDocuments) {
    const extraction = await extractDocumentText({
      sha256: item.sha256,
      localPath: item.localPath,
      textDirectory: params.textDirectory,
      ocrDirectory: params.ocrDirectory,
      isPdf: item.isPdf,
      isImage: item.isImage ?? false,
      ocrEnabled: params.config.ocrEnabled ?? true,
      ocrLanguages: params.config.ocrLanguages ?? ["slk", "ces", "eng"],
    });
    const text = extraction.textPath && fs.existsSync(extraction.textPath)
      ? fs.readFileSync(extraction.textPath, "utf8")
      : extraction.ocrTextPath && fs.existsSync(extraction.ocrTextPath)
        ? fs.readFileSync(extraction.ocrTextPath, "utf8")
        : extraction.pageTexts.map((page) => page.text).join("\n\n");
    const classified = buildClassification({
      config: params.config,
      document: {
        packagePeriod: params.config.accountId,
        source: item.sourceMessages[0],
        localPath: item.localPath,
        normalizedFilename: path.basename(item.localPath),
        isPdf: item.isPdf,
        isImage: item.isImage ?? false,
        sha256: item.sha256,
        sizeBytes: item.sizeBytes,
        fileExtension: item.fileExtension ?? "bin",
        unsafeSource: item.unsafeSource ?? false,
        unsafeReason: item.unsafeReason ?? null,
      },
      text,
      keywordConfig: params.keywordConfig,
      extraction,
    });
    classified.sourceMessages = item.sourceMessages;
    classified.duplicateOfSha256 = item.duplicateOfSha256;
    results.push(classified);
  }

  return results;
}

export function finalizeApprovedDocuments(classified: ClassifiedDocument[]): {
  approved: FinalApprovedDocument[];
  reviewRequired: ClassifiedDocument[];
  rejected: ClassifiedDocument[];
  excludedCount: number;
  unverifiedCount: number;
} {
  const approved = classified
    .filter((document) => document.finalDecision === "approved_accounting_document")
    .map((document) => ({
      ...document,
      safeStoredFilename: buildStoredFilename(document),
      zipIncluded: true as const,
    })) satisfies FinalApprovedDocument[];

  const uniqueApproved = ensureUniqueStoredFilenames(approved);
  return {
    approved: uniqueApproved,
    reviewRequired: classified.filter((document) => document.finalDecision === "review_required"),
    rejected: classified.filter((document) => !["approved_accounting_document", "review_required"].includes(document.finalDecision ?? "rejected_non_accounting")),
    excludedCount: classified.length - uniqueApproved.length,
    unverifiedCount: classified.filter((document) => document.finalDecision === "review_required").length,
  };
}
