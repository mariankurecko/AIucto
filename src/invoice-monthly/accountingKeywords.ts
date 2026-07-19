import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { InvoiceKeywordDetection, KeywordAnalysis, KeywordConfig, KeywordDetectionField, KeywordDetectionSource, NegativeMatch, KeywordMatch, SignalMatch } from "./types.js";
import { escapeRegex, normalizeForMatching, tokenizeFilename } from "./textNormalization.js";

// Partial-match stems, case-insensitive, diacritics already stripped by normalizeForMatching.
// "faktur" catches faktura/faktúra/faktury; "invoic" catches invoice/invoices/invoicing.
const INVOICE_KEYWORD_STEMS = [
  "faktur",
  "invoic",
  "receipt",
  "blok",
  "block",
  "doklad",
  "payment confirmation",
];
const KEYWORD_DETECTION_FIELDS: KeywordDetectionField[] = ["subject", "body", "attachment_name", "attachment_text", "ocr"];

/**
 * Detects invoice-related keywords across the email subject, body, and attachment text.
 * This is a SIGNAL ONLY — it never filters documents. Uses partial (substring) matching on
 * diacritics-normalized, lowercased text so "faktúra" and "faktura" both match "faktur".
 */
export function detectInvoiceKeywords(input: {
  subject: string;
  body: string;
  attachmentName: string;
  attachmentText: string;
  attachmentFromOcr: boolean;
}): InvoiceKeywordDetection {
  const attachmentTextField: KeywordDetectionField = input.attachmentFromOcr ? "ocr" : "attachment_text";
  const sources: Array<{ name: KeywordDetectionField; value: string }> = [
    { name: "subject", value: normalizeForMatching(input.subject) },
    { name: "body", value: normalizeForMatching(input.body) },
    { name: "attachment_name", value: normalizeForMatching(input.attachmentName) },
    { name: attachmentTextField, value: normalizeForMatching(input.attachmentText) },
  ];

  const matchedKeywords = new Set<string>();
  const matchedFields = new Set<KeywordDetectionField>();

  for (const source of sources) {
    if (!source.value) continue;
    for (const stem of INVOICE_KEYWORD_STEMS) {
      const normalizedStem = normalizeForMatching(stem);
      if (normalizedStem && source.value.includes(normalizedStem)) {
        matchedKeywords.add(stem);
        matchedFields.add(source.name);
      }
    }
  }

  const orderedFields = KEYWORD_DETECTION_FIELDS.filter(
    (name) => matchedFields.has(name),
  );

  let keywordSource: KeywordDetectionSource;
  if (orderedFields.length === 0) keywordSource = "none";
  else if (orderedFields.length > 1) keywordSource = "multiple";
  else keywordSource = orderedFields[0];

  return {
    keywordFound: orderedFields.length > 0,
    keywordSource,
    matchedKeywords: [...matchedKeywords],
    matchedFields: orderedFields,
    fromOcr: matchedFields.has("ocr"),
    fromEmailText: matchedFields.has("subject") || matchedFields.has("body"),
  };
}

export function mergeInvoiceKeywordDetections(...detections: Array<InvoiceKeywordDetection | undefined>): InvoiceKeywordDetection {
  const matchedKeywords = new Set<string>();
  const matchedFields = new Set<KeywordDetectionField>();
  for (const detection of detections) {
    if (!detection) continue;
    detection.matchedKeywords.forEach((keyword) => matchedKeywords.add(keyword));
    detection.matchedFields.forEach((field) => matchedFields.add(field));
  }
  const orderedFields = KEYWORD_DETECTION_FIELDS.filter(
    (field) => matchedFields.has(field),
  );
  return {
    keywordFound: orderedFields.length > 0,
    keywordSource: orderedFields.length === 0 ? "none" : orderedFields.length === 1 ? orderedFields[0] : "multiple",
    matchedKeywords: [...matchedKeywords],
    matchedFields: orderedFields,
    fromOcr: matchedFields.has("ocr"),
    fromEmailText: matchedFields.has("subject") || matchedFields.has("body"),
  };
}

const KeywordFileSchema = z.object({
  positive_keywords: z.record(z.array(z.string().min(1)).min(1)),
  supporting_signals: z.array(z.string().min(1)),
  negative_keywords: z.array(z.string().min(1)),
});

export function loadKeywordConfig(projectRoot: string, relativePath: string): KeywordConfig {
  const fullPath = path.resolve(projectRoot, relativePath);
  const raw = YAML.parse(fs.readFileSync(fullPath, "utf8"));
  const parsed = KeywordFileSchema.parse(raw);
  return {
    positiveKeywords: parsed.positive_keywords,
    supportingSignals: parsed.supporting_signals,
    negativeKeywords: parsed.negative_keywords,
  };
}

function keywordPattern(keyword: string): RegExp {
  const normalized = normalizeForMatching(keyword);
  return new RegExp(`(^|\\s)${escapeRegex(normalized)}(?=\\s|$)`, "i");
}

function collectPositiveMatches(
  input: { subject: string; filename: string; text: string },
  keywordConfig: KeywordConfig,
): KeywordMatch[] {
  const sources = [
    { field: "subject" as const, value: normalizeForMatching(input.subject) },
    { field: "filename" as const, value: tokenizeFilename(input.filename) },
    { field: "text" as const, value: normalizeForMatching(input.text) },
  ];
  const matches: KeywordMatch[] = [];
  for (const [category, keywords] of Object.entries(keywordConfig.positiveKeywords)) {
    for (const keyword of keywords) {
      const pattern = keywordPattern(keyword);
      for (const source of sources) {
        if (pattern.test(source.value)) {
          matches.push({ category, keyword, field: source.field });
        }
      }
    }
  }
  return dedupeMatches(matches);
}

function collectSupportingMatches(
  input: { subject: string; filename: string; text: string },
  keywordConfig: KeywordConfig,
): SignalMatch[] {
  const sources = [
    { field: "subject" as const, value: normalizeForMatching(input.subject) },
    { field: "filename" as const, value: tokenizeFilename(input.filename) },
    { field: "text" as const, value: normalizeForMatching(input.text) },
  ];
  const matches: SignalMatch[] = [];
  for (const keyword of keywordConfig.supportingSignals) {
    const pattern = keywordPattern(keyword);
    for (const source of sources) {
      if (pattern.test(source.value)) {
        matches.push({ keyword, field: source.field });
      }
    }
  }
  return dedupeMatches(matches);
}

function collectNegativeMatches(
  input: { subject: string; filename: string; text: string },
  keywordConfig: KeywordConfig,
): NegativeMatch[] {
  const sources = [
    { field: "subject" as const, value: normalizeForMatching(input.subject) },
    { field: "filename" as const, value: tokenizeFilename(input.filename) },
    { field: "text" as const, value: normalizeForMatching(input.text) },
  ];
  const matches: NegativeMatch[] = [];
  for (const keyword of keywordConfig.negativeKeywords) {
    const pattern = keywordPattern(keyword);
    for (const source of sources) {
      if (pattern.test(source.value)) {
        matches.push({ keyword, field: source.field });
      }
    }
  }
  return dedupeMatches(matches);
}

function dedupeMatches<T extends { field: string; keyword?: string; category?: string }>(matches: T[]): T[] {
  const seen = new Set<string>();
  return matches.filter((match) => {
    const key = JSON.stringify(match);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function analyzeKeywords(
  input: { subject: string; filename: string; text: string },
  keywordConfig: KeywordConfig,
): KeywordAnalysis {
  return {
    matchedAccountingKeywords: collectPositiveMatches(input, keywordConfig),
    matchedSupportingSignals: collectSupportingMatches(input, keywordConfig),
    matchedNegativeSignals: collectNegativeMatches(input, keywordConfig),
  };
}

export function keywordCounts(keywordConfig: KeywordConfig): {
  positive: number;
  negative: number;
} {
  const positive = Object.values(keywordConfig.positiveKeywords).reduce(
    (sum, keywords) => sum + keywords.length,
    0,
  );
  return {
    positive,
    negative: keywordConfig.negativeKeywords.length,
  };
}
