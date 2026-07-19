import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { applyPeriodValidation } from "../src/invoice-monthly/periodValidation.js";
import { loadMonthlyConfig } from "../src/invoice-monthly/config.js";
import { periodFromString } from "../src/invoice-monthly/period.js";
import { runStrictPeriodCleanup } from "../src/invoice-monthly/strictPeriodCleanup.js";
import { ClassifiedDocument } from "../src/invoice-monthly/types.js";

function tempProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "period-validation-"));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.mkdirSync(path.join(root, "data", "invoice-runs", "kurecko", "monthly", "2026-06"), { recursive: true });
  fs.copyFileSync(path.join(process.cwd(), "config", "kurecko.yaml"), path.join(root, "config", "kurecko.yaml"));
  return root;
}

function sampleDocument(overrides: Partial<ClassifiedDocument> = {}): ClassifiedDocument {
  return {
    sha256: "sha-1",
    sourceMessages: [],
    localPath: "/tmp/doc.pdf",
    originalFilename: "doc.pdf",
    safeStoredFilename: null,
    mimeType: "application/pdf",
    sizeBytes: 100,
    fileExtension: "pdf",
    extractionStatus: "text_extracted",
    extractionMethod: "native_pdf_text",
    textPath: null,
    ocrTextPath: null,
    pageCount: 1,
    keywordAnalysis: {
      matchedAccountingKeywords: [],
      matchedSupportingSignals: [],
      matchedNegativeSignals: [],
    },
    localAccountingScore: 0,
    localSignals: [],
    localDecisionReason: "identity_match",
    decisionConfidence: 0.9,
    documentType: "invoice",
    detectionReason: "invoice_keyword",
    accountingRelevance: "accounting_document",
    approvalStatus: "auto_approved",
    finalDecision: "approved_accounting_document",
    invoiceMatchType: "identity_match",
    issueDate: "2026-05-31",
    taxableSupplyDate: "2026-07-02",
    invoiceDate: "2026-05-31",
    deliveryDate: "2026-07-02",
    detectedPeriod: "2026-05",
    document: {
      documentNumber: "1",
      variableSymbol: null,
      issueDate: "2026-05-31",
      taxableSupplyDate: "2026-07-02",
      dueDate: null,
      orderNumber: null,
      receiptNumber: null,
      cashRegisterNumber: null,
      paymentMethod: null,
    },
    confidence: 90,
    warnings: [],
    validationReasons: [],
    rejectionReasons: [],
    llmResultPath: null,
    llmRetriesUsed: 0,
    zipIncluded: true,
    ...overrides,
  };
}

test("period validation rejects approved documents outside the target month", () => {
  const root = tempProject();
  const config = loadMonthlyConfig(root, "kurecko");
  const period = periodFromString("2026-06", config.timezone);
  const document = sampleDocument();
  applyPeriodValidation(document, period, config);
  assert.equal(document.finalDecision, "rejected_non_accounting");
  assert.match((document.rejectionReasons ?? []).join(","), /out_of_period/);
});

test("period validation uses delivery date fallback when enabled", () => {
  const root = tempProject();
  const config = loadMonthlyConfig(root, "kurecko");
  const period = periodFromString("2026-06", config.timezone);
  const document = sampleDocument({
    issueDate: null,
    taxableSupplyDate: "2026-06-15",
    invoiceDate: null,
    deliveryDate: "2026-06-15",
    detectedPeriod: null,
    document: {
      documentNumber: "1",
      variableSymbol: null,
      issueDate: null,
      taxableSupplyDate: "2026-06-15",
      dueDate: null,
      orderNumber: null,
      receiptNumber: null,
      cashRegisterNumber: null,
      paymentMethod: null,
    },
  });
  applyPeriodValidation(document, period, config);
  assert.equal(document.finalDecision, "approved_accounting_document");
  assert.equal(document.deliveryDate, "2026-06-15");
  assert.equal(document.detectedPeriod, "2026-06");
  assert.equal(document.accountingPeriod, "2026-06");
});

test("invalid calendar dates are never approved or routed", () => {
  const root = tempProject();
  const config = loadMonthlyConfig(root, "kurecko");
  const period = periodFromString("2026-06", config.timezone);
  const document = sampleDocument({
    issueDate: "2025-14-08",
    invoiceDate: "2025-14-08",
    deliveryDate: null,
    taxableSupplyDate: null,
    detectedPeriod: "2025-14",
  });
  applyPeriodValidation(document, period, config, { routeByDocumentDate: true });
  assert.equal(document.finalDecision, "review_required");
  assert.equal(document.accountingPeriod, null);
  assert.equal(document.detectedPeriod, null);
  assert.match((document.warnings ?? []).join(","), /invalid_document_date/);
  assert.match((document.validationReasons ?? []).join(","), /invalid_routing_period/);
});

test("strict period cleanup rewrites approved outputs and manifest counts", async () => {
  const root = tempProject();
  const runDir = path.join(root, "data", "invoice-runs", "kurecko", "monthly", "2026-06");
  const approved = sampleDocument();
  const inPeriod = sampleDocument({
    sha256: "sha-2",
    originalFilename: "in-period.pdf",
    issueDate: "2026-06-10",
    taxableSupplyDate: null,
    invoiceDate: "2026-06-10",
    deliveryDate: null,
    detectedPeriod: "2026-06",
    document: {
      documentNumber: "2",
      variableSymbol: null,
      issueDate: "2026-06-10",
      taxableSupplyDate: null,
      dueDate: null,
      orderNumber: null,
      receiptNumber: null,
      cashRegisterNumber: null,
      paymentMethod: null,
    },
  });
  fs.writeFileSync(path.join(runDir, "classified.json"), JSON.stringify([approved, inPeriod], null, 2));
  fs.writeFileSync(path.join(runDir, "approved.json"), JSON.stringify([approved, inPeriod], null, 2));
  fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify({ duplicateCount: 0, generatedAt: "2026-07-17T00:00:00.000Z" }, null, 2));

  const result = await runStrictPeriodCleanup({
    projectRoot: root,
    account: "kurecko",
    period: "2026-06",
  });

  const rewrittenApproved = JSON.parse(fs.readFileSync(path.join(runDir, "approved.json"), "utf8"));
  const rewrittenRejected = JSON.parse(fs.readFileSync(path.join(runDir, "rejected.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));

  assert.equal(result.outOfPeriodRejected, 1);
  assert.equal(rewrittenApproved.length, 1);
  assert.equal(rewrittenRejected.length, 1);
  assert.equal(manifest.approvedDocumentCount, 1);
  assert.equal(manifest.rejectedDocumentCount, 1);
});
