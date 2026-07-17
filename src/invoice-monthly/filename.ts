import path from "node:path";
import { ClassifiedDocument, FinalApprovedDocument } from "./types.js";
import { sanitizePathSegment } from "./fs.js";

function normalizeAmount(value: string | null): string {
  if (!value) return "unknown";
  return sanitizePathSegment(value.replace(/[^\d.,-]+/g, "").replace(/,/g, "."));
}

function normalizeParty(value: string | null): string {
  return sanitizePathSegment(value || "unknown-merchant");
}

function normalizeDate(value: string | null): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value ?? "") ? (value as string) : "unknown-date";
}

function normalizeDocumentNumber(value: string | null): string {
  return sanitizePathSegment(value || "no-number");
}

function normalizeCurrency(value: string | null): string {
  return sanitizePathSegment(value || "XXX");
}

export function buildStoredFilename(document: Partial<ClassifiedDocument> & {
  sha256: string;
  documentType: string;
  issueDate?: string | null;
  supplierName?: string | null;
  documentNumber?: string | null;
  totalAmount?: string | null;
  currency?: string | null;
}): string {
  const date = normalizeDate(document.issueDate ?? document.document?.issueDate ?? document.sourceMessages?.[0]?.localDate ?? null);
  const party = normalizeParty(document.supplierName ?? document.supplier?.legalName ?? document.customer?.legalName ?? null);
  const docType = sanitizePathSegment(document.documentType);
  const docNumber = normalizeDocumentNumber(document.documentNumber ?? document.document?.documentNumber ?? document.document?.receiptNumber ?? null);
  const amount = normalizeAmount(document.totalAmount ?? document.amounts?.totalAmount ?? null);
  const currency = normalizeCurrency(document.currency ?? document.amounts?.currency ?? null);
  const ext = document.fileExtension || path.extname(document.originalFilename ?? "").replace(/^\./, "") || "pdf";

  const base = [date, docType, party, docNumber, amount, currency].join("_");
  return `${base}.${sanitizePathSegment(ext)}`;
}

export function ensureUniqueStoredFilenames(documents: FinalApprovedDocument[]): FinalApprovedDocument[] {
  const byName = new Map<string, FinalApprovedDocument[]>();
  for (const document of documents) {
    const name = document.safeStoredFilename;
    const group = byName.get(name) ?? [];
    group.push(document);
    byName.set(name, group);
  }

  return documents.map((document) => {
    const name = document.safeStoredFilename;
    const group = byName.get(name) ?? [];
    if (group.length <= 1) return document;
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    return {
      ...document,
      safeStoredFilename: `${base}_${document.sha256.slice(0, 8)}${ext}`,
    };
  });
}
