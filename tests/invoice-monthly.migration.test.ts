import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildCleanupPlan } from "../src/invoice-monthly/cleanupMonth.js";
import { matchEquisixIdentity } from "../src/invoice-monthly/companyIdentity.js";
import { buildClassification, finalizeApprovedDocuments } from "../src/invoice-monthly/gmailDiscovery.js";
import { loadMonthlyConfig } from "../src/invoice-monthly/config.js";
import { LocalExtractionResult, MonthlyWorkflowConfig } from "../src/invoice-monthly/types.js";

const projectRoot = process.cwd();
const config = loadMonthlyConfig(projectRoot, "equisix");

function baseExtraction(overrides: Partial<LocalExtractionResult> = {}): LocalExtractionResult {
  return {
    extractionStatus: "text_extracted",
    extractionMethod: "native_pdf_text",
    pageCount: 1,
    textPath: null,
    ocrTextPath: null,
    extractedCharacterCount: 200,
    normalizedText: "",
    pageTexts: [{ pageNumber: 1, source: "native", text: "x" }],
    error: null,
    ocr: {
      provider: "none",
      language: null,
      quality: "high",
      outputTextPath: null,
      warnings: [],
      available: false,
    },
    ...overrides,
  };
}

function classify(text: string, overrides: Partial<Parameters<typeof buildClassification>[0]["document"]> = {}, extraction = baseExtraction()) {
  return buildClassification({
    config,
    document: {
      packagePeriod: "2026-06",
      source: {
        messageId: "m1",
        threadId: "t1",
        direction: "incoming",
        mailbox: "hello@equisix.com",
        from: "sender@example.com",
        recipients: ["hello@equisix.com"],
        subject: "invoice",
        timestampIso: "2026-06-10T00:00:00.000Z",
        localDate: "2026-06-10",
        attachmentId: "a1",
        originalFilename: "invoice.pdf",
        mimeType: "application/pdf",
        sizeBytes: 100,
      },
      localPath: "/tmp/invoice.pdf",
      normalizedFilename: "invoice.pdf",
      isPdf: true,
      isImage: false,
      sha256: "abc",
      sizeBytes: 100,
      fileExtension: "pdf",
      unsafeSource: false,
      unsafeReason: null,
      ...overrides,
    },
    text,
    keywordConfig: {
      positiveKeywords: {},
      supportingSignals: [],
      negativeKeywords: [],
    },
    extraction,
  });
}

test("Equisix match by legal name", () => {
  const match = matchEquisixIdentity({
    identity: config.companyIdentity!,
    text: "Dodavatel: Websupport s.r.o.\nOdberatel: Equisix s.r.o.",
    supplier: { legalName: "Websupport s.r.o.", registrationNumber: null, taxId: null, vatId: null, address: null, email: null },
    customer: { legalName: "Equisix s.r.o.", registrationNumber: null, taxId: null, vatId: null, address: null, email: null },
  });
  assert.equal(match.legalName, true);
});

test("Equisix match by IČO", () => {
  const match = matchEquisixIdentity({
    identity: config.companyIdentity!,
    text: "IČO 55035523",
    supplier: { legalName: null, registrationNumber: null, taxId: null, vatId: null, address: null, email: null },
    customer: { legalName: null, registrationNumber: "55035523", taxId: null, vatId: null, address: null, email: null },
  });
  assert.equal(match.registrationNumber, true);
});

test("Equisix match by DIČ", () => {
  const match = matchEquisixIdentity({
    identity: config.companyIdentity!,
    text: "DIČ 2121847970",
    supplier: { legalName: null, registrationNumber: null, taxId: null, vatId: null, address: null, email: null },
    customer: { legalName: null, registrationNumber: null, taxId: "2121847970", vatId: null, address: null, email: null },
  });
  assert.equal(match.taxId, true);
});

test("Equisix match by IČ DPH", () => {
  const match = matchEquisixIdentity({
    identity: config.companyIdentity!,
    text: "VAT ID SK 2121847970",
    supplier: { legalName: null, registrationNumber: null, taxId: null, vatId: null, address: null, email: null },
    customer: { legalName: null, registrationNumber: null, taxId: null, vatId: "SK 2121847970", address: null, email: null },
  });
  assert.equal(match.vatId, true);
});

test("invoice without Equisix identity requires review", () => {
  const result = classify("Invoice 2026-01\nSupplier: Another Supplier s.r.o.\nCustomer: Other Company s.r.o.\nIssue Date: 2026-06-10\nTotal: 100.00 EUR\nVAT: 20.00\nIBAN: SK1234567890123456789012");
  assert.equal(result.documentType, "invoice");
  assert.equal(result.finalDecision, "review_required");
  assert.equal(result.localDecisionReason, "invoice_unclear_role_requires_review");
  assert.equal(result.invoiceMatchType, "no_match");
  assert.equal(result.decisionConfidence, 0.5);
});

test("incoming invoice with Equisix as customer is approved", () => {
  const result = classify("Invoice\nSupplier: Websupport s.r.o.\nCustomer: Equisix s.r.o.\nIssue Date: 2026-06-10\nTotal: 100.00 EUR\nVAT: 20.00");
  assert.equal(result.documentType, "invoice");
  assert.equal(result.finalDecision, "approved_accounting_document");
  assert.equal(result.invoiceMatchType, "customer_match");
  assert.equal(result.decisionConfidence, 0.92);
  assert.equal(result.transactionType, "EXPENSE");
});

test("outgoing invoice with Equisix as supplier is approved", () => {
  const result = classify("Invoice\nSupplier: Equisix s.r.o.\nCustomer: Another Customer s.r.o.\nIssue Date: 2026-06-10\nTotal: 100.00 EUR\nVAT: 20.00");
  assert.equal(result.documentType, "invoice");
  assert.equal(result.finalDecision, "approved_accounting_document");
  assert.equal(result.invoiceMatchType, "supplier_match");
  assert.equal(result.decisionConfidence, 0.92);
  assert.equal(result.transactionType, "INCOME");
});

test("invoice with tax identity only is approved", () => {
  const result = classify("Invoice\nSupplier: Unknown Vendor s.r.o.\nCustomer: Unknown Customer s.r.o.\nIČO: 55035523\nIssue Date: 2026-06-10\nTotal: 100.00 EUR\nVAT: 20.00");
  assert.equal(result.documentType, "invoice");
  assert.equal(result.finalDecision, "approved_accounting_document");
  assert.equal(result.invoiceMatchType, "identity_match");
  assert.ok((result.decisionConfidence ?? 0) >= 0.95);
  assert.equal(result.transactionType, "EXPENSE");
});

test("invoice with both supplier and customer unknown is rejected", () => {
  const result = classify("Invoice\nIssue Date: 2026-06-10\nTotal: 100.00 EUR\nVAT: 20.00");
  assert.equal(result.documentType, "invoice");
  assert.equal(result.finalDecision, "rejected_wrong_company");
  assert.equal(result.invoiceMatchType, "no_match");
});

test("partial OCR-like Equisix name requires review", () => {
  const result = classify("Invoice\nSupplier: Equislx s.r.o.\nCustomer: Another Customer s.r.o.\nIssue Date: 2026-06-10\nTotal: 100.00 EUR\nVAT: 20.00");
  assert.equal(result.documentType, "invoice");
  assert.equal(result.finalDecision, "review_required");
  assert.equal(result.invoiceMatchType, "no_match");
  assert.equal(result.decisionConfidence, 0.5);
});

test("receipt without VISA 8627 requires review", () => {
  const result = classify("Receipt\nMerchant: Cafe Central\nDate: 2026-06-10\nTime: 12:05\nTotal: 12.50 EUR\nVAT: 2.08\nPayment method: card\nReceipt number: R-10", { isPdf: false, isImage: true, fileExtension: "jpg", normalizedFilename: "receipt.jpg", source: { messageId: "m1", threadId: "t1", direction: "incoming", mailbox: "hello@equisix.com", from: "sender@example.com", recipients: ["hello@equisix.com"], subject: "receipt", timestampIso: "2026-06-10T00:00:00.000Z", localDate: "2026-06-10", attachmentId: "a1", originalFilename: "receipt.jpg", mimeType: "image/jpeg", sizeBytes: 100 } }, baseExtraction({ extractionStatus: "ocr_succeeded", extractionMethod: "ocr_image", ocr: { provider: "local_tesseract", language: "slk+eng", quality: "medium", outputTextPath: "/tmp/ocr.txt", warnings: [], available: true } }));
  assert.equal(result.documentType, "receipt");
  assert.equal(result.detectionReason, "receipt_keyword");
  assert.ok((result.documentTypeConfidence ?? 0) >= 80);
  assert.equal(result.finalDecision, "review_required");
  assert.equal(result.companyRelation, "business_expense_candidate");
  assert.equal(result.localDecisionReason, "receipt_requires_review");
  assert.equal(result.decisionConfidence, 0.55);
});

test("VISA 8627 receipt exception", () => {
  const result = classify("Receipt\nMerchant: Parking House\nDate: 2026-06-10\nTotal: 9.50 EUR\nPayment method: VISA 8627", { isPdf: false, isImage: true, fileExtension: "jpg", normalizedFilename: "receipt.jpg", source: { messageId: "m1", threadId: "t1", direction: "incoming", mailbox: "hello@equisix.com", from: "sender@example.com", recipients: ["hello@equisix.com"], subject: "receipt", timestampIso: "2026-06-10T00:00:00.000Z", localDate: "2026-06-10", attachmentId: "a1", originalFilename: "receipt.jpg", mimeType: "image/jpeg", sizeBytes: 100 } }, baseExtraction({ extractionStatus: "ocr_succeeded", extractionMethod: "ocr_image", ocr: { provider: "local_tesseract", language: "slk+eng", quality: "medium", outputTextPath: "/tmp/ocr.txt", warnings: [], available: true } }));
  assert.equal(result.documentType, "receipt");
  assert.equal(result.detectionReason, "receipt_keyword");
  assert.equal(result.finalDecision, "approved_accounting_document");
  assert.equal(result.companyRelation, "business_expense_candidate");
  assert.equal(result.localDecisionReason, "receipt_rule_visa_match");
  assert.equal(result.invoiceMatchType, "receipt_rule");
  assert.equal(result.decisionConfidence, 0.9);
  assert.equal(result.transactionType, "EXPENSE");
  assert.equal(result.expenseCategory, "other");
});

test("fuel receipt vendor heuristic sets category fuel", () => {
  const result = classify("Receipt\nMerchant: Shell\nDate: 2026-06-10\nDPH 5.00\nzáklad dane 25.00\ncena spolu 30.00\nPayment method: VISA 8627", { isPdf: false, isImage: true, fileExtension: "jpg", normalizedFilename: "fuel.jpg", source: { messageId: "m1", threadId: "t1", direction: "incoming", mailbox: "hello@equisix.com", from: "sender@example.com", recipients: ["hello@equisix.com"], subject: "receipt", timestampIso: "2026-06-10T00:00:00.000Z", localDate: "2026-06-10", attachmentId: "a1", originalFilename: "fuel.jpg", mimeType: "image/jpeg", sizeBytes: 100 } }, baseExtraction({ extractionStatus: "ocr_succeeded", extractionMethod: "ocr_image", ocr: { provider: "local_tesseract", language: "slk+eng", quality: "medium", outputTextPath: "/tmp/ocr.txt", warnings: [], available: true } }));
  assert.equal(result.documentType, "receipt");
  assert.equal(result.finalDecision, "approved_accounting_document");
  assert.equal(result.vendor, "SHELL");
  assert.equal(result.expenseCategory, "fuel");
  assert.equal(result.transactionType, "EXPENSE");
});

test("software receipt category classification", () => {
  const result = classify("Receipt\nMerchant: OpenAI\nDate: 2026-06-10\nsubscription API software\nTotal: 20.00 EUR\nPayment method: VISA 8627", { isPdf: false, isImage: true, fileExtension: "jpg", normalizedFilename: "software.jpg", source: { messageId: "m1", threadId: "t1", direction: "incoming", mailbox: "hello@equisix.com", from: "sender@example.com", recipients: ["hello@equisix.com"], subject: "receipt", timestampIso: "2026-06-10T00:00:00.000Z", localDate: "2026-06-10", attachmentId: "a1", originalFilename: "software.jpg", mimeType: "image/jpeg", sizeBytes: 100 } }, baseExtraction({ extractionStatus: "ocr_succeeded", extractionMethod: "ocr_image", ocr: { provider: "local_tesseract", language: "slk+eng", quality: "medium", outputTextPath: "/tmp/ocr.txt", warnings: [], available: true } }));
  assert.equal(result.expenseCategory, "software");
  assert.equal(result.transactionType, "EXPENSE");
});

test("short unstructured OCR scan becomes receipt", () => {
  const result = classify("12.06.2026\nDPH 2.30\nzaklad dane 11.50\ncena spolu 13.80\n1234567890\n12:30", { isPdf: false, isImage: true, fileExtension: "jpg", normalizedFilename: "scan.jpg", source: { messageId: "m1", threadId: "t1", direction: "incoming", mailbox: "hello@equisix.com", from: "sender@example.com", recipients: ["hello@equisix.com"], subject: "scan", timestampIso: "2026-06-10T00:00:00.000Z", localDate: "2026-06-10", attachmentId: "a1", originalFilename: "scan.jpg", mimeType: "image/jpeg", sizeBytes: 100 } }, baseExtraction({ extractionStatus: "ocr_succeeded", extractionMethod: "ocr_image", ocr: { provider: "local_tesseract", language: "slk+eng", quality: "medium", outputTextPath: "/tmp/ocr.txt", warnings: [], available: true } }));
  assert.equal(result.documentType, "receipt");
  assert.equal(result.detectionReason, "receipt_tax_pattern");
});

test("ambiguous image scan stays other and review required", () => {
  const result = classify("random scanned text 12345 67890 some words no document sections or labels", { isPdf: false, isImage: true, fileExtension: "jpg", normalizedFilename: "ambiguous.jpg", source: { messageId: "m1", threadId: "t1", direction: "incoming", mailbox: "hello@equisix.com", from: "sender@example.com", recipients: ["hello@equisix.com"], subject: "scan", timestampIso: "2026-06-10T00:00:00.000Z", localDate: "2026-06-10", attachmentId: "a1", originalFilename: "ambiguous.jpg", mimeType: "image/jpeg", sizeBytes: 100 } }, baseExtraction({ extractionStatus: "ocr_succeeded", extractionMethod: "ocr_image", ocr: { provider: "local_tesseract", language: "slk+eng", quality: "medium", outputTextPath: "/tmp/ocr.txt", warnings: [], available: true } }));
  assert.equal(result.documentType, "other");
  assert.equal(result.finalDecision, "rejected_non_accounting");
  assert.ok((result.documentTypeConfidence ?? 0) <= 50);
});

test("scanned invoice OCR provenance", () => {
  const result = classify("Invoice\nCustomer: Equisix s.r.o.\nIČO 55035523\nIssue Date: 2026-06-10\nTotal: 100.00 EUR\nVAT: 20.00", {}, baseExtraction({
    extractionStatus: "ocr_succeeded",
    extractionMethod: "ocr_pdf",
    ocr: { provider: "local_tesseract", language: "slk+eng", quality: "medium", outputTextPath: "/tmp/ocr.txt", warnings: [], available: true },
  }));
  assert.equal(result.extractionMethod, "ocr_pdf");
  assert.equal(result.documentType, "invoice");
  assert.ok((result.documentTypeConfidence ?? 0) >= 85);
  assert.equal(result.detectionReason, "invoice_keyword");
  assert.equal(result.finalDecision, "approved_accounting_document");
  assert.equal(result.localDecisionReason, "customer_match");
  assert.equal(result.invoiceMatchType, "customer_match");
});

test("unsafe filename rejection", () => {
  const result = classify("Invoice\nCustomer: Equisix s.r.o.\nIČO 55035523\nIssue Date: 2026-06-10\nTotal: 100.00 EUR", {
    unsafeSource: true,
    unsafeReason: "path_like_filename",
    source: {
      messageId: "m1",
      threadId: "t1",
      direction: "incoming",
      mailbox: "hello@equisix.com",
      from: "sender@example.com",
      recipients: ["hello@equisix.com"],
      subject: "invoice",
      timestampIso: "2026-06-10T00:00:00.000Z",
      localDate: "2026-06-10",
      attachmentId: "a1",
      originalFilename: "../invoice.pdf",
      mimeType: "application/pdf",
      sizeBytes: 100,
    },
  });
  assert.equal(result.finalDecision, "rejected_unsafe_source");
});

test("review files excluded from ZIP", () => {
  const approved = classify("Invoice\nCustomer: Equisix s.r.o.\nIČO 55035523\nIssue Date: 2026-06-10\nTotal: 100.00 EUR\nVAT: 20.00");
  const review = classify("Invoice\nCustomer: Other Company s.r.o.\nIssue Date: 2026-06-10\nTotal: 100.00 EUR\nVAT: 20.00");
  const finalized = finalizeApprovedDocuments([approved, review]);
  assert.equal(finalized.approved.length, 1);
  assert.equal(finalized.reviewRequired.length, 1);
  assert.equal(finalized.approved[0].zipIncluded, true);
});

test("cleanup dry-run makes no changes and is idempotent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-plan-"));
  const runDir = path.join(root, "data", "invoice-runs", "equisix", "monthly", "2026-06");
  const auditDir = path.join(root, "data", "audit", "invoice-monthly", "equisix");
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify({
    documents: [
      { sha256: "a", originalFilename: "one.pdf", storedFilename: "one.pdf", driveFileId: "file-1", driveFileUrl: "https://drive/file-1", mimeType: "application/pdf" },
    ],
  }));
  fs.writeFileSync(path.join(runDir, "run-state.json"), JSON.stringify({
    runId: "run-1",
    monthlyFolderId: "month-1",
    monthlyFolderUrl: "https://drive/month-1",
    zipDriveFileId: "zip-1",
    zipDriveUrl: "https://drive/zip-1",
    zipPath: "/tmp/Accounting-Package-Equisix-2026-06.zip",
    zipSha256: "zipsha",
  }));
  fs.writeFileSync(path.join(runDir, "prepared-email.json"), JSON.stringify({ zipFilename: "Accounting-Package-Equisix-2026-06.zip" }));
  fs.writeFileSync(path.join(auditDir, "2026-06-2026-07-17T13-08-51-107Z.json"), JSON.stringify({ runId: "run-1", monthlyFolderDriveId: "month-1", monthlyFolderDriveUrl: "https://drive/month-1" }));

  const before = fs.readdirSync(runDir).sort();
  const first = buildCleanupPlan(root, "equisix", "2026-06");
  const second = buildCleanupPlan(root, "equisix", "2026-06");
  const after = fs.readdirSync(runDir).sort();

  assert.deepEqual(before, after);
  assert.deepEqual(first.proposedMoves.map((move) => move.driveFileId).sort(), second.proposedMoves.map((move) => move.driveFileId).sort());
  assert.equal(first.proposedMoves.length, 2);
});
