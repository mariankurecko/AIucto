const OCR_SUBSTITUTIONS: Array<[RegExp, string]> = [
  [/ičo/giu, "ico"],
  [/ič dph/giu, "ic dph"],
  [/dič/giu, "dic"],
  [/0(?=[a-z])/giu, "o"],
  [/\bl(?=\d)/giu, "1"],
  [/\bsk\s+/giu, "sk"],
];

export function normalizeForMatching(value: string): string {
  let normalized = value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();

  for (const [pattern, replacement] of OCR_SUBSTITUTIONS) {
    normalized = normalized.replace(pattern, replacement);
  }

  return normalized
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCompact(value: string): string {
  return normalizeForMatching(value).replace(/\s+/g, "");
}

export function normalizeDigits(value: string): string {
  return normalizeCompact(value).replace(/[^\da-z]/g, "");
}

export function tokenizeFilename(value: string): string {
  return normalizeForMatching(value.replace(/\.[a-z0-9]+$/i, ""));
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
