import { analyzeKeywords } from "../../../src/invoice-monthly/accountingKeywords.js";
import { matchEquisixIdentity } from "../../../src/invoice-monthly/companyIdentity.js";
import { normalizeCompact, normalizeForMatching } from "../../../src/invoice-monthly/textNormalization.js";
import {
  ClassifiedDocument,
  CompanyRelation,
  DownloadedAttachment,
  ExtractedParty,
  InvoiceMatchType,
  KeywordConfig,
  MonthlyWorkflowConfig,
} from "../../../src/invoice-monthly/types.js";

function firstMatch(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function parseDate(text: string): string | null {
  const match = text.match(/\b(20\d{2})[./-](\d{1,2})[./-](\d{1,2})\b/);
  if (!match) return null;
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function extractParty(text: string, labels: string[]): ExtractedParty {
  const labelPattern = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const legalName = firstMatch(text, new RegExp(`(?:${labelPattern})\\s*[:\\-]?\\s*([^\\n]+)`, "i"));
  return {
    legalName,
    registrationNumber: firstMatch(text, /\b(?:ičo|ico|company id)\s*[:\-]?\s*([0-9 ]{6,20})/i)?.replace(/\s+/g, "") ?? null,
    taxId: firstMatch(text, /\b(?:dič|dic|tax id)\s*[:\-]?\s*([a-z0-9 ]{8,20})/i)?.replace(/\s+/g, "") ?? null,
    vatId: firstMatch(text, /\b(?:ič dph|ic dph|vat id)\s*[:\-]?\s*([a-z0-9 ]{8,24})/i)?.replace(/\s+/g, "") ?? null,
    address: firstMatch(text, /\b(?:adresa|address)\s*[:\-]?\s*([^\n]+)/i),
    email: firstMatch(text, /\b([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\b/i),
  };
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

function classificationRules(config: MonthlyWorkflowConfig) {
  return config.classification ?? {
    invoiceKeywords: ["faktura", "invoice"],
    receiptKeywords: ["blok", "pokladnicny doklad", "receipt"],
    receiptTaxPatterns: ["dph", "zaklad dane", "základ dane", "cena spolu"],
    fuelVendors: ["shell", "omv", "slovnaft", "lukoil", "benzina"],
    fuelKeywords: ["fuel", "diesel", "benzin", "nafta", "tank", "cerpacia stanica", "phm"],
    mealKeywords: ["restaurant", "restauracia", "food", "meal", "obed", "vecera", "cafe", "coffee", "bistro"],
    softwareKeywords: ["software", "saas", "subscription", "licence", "license", "hosting", "domain", "cloud", "api"],
    visaLast4: "8627",
    fuzzyNameDistance: 1,
    shortReceiptTextThreshold: 1000,
  };
}

export function detectDocumentType(params: {
  text: string;
  isImage: boolean;
  extractionMethod?: string;
  config: MonthlyWorkflowConfig;
}): { documentType: ClassifiedDocument["documentType"]; confidence: number; reason: string } {
  const text = params.text;
  const normalized = normalizeForMatching(text);
  const rules = classificationRules(params.config);
  if (!normalized.trim()) return { documentType: "unreadable", confidence: 5, reason: "empty_text" };

  const invoiceRegex = new RegExp(`\\b(${rules.invoiceKeywords.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
  const receiptRegex = new RegExp(`\\b(${rules.receiptKeywords.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
  const receiptTaxRegex = new RegExp(`\\b(${rules.receiptTaxPatterns.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");

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
  const hasReceiptKeywords = receiptRegex.test(normalized);
  const hasInvoiceKeywords = invoiceRegex.test(normalized);
  const hasReceiptTaxPatterns = receiptTaxRegex.test(normalized);
  const hasStructuredInvoiceFields = sectionCount >= 3;
  const shortOcrLikeText = charCount > 0 && charCount < rules.shortReceiptTextThreshold;
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

function classifyPartyNameMatch(name: string | null | undefined, knownNames: string[], maxDistance: number): "strong" | "partial" | "none" {
  const target = compactText(name);
  if (!target) return "none";
  const compactNames = knownNames.map((item) => compactText(item)).filter(Boolean);
  for (const known of compactNames) {
    if (target === known || target.includes(known) || known.includes(target)) return "strong";
    if (levenshteinDistance(target, known) <= maxDistance) return "partial";
    if (target.includes("equis") || target.includes("equisi") || known.includes(target.slice(0, Math.min(target.length, 5)))) return "partial";
  }
  return "none";
}

function isUnknownParty(party: ExtractedParty): boolean {
  return !party.legalName && !party.registrationNumber && !party.taxId && !party.vatId;
}

export function hasVisaEvidence(text: string, config: MonthlyWorkflowConfig): boolean {
  const normalized = normalizeForMatching(text);
  const compact = normalizeCompact(text);
  const last4 = classificationRules(config).visaLast4;
  return /\bvisa\b/.test(normalized)
    && (new RegExp(`\\b${last4}\\b`).test(normalized)
      || compact.includes(`visa${last4}`)
      || compact.includes(`card${last4}`)
      || compact.includes(`xx${last4}`)
      || compact.includes(`xxxx${last4}`));
}

function computeDecisionConfidence(input: {
  isInvoice: boolean;
  isReceipt: boolean;
  invoiceMatchType: InvoiceMatchType;
  partialNameMatch: boolean;
  visaMatched: boolean;
  vendorReceiptMatched: boolean;
  rejected: boolean;
}): number {
  if (input.rejected) return 0.95;
  if (input.isInvoice) {
    if (input.invoiceMatchType === "identity_match") return 0.97;
    if (input.invoiceMatchType === "customer_match" || input.invoiceMatchType === "supplier_match") return 0.92;
    if (input.partialNameMatch) return 0.5;
    return 0.5;
  }
  if (input.isReceipt) {
    if (input.visaMatched) return 0.9;
    if (input.vendorReceiptMatched) return 0.82;
    return 0.55;
  }
  return 0.3;
}

function detectVendor(text: string, supplier: ExtractedParty, config: MonthlyWorkflowConfig): string | null {
  const explicit =
    firstMatch(text, /\b(?:merchant|vendor|prevadzka|predajca)\s*[:\-]?\s*([^\n]+)/i)
    ?? supplier.legalName
    ?? null;
  const normalized = normalizeForMatching(text);
  for (const vendor of classificationRules(config).fuelVendors) {
    if (normalized.includes(normalizeForMatching(vendor))) return vendor.toUpperCase();
  }
  return explicit?.trim() ?? null;
}

function classifyReceiptCategory(text: string, vendor: string | null, config: MonthlyWorkflowConfig): "fuel" | "software" | "services" | "other" {
  const normalized = normalizeForMatching(text);
  const vendorNormalized = normalizeForMatching(vendor ?? "");
  const rules = classificationRules(config);
  if (rules.fuelVendors.some((item) => vendorNormalized.includes(normalizeForMatching(item)))
    || rules.fuelKeywords.some((item) => normalized.includes(normalizeForMatching(item)))) return "fuel";
  if (rules.softwareKeywords.some((item) => normalized.includes(normalizeForMatching(item)))) return "software";
  if (rules.mealKeywords.some((item) => normalized.includes(normalizeForMatching(item)))) return "services";
  return "other";
}

function classifyDocumentCategory(params: {
  text: string;
  vendor: string | null;
  config: MonthlyWorkflowConfig;
  isReceipt: boolean;
}): ClassifiedDocument["expenseCategory"] | undefined {
  const normalized = normalizeForMatching(params.text);
  const vendorNormalized = normalizeForMatching(params.vendor ?? "");
  const rules = classificationRules(params.config);

  if (params.isReceipt) {
    return classifyReceiptCategory(params.text, params.vendor, params.config);
  }

  if (
    rules.fuelVendors.some((item) => vendorNormalized.includes(normalizeForMatching(item)))
    || rules.fuelKeywords.some((item) => normalized.includes(normalizeForMatching(item)))
  ) {
    return "fuel";
  }
  if (rules.softwareKeywords.some((item) => normalized.includes(normalizeForMatching(item)))) {
    return "software";
  }
  if (!params.isReceipt && /developer|insurance|consult|service|support|maintenance|agency|accounting|legal/i.test(params.text)) {
    return "services";
  }
  return "other";
}

export function buildClassification(params: {
  config: MonthlyWorkflowConfig;
  document: DownloadedAttachment;
  text: string;
  keywordConfig: KeywordConfig;
  extraction: {
    extractionStatus: ClassifiedDocument["extractionStatus"];
    extractionMethod?: ClassifiedDocument["extractionMethod"];
    textPath: string | null;
    ocrTextPath?: string | null;
    pageCount?: number | null;
    ocr: {
      outputTextPath: string | null;
      warnings: string[];
      language: string | null;
      quality: "high" | "medium" | "low" | "failed";
    };
  };
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
  const identityMatches = matchEquisixIdentity({ identity, text: params.text, supplier, customer });
  const detectedType = detectDocumentType({
    text: params.text,
    isImage: params.document.isImage ?? false,
    extractionMethod: params.extraction.extractionMethod,
    config: params.config,
  });
  const documentType = detectedType.documentType;
  const companyRelation = inferRelation(identityMatches, supplier, customer);
  const normalized = normalizeForMatching(params.text);
  const compact = normalizeCompact(params.text);
  const invoiceDate = parseDate(params.text);
  const deliveryDate = firstMatch(params.text, /\b(?:datum dodania|taxable supply date)\s*[:\-]?\s*(20\d{2}[./-]\d{1,2}[./-]\d{1,2})/i);
  const detectedPeriod = (invoiceDate ?? deliveryDate)?.slice(0, 7) ?? null;
  const totalAmount = firstMatch(params.text, /\b(?:total|spolu|na uhradu)\s*[:\-]?\s*([0-9]+[.,][0-9]{2})/i);
  const currency = firstMatch(params.text, /\b(EUR|CZK|USD|GBP|HUF|PLN)\b/i)?.toUpperCase() ?? null;
  const receiptNumber = firstMatch(params.text, /\b(?:receipt no|receipt number|doklad c|doklad č|pokladna)\s*[:\-]?\s*([a-z0-9\-\/]+)/i);

  const isInvoice = documentType === "invoice";
  const isReceipt = documentType === "receipt";
  const visaMatched = isReceipt && hasVisaEvidence(params.text, params.config);
  const identityMatched = identityMatches.legalName || identityMatches.registrationNumber || identityMatches.taxId || identityMatches.vatId;
  const rules = classificationRules(params.config);
  const supplierNameMatch = classifyPartyNameMatch(supplier.legalName, identity.knownNames, rules.fuzzyNameDistance);
  const customerNameMatch = classifyPartyNameMatch(customer.legalName, identity.knownNames, rules.fuzzyNameDistance);
  const supplierStrongMatch = supplierNameMatch === "strong";
  const customerStrongMatch = customerNameMatch === "strong";
  const partialNameMatch = supplierNameMatch === "partial" || customerNameMatch === "partial";
  const supplierUnknown = isUnknownParty(supplier);
  const customerUnknown = isUnknownParty(customer);
  const vendor = detectVendor(params.text, supplier, params.config);
  const expenseCategory = classifyDocumentCategory({
    text: params.text,
    vendor,
    config: params.config,
    isReceipt,
  });
  const vendorReceiptMatched = isReceipt && (
    rules.fuelVendors.some((item) => normalizeForMatching(vendor ?? "").includes(normalizeForMatching(item)))
    || rules.fuelKeywords.some((item) => normalized.includes(normalizeForMatching(item)))
  );

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
    if (vendorReceiptMatched || visaMatched) {
      overallConfidence = 91;
      finalDecision = "approved_accounting_document";
      invoiceMatchType = "receipt_rule";
      decisionReason = vendorReceiptMatched ? "receipt_rule_vendor_match" : "receipt_rule_visa_match";
      validationReasons.push("receipt_rule");
    } else {
      overallConfidence = 60;
      finalDecision = "review_required";
      decisionReason = "receipt_requires_review";
      warnings.push("missing_business_expense_evidence");
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
    if (customerStrongMatch || supplierStrongMatch || identityMatched) {
      finalDecision = "approved_accounting_document";
      decisionReason = invoiceMatchType;
      validationReasons.push(invoiceMatchType);
    } else if (supplierUnknown && customerUnknown) {
      finalDecision = "rejected_wrong_company";
      decisionReason = "invoice_missing_equisix_relation";
      rejectionReasons.push("missing_equisix_identity");
    } else {
      finalDecision = "review_required";
      decisionReason = partialNameMatch ? "invoice_partial_match_requires_review" : "invoice_unclear_role_requires_review";
      warnings.push(partialNameMatch ? "partial_identity_match" : "unclear_company_role");
    }
  } else {
    finalDecision = "rejected_non_accounting";
    decisionReason = "document_type_other";
    rejectionReasons.push("unsupported_document_type");
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
    visaMatched,
    vendorReceiptMatched,
    rejected: finalDecision.startsWith("rejected_"),
  });

  const approvalStatus =
    finalDecision === "approved_accounting_document"
      ? "auto_approved"
      : finalDecision === "review_required"
        ? "auto_approved_unverified"
        : finalDecision === "rejected_unsafe_source"
          ? "failed"
          : "excluded_non_accounting";

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
      issueDate: invoiceDate,
      taxableSupplyDate: deliveryDate,
      dueDate: firstMatch(params.text, /\b(?:splatnost|due date)\s*[:\-]?\s*(20\d{2}[./-]\d{1,2}[./-]\d{1,2})/i),
      orderNumber: firstMatch(params.text, /\b(?:order no|objednavka)\s*[:\-]?\s*([a-z0-9\-\/]+)/i),
      receiptNumber,
      cashRegisterNumber: firstMatch(params.text, /\b(?:cash register|pokladna)\s*[:\-]?\s*([a-z0-9\-\/]+)/i),
      paymentMethod: firstMatch(params.text, /\b(?:payment method|platba)\s*[:\-]?\s*([^\n]+)/i),
    },
    documentNumber: firstMatch(params.text, /\b(?:invoice no|invoice number|cislo faktury|čislo faktury|doklad)\s*[:\-]?\s*([a-z0-9\-\/]+)/i),
    issueDate: invoiceDate,
    taxableSupplyDate: deliveryDate,
    invoiceDate,
    deliveryDate,
    detectedPeriod,
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
