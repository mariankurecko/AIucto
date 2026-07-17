import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { KeywordAnalysis, KeywordConfig, NegativeMatch, KeywordMatch, SignalMatch } from "./types.js";
import { escapeRegex, normalizeForMatching, tokenizeFilename } from "./textNormalization.js";

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
