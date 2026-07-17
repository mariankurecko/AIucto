import { AccountingRelevance, ApprovalStatus, ClassifiedDocument, DocumentType, ExtractionStatus, KeywordAnalysis } from "./types.js";

const CATEGORY_WEIGHTS: Record<string, number> = {
  invoice: 8,
  tax_document: 8,
  credit_note: 8,
  proforma: 7,
  receipt: 6,
  billing: 5,
  billing_document: 5,
  accounting_document: 2,
};

const WEAK_GENERIC_KEYWORDS = new Set([
  "doklad",
  "doklady",
  "blok",
  "blocek",
  "bloček",
  "blocky",
  "bill",
]);

const NON_DECISIVE_SUPPORT_SIGNALS = new Set(["€", "$", "£"]);

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)];
}

export function scoreAccountingSignals(analysis: KeywordAnalysis): {
  score: number;
  matchedSignalIds: string[];
} {
  let score = 0;
  const matchedSignalIds: string[] = [];

  for (const match of analysis.matchedAccountingKeywords) {
    score += CATEGORY_WEIGHTS[match.category] ?? 2;
    matchedSignalIds.push(`positive:${match.category}:${match.keyword}`);
  }

  for (const match of analysis.matchedSupportingSignals) {
    score += 2;
    matchedSignalIds.push(`support:${match.keyword}`);
  }

  for (const match of analysis.matchedNegativeSignals) {
    score -= 8;
    matchedSignalIds.push(`negative:${match.keyword}`);
  }

  return {
    score,
    matchedSignalIds: uniqueValues(matchedSignalIds),
  };
}

function deriveDocumentType(analysis: KeywordAnalysis, extractionStatus: ExtractionStatus): DocumentType {
  const categories = new Set(analysis.matchedAccountingKeywords.map((match) => match.category));
  if (extractionStatus === "encrypted_pdf") return "encrypted";
  if (extractionStatus === "needs_ocr" || extractionStatus === "parse_failed") return "unreadable";
  if (categories.has("credit_note")) return "credit_note";
  if (categories.has("proforma")) return "proforma_invoice";
  if (categories.has("receipt")) return "receipt";
  if (categories.has("tax_document")) return "tax_document";
  if (categories.has("invoice")) return "invoice";
  if (categories.has("billing") || categories.has("billing_document")) return "billing_document";
  if (categories.has("accounting_document")) return "accounting_document";
  return analysis.matchedAccountingKeywords.length > 0 ? "uncertain" : "other";
}

export function classifyBySignals(params: {
  keywordAnalysis: KeywordAnalysis;
  extractionStatus: ExtractionStatus;
  localTextAvailable: boolean;
}): {
  documentType: DocumentType;
  accountingRelevance: AccountingRelevance;
  approvalStatus: ApprovalStatus;
  reason: string;
  score: number;
  matchedSignals: string[];
} {
  const { score, matchedSignalIds } = scoreAccountingSignals(params.keywordAnalysis);
  const documentType = deriveDocumentType(params.keywordAnalysis, params.extractionStatus);
  const positiveCount = params.keywordAnalysis.matchedAccountingKeywords.length;
  const supportCount = params.keywordAnalysis.matchedSupportingSignals.filter(
    (match) => !NON_DECISIVE_SUPPORT_SIGNALS.has(match.keyword),
  ).length;
  const negativeCount = params.keywordAnalysis.matchedNegativeSignals.length;
  const hasStrongNegative = negativeCount >= 1 && score <= -4;
  const hasStrongPositive = score >= 8 || (positiveCount >= 1 && supportCount >= 2);
  const hasGenericOnly =
    positiveCount > 0 &&
    params.keywordAnalysis.matchedAccountingKeywords.every((match) =>
      ["accounting_document", "billing_document"].includes(match.category),
    ) &&
    supportCount === 0;
  const hasWeakGenericOnly =
    positiveCount > 0 &&
    supportCount === 0 &&
    params.keywordAnalysis.matchedAccountingKeywords.every((match) =>
      WEAK_GENERIC_KEYWORDS.has(match.keyword.toLowerCase()),
    );

  if (hasStrongNegative && !hasStrongPositive) {
    return {
      documentType: documentType === "other" ? "other" : documentType,
      accountingRelevance: "non_accounting",
      approvalStatus: "excluded_non_accounting",
      reason: "Strong non-accounting terminology outweighed accounting evidence.",
      score,
      matchedSignals: matchedSignalIds,
    };
  }

  if (params.extractionStatus === "invalid_pdf") {
    return {
      documentType: "other",
      accountingRelevance: "non_accounting",
      approvalStatus: "failed",
      reason: "Attachment did not contain a valid PDF signature.",
      score,
      matchedSignals: matchedSignalIds,
    };
  }

  if (params.extractionStatus === "encrypted_pdf" || params.extractionStatus === "needs_ocr" || params.extractionStatus === "parse_failed") {
    if (positiveCount > 0 || supportCount > 0) {
      return {
        documentType,
        accountingRelevance: "uncertain",
        approvalStatus: "auto_approved_unverified",
        reason: "Accounting relevance is plausible but the PDF could not be fully verified locally.",
        score,
        matchedSignals: matchedSignalIds,
      };
    }
  }

  if (hasGenericOnly) {
    return {
      documentType,
      accountingRelevance: "uncertain",
      approvalStatus: "auto_approved_unverified",
      reason: "Only generic accounting terminology matched; included under high-recall policy.",
      score,
      matchedSignals: matchedSignalIds,
    };
  }

  if (positiveCount === 1 && supportCount === 0 && negativeCount === 0) {
    return {
      documentType,
      accountingRelevance: "uncertain",
      approvalStatus: "auto_approved_unverified",
      reason: "A single keyword match without supporting structure is insufficient for automatic approval.",
      score,
      matchedSignals: matchedSignalIds,
    };
  }

  if (hasWeakGenericOnly) {
    return {
      documentType,
      accountingRelevance: "uncertain",
      approvalStatus: "auto_approved_unverified",
      reason: "Only weak generic document words matched; manual review is required.",
      score,
      matchedSignals: matchedSignalIds,
    };
  }

  if (hasStrongPositive) {
    return {
      documentType,
      accountingRelevance: "accounting_document",
      approvalStatus: params.localTextAvailable ? "auto_approved" : "auto_approved_unverified",
      reason: "Multiple independent accounting signals were found.",
      score,
      matchedSignals: matchedSignalIds,
    };
  }

  if (positiveCount > 0 || supportCount > 0) {
    return {
      documentType: documentType === "other" ? "uncertain" : documentType,
      accountingRelevance: "uncertain",
      approvalStatus: "auto_approved_unverified",
      reason: "Partial accounting evidence was found and high-recall policy keeps plausible documents.",
      score,
      matchedSignals: matchedSignalIds,
    };
  }

  return {
    documentType: params.localTextAvailable ? "other" : "unreadable",
    accountingRelevance: "non_accounting",
    approvalStatus: "excluded_non_accounting",
    reason: "No meaningful accounting evidence was found.",
    score,
    matchedSignals: matchedSignalIds,
  };
}

export function mergeClassification(
  base: ClassifiedDocument,
  overrides: Partial<ClassifiedDocument>,
): ClassifiedDocument {
  return {
    ...base,
    ...overrides,
  };
}
