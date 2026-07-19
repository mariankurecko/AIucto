import test from "node:test";
import assert from "node:assert/strict";
import { analyzeKeywords, detectInvoiceKeywords, keywordCounts, loadKeywordConfig } from "../src/invoice-monthly/accountingKeywords.js";
import { classifyBySignals } from "../src/invoice-monthly/accountingSignals.js";
import { buildStoredFilename, ensureUniqueStoredFilenames } from "../src/invoice-monthly/filename.js";
import { normalizeForMatching } from "../src/invoice-monthly/textNormalization.js";

const projectRoot = process.cwd();
const keywordConfig = loadKeywordConfig(projectRoot, "config/accounting-keywords.yaml");

test("keyword configuration loads with expected counts", () => {
  const counts = keywordCounts(keywordConfig);
  assert.ok(counts.positive >= 150);
  assert.ok(counts.negative >= 10);
});

for (const keyword of [
  "faktúra", "faktura", "faktúry", "faktury", "faktuar",
  "daňový doklad", "danovy doklad", "daňové doklady", "danove doklady",
  "doklad", "doklady", "blok", "blocky", "bloček", "blocek", "bločík",
  "blocik", "bločky", "účtenka", "uctenka", "dobropis", "credit note",
  "predfaktúra", "predfaktura", "proforma invoice",
]) {
  test(`keyword matching supports ${keyword}`, () => {
    const analysis = analyzeKeywords({ subject: keyword, filename: "", text: "" }, keywordConfig);
    assert.ok(analysis.matchedAccountingKeywords.some((match) => match.keyword === keyword));
  });
}

test("Unicode and diacritic normalization", () => {
  assert.equal(normalizeForMatching("Faktúra   č. 12"), "faktura c 12");
});

test("diacritic-free normalization", () => {
  assert.equal(normalizeForMatching("daňový doklad"), "danovy doklad");
});

test("filename keyword matching", () => {
  const analysis = analyzeKeywords({ subject: "", filename: "Faktúra_2026-06.pdf", text: "" }, keywordConfig);
  assert.ok(analysis.matchedAccountingKeywords.some((match) => match.field === "filename"));
});

test("subject keyword matching", () => {
  const analysis = analyzeKeywords({ subject: "Predfaktúra 102", filename: "", text: "" }, keywordConfig);
  assert.ok(analysis.matchedAccountingKeywords.some((match) => match.field === "subject"));
});

test("extracted-text keyword matching", () => {
  const analysis = analyzeKeywords({ subject: "", filename: "", text: "Dátum splatnosti a faktúra 123" }, keywordConfig);
  assert.ok(analysis.matchedAccountingKeywords.some((match) => match.field === "text"));
  assert.ok(analysis.matchedSupportingSignals.some((match) => match.keyword === "dátum splatnosti"));
});

test("supporting accounting-signal scoring", () => {
  const analysis = analyzeKeywords({ subject: "Faktúra", filename: "", text: "IBAN variabilný symbol suma na úhradu" }, keywordConfig);
  const classification = classifyBySignals({ keywordAnalysis: analysis, extractionStatus: "text_extracted", localTextAvailable: true });
  assert.equal(classification.approvalStatus, "auto_approved");
});

test("generic word doklad is not sufficient alone", () => {
  const analysis = analyzeKeywords({ subject: "doklad", filename: "", text: "" }, keywordConfig);
  const classification = classifyBySignals({ keywordAnalysis: analysis, extractionStatus: "text_extracted", localTextAvailable: true });
  assert.notEqual(classification.approvalStatus, "auto_approved");
});

test("generic word blok is not sufficient alone", () => {
  const analysis = analyzeKeywords({ subject: "blok", filename: "", text: "" }, keywordConfig);
  const classification = classifyBySignals({ keywordAnalysis: analysis, extractionStatus: "text_extracted", localTextAvailable: true });
  assert.notEqual(classification.approvalStatus, "auto_approved");
});

for (const [name, subject, expected] of [
  ["high-recall classification policy", "faktúra IBAN suma na úhradu", "auto_approved"],
  ["credit-note inclusion", "dobropis IBAN suma na úhradu", "auto_approved"],
  ["proforma-invoice inclusion", "predfaktúra IBAN suma na úhradu", "auto_approved"],
  ["receipt inclusion", "bloček EUR payment receipt", "auto_approved"],
  ["sent issued-invoice inclusion", "issued invoice VAT number", "auto_approved"],
  ["clear VOP exclusion", "VOP obchodné podmienky", "excluded_non_accounting"],
  ["clear contract exclusion", "zmluva contract agreement", "excluded_non_accounting"],
  ["clear price-list exclusion", "cenník price list", "excluded_non_accounting"],
]) {
  test(name, () => {
    const analysis = analyzeKeywords({ subject, filename: "", text: subject }, keywordConfig);
    const classification = classifyBySignals({ keywordAnalysis: analysis, extractionStatus: "text_extracted", localTextAvailable: true });
    assert.equal(classification.approvalStatus, expected);
  });
}

test("encrypted candidate inclusion as unverified", () => {
  const analysis = analyzeKeywords({ subject: "faktúra", filename: "", text: "" }, keywordConfig);
  const classification = classifyBySignals({ keywordAnalysis: analysis, extractionStatus: "encrypted_pdf", localTextAvailable: false });
  assert.equal(classification.approvalStatus, "auto_approved_unverified");
});

test("scanned candidate inclusion as unverified", () => {
  const analysis = analyzeKeywords({ subject: "faktúra", filename: "", text: "" }, keywordConfig);
  const classification = classifyBySignals({ keywordAnalysis: analysis, extractionStatus: "needs_ocr", localTextAvailable: false });
  assert.equal(classification.approvalStatus, "auto_approved_unverified");
});

test("invoice keyword detection: diacritic keyword only in subject", () => {
  const result = detectInvoiceKeywords({ subject: "Faktúra 2026-06", body: "", attachmentName: "", attachmentText: "", attachmentFromOcr: false });
  assert.equal(result.keywordFound, true);
  assert.equal(result.keywordSource, "subject");
  assert.ok(result.matchedKeywords.includes("faktur"));
  assert.equal(result.fromEmailText, true);
  assert.equal(result.fromOcr, false);
});

test("invoice keyword detection: keyword only in email body", () => {
  const result = detectInvoiceKeywords({ subject: "Hello", body: "Please find the invoice attached", attachmentName: "", attachmentText: "", attachmentFromOcr: false });
  assert.equal(result.keywordFound, true);
  assert.equal(result.keywordSource, "body");
  assert.ok(result.matchedKeywords.includes("invoic"));
});

test("invoice keyword detection: keyword only inside attachment via OCR", () => {
  const result = detectInvoiceKeywords({ subject: "Hello", body: "no signal here", attachmentName: "", attachmentText: "DAŇOVÝ DOKLAD č. 5", attachmentFromOcr: true });
  assert.equal(result.keywordFound, true);
  assert.equal(result.keywordSource, "ocr");
  assert.equal(result.fromOcr, true);
  assert.equal(result.fromEmailText, false);
});

test("invoice keyword detection: multiple sources", () => {
  const result = detectInvoiceKeywords({ subject: "Faktúra", body: "receipt enclosed", attachmentName: "", attachmentText: "", attachmentFromOcr: false });
  assert.equal(result.keywordSource, "multiple");
  assert.deepEqual(result.matchedFields, ["subject", "body"]);
});

test("invoice keyword detection: no keyword found", () => {
  const result = detectInvoiceKeywords({ subject: "Meeting notes", body: "See you tomorrow", attachmentName: "agenda.pdf", attachmentText: "agenda", attachmentFromOcr: false });
  assert.equal(result.keywordFound, false);
  assert.equal(result.keywordSource, "none");
  assert.deepEqual(result.matchedKeywords, []);
});

test("invoice keyword detection: partial match on inflected forms", () => {
  const result = detectInvoiceKeywords({ subject: "Zaslanie faktúry a invoicing", body: "", attachmentName: "", attachmentText: "", attachmentFromOcr: false });
  assert.ok(result.matchedKeywords.includes("faktur"));
  assert.ok(result.matchedKeywords.includes("invoic"));
});

test("invoice keyword detection: attachment filename provenance", () => {
  const result = detectInvoiceKeywords({ subject: "", body: "", attachmentName: "invoice-2026.pdf", attachmentText: "", attachmentFromOcr: false });
  assert.equal(result.keywordSource, "attachment_name");
  assert.deepEqual(result.matchedFields, ["attachment_name"]);
});

test("filename sanitization", () => {
  const filename = buildStoredFilename({
    issueDate: "2026-06-03",
    supplierName: "Supplier Á",
    documentType: "invoice",
    documentNumber: "INV/123",
    totalAmount: "120.00",
    currency: "EUR",
    sha256: "abc",
  });
  assert.match(filename, /^2026-06-03_invoice_Supplier_A_INV-123_120.00_EUR\.pdf$/);
});

test("filename collision handling", () => {
  const [first, second] = ensureUniqueStoredFilenames([
    {
      sha256: "aaaaaaaaaaaaaaaa",
      safeStoredFilename: "same.pdf",
    } as any,
    {
      sha256: "bbbbbbbbbbbbbbbb",
      safeStoredFilename: "same.pdf",
    } as any,
  ]);
  assert.notEqual(first.safeStoredFilename, second.safeStoredFilename);
});
