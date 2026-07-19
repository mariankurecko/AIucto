import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildManifest } from "../src/invoice-monthly/manifest.js";
import { validatePdfFile } from "../src/invoice-monthly/pdfValidation.js";
import { createDeterministicZip, validateZipAgainstManifest } from "../src/invoice-monthly/zipPackage.js";
import { discoverPeriodAttachments, mergeDownloadedAttachments } from "../src/invoice-monthly/gmailDiscovery.js";
import { loadMonthlyConfig } from "../src/invoice-monthly/config.js";
import { loadKeywordConfig } from "../src/invoice-monthly/accountingKeywords.js";
import { periodFromString } from "../src/invoice-monthly/period.js";
import { initializeRunState, updateRunState } from "../src/invoice-monthly/runState.js";
import { runMonthlySecondPass } from "../src/invoice-monthly/secondPass.js";
import { runInvoiceMonthlyWorkflow } from "../src/invoice-monthly/workflow.js";
import { buildClassification } from "../packages/classification/src/index.js";
import { InvoiceMonthlyServices } from "../src/invoice-monthly/types.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "invoice-monthly-test-"));
}

function fakePdf(content = "%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF"): Buffer {
  return Buffer.from(content, "utf8");
}

test("valid PDF signature validation", () => {
  const dir = tempDir();
  const pdfPath = path.join(dir, "file.pdf");
  fs.writeFileSync(pdfPath, fakePdf());
  assert.equal(validatePdfFile(pdfPath).isPdf, true);
});

test("SHA-256 duplicate detection across incoming and sent messages", () => {
  const dir = tempDir();
  const pdfPath = path.join(dir, "file.pdf");
  fs.writeFileSync(pdfPath, fakePdf());
  const merged = mergeDownloadedAttachments([
    {
      packagePeriod: "2026-06",
      source: { messageId: "m1", threadId: "t1", direction: "incoming", mailbox: "hello@equisix.com", from: "a", recipients: ["b"], subject: "x", timestampIso: "2026-06-01T00:00:00.000Z", localDate: "2026-06-01", attachmentId: "a1", originalFilename: "a.pdf", mimeType: "application/pdf", sizeBytes: 1 },
      localPath: pdfPath,
      normalizedFilename: "a.pdf",
      isPdf: true,
      sha256: "same",
      sizeBytes: 10,
    },
    {
      packagePeriod: "2026-06",
      source: { messageId: "m2", threadId: "t2", direction: "sent", mailbox: "hello@equisix.com", from: "a", recipients: ["b"], subject: "x", timestampIso: "2026-06-02T00:00:00.000Z", localDate: "2026-06-02", attachmentId: "a2", originalFilename: "a.pdf", mimeType: "application/pdf", sizeBytes: 1 },
      localPath: pdfPath,
      normalizedFilename: "a.pdf",
      isPdf: true,
      sha256: "same",
      sizeBytes: 10,
    },
  ]);
  assert.equal(merged.uniqueDocuments.length, 1);
  assert.equal(merged.duplicateCount, 1);
  assert.equal(merged.bothDirectionsCount, 1);
});

test("discovery keeps email keyword provenance but never persists the raw email body", async () => {
  const config = loadMonthlyConfig(process.cwd(), "equisix");
  const gmail = {
    async listMessages() { return { messageIds: ["m1"], nextPageToken: null }; },
    async getMessage() {
      return {
        messageId: "m1", threadId: "t1", internalDateMs: 0, localDate: "2026-06-01", timestampIso: "2026-06-01T00:00:00.000Z",
        direction: "incoming" as const, mailbox: "hello@equisix.com", from: "sender@example.com", to: [], cc: [], bcc: [], subject: "Hello",
        bodyText: "Secret note: please find the invoice attached.",
        attachments: [{ attachmentId: "a1", filename: "document.pdf", mimeType: "application/pdf", sizeBytes: 1 }],
      };
    },
  };
  const result = await discoverPeriodAttachments({ config, period: periodFromString("2026-06", config.timezone), gmail: gmail as any, query: "has:attachment", direction: "incoming" });
  assert.equal(result.attachments.length, 1);
  assert.deepEqual(result.attachments[0].source.emailKeywordDetection?.matchedFields, ["body"]);
  const serialized = JSON.stringify(result.attachments);
  assert.equal(serialized.includes("Secret note"), false);
  assert.equal(serialized.includes("bodyText"), false);
});

test("discovery excludes unsupported attachments even when the email body has invoice keywords", async () => {
  const config = loadMonthlyConfig(process.cwd(), "equisix");
  const gmail = {
    async listMessages() { return { messageIds: ["m1"], nextPageToken: null }; },
    async getMessage() {
      return {
        messageId: "m1", threadId: "t1", internalDateMs: 0, localDate: "2026-06-01", timestampIso: "2026-06-01T00:00:00.000Z",
        direction: "incoming" as const, mailbox: "hello@equisix.com", from: "sender@example.com", to: [], cc: [], bcc: [], subject: "Hello",
        bodyText: "Invoice attached.",
        attachments: [{ attachmentId: "a1", filename: "notes.txt", mimeType: "text/plain", sizeBytes: 1 }],
      };
    },
  };
  const result = await discoverPeriodAttachments({ config, period: periodFromString("2026-06", config.timezone), gmail: gmail as any, query: "has:attachment", direction: "incoming" });
  assert.equal(result.attachments.length, 0);
});

test("discovery keeps two Blocky receipt image attachments with subject keyword provenance", async () => {
  const config = loadMonthlyConfig(process.cwd(), "equisix");
  const gmail = {
    async listMessages() { return { messageIds: ["blocky-jun"], nextPageToken: null }; },
    async getMessage() { return { messageId: "blocky-jun", threadId: "blocky-jun", internalDateMs: 0, localDate: "2026-07-16", timestampIso: "2026-07-16T15:04:45.000Z", direction: "incoming" as const, mailbox: "hello@equisix.com", from: "kurecko@gmail.com", to: [], cc: [], bcc: [], subject: "Fwd: Blocky jun", bodyText: "Preposielam bločky z júna.", attachments: [{ attachmentId: "a1", filename: "IMG_9262.jpeg", mimeType: "image/jpeg", sizeBytes: 6063503 }, { attachmentId: "a2", filename: "IMG_9261.jpeg", mimeType: "image/jpeg", sizeBytes: 5574777 }] }; },
  };
  const result = await discoverPeriodAttachments({ config, period: periodFromString("2026-06", config.timezone), gmail: gmail as any, query: "has:attachment filename:jpeg", direction: "incoming" });
  assert.equal(result.attachments.length, 2);
  assert.equal(result.attachments.every((attachment) => attachment.source.emailKeywordDetection?.keywordFound), true);
  assert.equal(JSON.stringify(result.attachments).includes("Preposielam bločky"), false);
});

test("OCR-spaced invoice heading classifies an invoice independently of report attachments", () => {
  const config = loadMonthlyConfig(process.cwd(), "equisix");
  const keywordConfig = loadKeywordConfig(process.cwd(), "config/accounting-keywords.yaml");
  const source = { messageId: "m1", threadId: "t1", direction: "incoming" as const, mailbox: "kurecko@gmail.com", from: "sender@example.com", recipients: ["hello@equisix.com"], subject: "Faktura", timestampIso: "2026-07-09T12:24:00.000Z", localDate: "2026-07-09", attachmentId: "a1", originalFilename: "20260009.pdf", mimeType: "application/pdf", sizeBytes: 1 };
  const extraction = { extractionStatus: "text_extracted", extractionMethod: "native_pdf_text", textPath: null, ocrTextPath: null, pageCount: 1, pageTexts: [], ocr: { outputTextPath: null, language: null, quality: null, warnings: [] } } as any;
  const classify = (filename: string, text: string) => buildClassification({ config, keywordConfig, extraction, text, document: { packagePeriod: "2026-06", source: { ...source, originalFilename: filename }, localPath: "/tmp/" + filename, normalizedFilename: filename, isPdf: true, isImage: false, sha256: filename, sizeBytes: 1, fileExtension: "pdf", unsafeSource: false, unsafeReason: null } });
  const invoice = classify("20260009.pdf", "F A K T U R A - DANOVY DOKLAD ODBERATEL: EQUISIX S. R. O. ICO: 55 035 523 Den dodania: 7.7.2026 CELKOM K UHRADE: 1231.05 EUR");
  assert.equal(invoice.finalDecision, "approved_accounting_document");
  assert.equal(invoice.deliveryDate, "2026-07-07");
  assert.notEqual(classify("toggl.pdf", "Toggl Track summary report for June").finalDecision, "approved_accounting_document");
  assert.notEqual(classify("coinomatic.pdf", "Coinomatic delivery report June 8 to July 7").finalDecision, "approved_accounting_document");
});

test("manifest completeness and preservation of multiple Gmail source references", () => {
  const manifest = buildManifest({
    config: {
      accountId: "equisix",
      accountingIdentity: "equisix",
      sourceEmail: "hello@equisix.com",
      senderEmail: "hello@equisix.com",
      accountantEmail: "hello@equisix.com",
      timezone: "Europe/Bratislava",
      scheduleDay: 15,
      scheduleTime: "09:00",
      googleConnectionId: "equisix-google-primary",
      driveGoogleConnectionId: "equisix-google-primary",
      accountingKeywordsFile: "config/accounting-keywords.yaml",
      openrouterModel: "google/gemini-2.5-flash",
      driveRootName: "equisix.com",
      driveRootFolderId: null,
      driveAccountingFolder: "Accounting",
      driveInvoicesFolder: "Invoices",
      invoiceRegisterName: "Invoice Register — Equisix",
      highRecall: true,
      automaticDocumentApproval: true,
      automaticMonthlyEmailSend: true,
      includeManifestInZip: true,
      alwaysIncludeMonthlyDriveFolderLink: true,
      alwaysIncludeZipDriveLink: true,
      zipNameTemplate: "Accounting-Package-Equisix-{period}.zip",
      gmailAttachmentLimitBytes: 1000,
      packageVersion: 1,
      scanIncomingMail: true,
      scanSentMail: true,
      periodValidation: {
        enabled: true,
        strict: true,
        allowFallbackToDeliveryDate: true,
        driveCleanupAction: "move_to_out_of_period",
      },
      ingestion: {
        nextMonthScanDays: 15,
      },
      processing: {
        mode: "local",
        incomingPath: "",
        resultsPath: "",
        pollIntervalMs: 2000,
        timeoutMs: 300000,
      },
    },
    period: "2026-06",
    duplicateCount: 1,
    excludedCount: 0,
    documents: [{
      sha256: "abc",
      localPath: "/tmp/invoice.pdf",
      originalFilename: "invoice.pdf",
      storedFilename: "stored.pdf",
      sourceMessages: [
        { messageId: "m1", threadId: "t1", direction: "incoming", mailbox: "hello@equisix.com", from: "a", recipients: ["b"], subject: "x", timestampIso: "2026-06-01T00:00:00.000Z", localDate: "2026-06-01", attachmentId: "a1", originalFilename: "invoice.pdf", mimeType: "application/pdf", sizeBytes: 1 },
        { messageId: "m2", threadId: "t2", direction: "sent", mailbox: "hello@equisix.com", from: "a", recipients: ["b"], subject: "x", timestampIso: "2026-06-02T00:00:00.000Z", localDate: "2026-06-02", attachmentId: "a2", originalFilename: "invoice.pdf", mimeType: "application/pdf", sizeBytes: 1 },
      ],
      mimeType: "application/pdf",
      sizeBytes: 1,
      extractionStatus: "text_extracted",
      textPath: null,
      keywordAnalysis: { matchedAccountingKeywords: [{ category: "invoice", keyword: "faktúra", field: "subject" }], matchedSupportingSignals: [], matchedNegativeSignals: [] },
      localAccountingScore: 10,
      localSignals: [],
      localDecisionReason: "",
      documentType: "invoice",
      accountingRelevance: "accounting_document",
      approvalStatus: "auto_approved",
      supplierName: "Supplier",
      supplierCompanyId: null,
      supplierTaxId: null,
      supplierVatId: null,
      customerName: null,
      customerCompanyId: null,
      customerTaxId: null,
      customerVatId: null,
      documentNumber: "INV-1",
      issueDate: "2026-06-01",
      dueDate: null,
      taxableSupplyDate: null,
      subtotalAmount: null,
      vatAmount: null,
      totalAmount: "10.00",
      currency: "EUR",
      confidence: 90,
      warnings: [],
      llmResultPath: null,
      llmRetriesUsed: 0,
      duplicateOfSha256: null,
      driveFileId: "id1",
      driveFileUrl: "https://drive/file/id1",
    }],
  });
  assert.equal(manifest.documentCount, 1);
  assert.equal(manifest.documents[0].sourceMessages.length, 2);
  assert.deepEqual(manifest.documents[0].matchedAccountingKeywords, ["faktúra"]);
});

test("ZIP manifest/hash equality and filename validation", () => {
  const dir = tempDir();
  const pdfPath = path.join(dir, "a.pdf");
  fs.writeFileSync(pdfPath, fakePdf());
  const zip = createDeterministicZip({
    outputPath: path.join(dir, "package.zip"),
    pdfPathsByName: [{ filename: "a.pdf", localPath: pdfPath }],
    manifestName: "manifest.json",
    manifestBuffer: Buffer.from("{}"),
  });
  validateZipAgainstManifest({
    approvedHashes: ["h1"],
    manifestHashes: ["h1"],
    manifestPdfFilenames: ["a.pdf"],
    zipPdfFilenames: zip.filenames.filter((name) => name !== "manifest.json"),
  });
  assert.ok(zip.sizeBytes > 0);
});

test("run-state update supports stage progression", () => {
  const dir = tempDir();
  const initial = initializeRunState({
    runDirectory: dir,
    accountId: "equisix",
    period: "2026-06",
    mode: "prepare_only",
    forcedResend: false,
  });
  const state = updateRunState(path.join(dir, "run-state.json"), initial, { stage: "sent_gmail_discovered" });
  assert.equal(state.stage, "sent_gmail_discovered");
});

test("monthly email idempotency and no real email during prepare-only workflow", async () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.mkdirSync(path.join(root, "data", "google-resources"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.copyFileSync(path.join(process.cwd(), "config", "equisix.yaml"), path.join(root, "config", "equisix.yaml"));
  fs.copyFileSync(path.join(process.cwd(), "config", "accounting-keywords.yaml"), path.join(root, "config", "accounting-keywords.yaml"));
  fs.writeFileSync(path.join(root, "data", "google-resources", "equisix.json"), JSON.stringify({
    resources: {
      invoice_register: {
        id: "sheet-1",
        webViewLink: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
      },
    },
  }));

  let sentCount = 0;
  const services: InvoiceMonthlyServices = {
    gmailRead: {
      async getProfileEmail() { return "hello@equisix.com"; },
      async listMessages(query, pageToken) {
        if (query.startsWith("in:sent")) return { messageIds: pageToken ? [] : ["s1"], nextPageToken: null };
        return { messageIds: pageToken ? [] : ["i1"], nextPageToken: null };
      },
      async getMessage(messageId) {
        return {
          messageId,
          threadId: messageId,
          internalDateMs: new Date(messageId === "i1" ? "2026-06-10T10:00:00.000Z" : "2026-06-11T10:00:00.000Z").getTime(),
          localDate: messageId === "i1" ? "2026-06-10" : "2026-06-11",
          timestampIso: messageId === "i1" ? "2026-06-10T10:00:00.000Z" : "2026-06-11T10:00:00.000Z",
          direction: messageId === "i1" ? "incoming" : "sent",
          mailbox: "hello@equisix.com",
          from: "supplier@example.com",
          to: ["hello@equisix.com"],
          cc: [],
          bcc: [],
          subject: messageId === "i1" ? "Faktúra 1" : "Sent invoice",
          bodyText: messageId === "i1" ? "V prílohe posielam faktúru." : "Please find the invoice attached.",
          attachments: [{ attachmentId: `a-${messageId}`, filename: messageId === "i1" ? "faktura.pdf" : "invoice.pdf", mimeType: "application/pdf", sizeBytes: 100, partPath: "0" }],
        };
      },
      async getAttachment() {
        return fakePdf();
      },
    },
    drive: {
      async getAuthorizedEmail() { return "hello@equisix.com"; },
      async ensureMonthlyFolder() {
        return {
          accountRoot: { id: "r", name: "root", mimeType: "folder", webViewLink: "https://drive/root", appProperties: {}, parents: [] },
          accounting: { id: "a", name: "Accounting", mimeType: "folder", webViewLink: "https://drive/accounting", appProperties: {}, parents: ["r"] },
          invoices: { id: "i", name: "Invoices", mimeType: "folder", webViewLink: "https://drive/invoices", appProperties: {}, parents: ["a"] },
          year: { id: "y", name: "2026", mimeType: "folder", webViewLink: "https://drive/year", appProperties: {}, parents: ["i"] },
          month: { id: "m", name: "06", mimeType: "folder", webViewLink: "https://drive/month", appProperties: {}, parents: ["y"] },
        };
      },
      async findFileByAppProperties(parentId, appProperties) {
        if (appProperties.resourceRole === "invoice_register") {
          return { id: "sheet-1", name: "Invoice Register — Equisix", mimeType: "application/vnd.google-apps.spreadsheet", webViewLink: "https://docs.google.com/spreadsheets/d/sheet-1/edit", appProperties: {}, parents: [parentId] };
        }
        return null;
      },
      async uploadOrReusePdf({ filename }) {
        return { created: true, file: { id: filename, name: filename, mimeType: "application/pdf", webViewLink: `https://drive/${filename}`, appProperties: {}, parents: ["m"] } };
      },
      async uploadOrReplaceJson({ filename }) {
        return { id: filename, name: filename, mimeType: "application/json", webViewLink: `https://drive/${filename}`, appProperties: {}, parents: ["m"] };
      },
      async uploadOrReplaceBinary({ filename }) {
        return { id: filename, name: filename, mimeType: "application/zip", webViewLink: `https://drive/${filename}`, appProperties: {}, parents: ["m"] };
      },
    },
    sheets: {
      async ensureDocumentsSheet() {},
      async upsertDocuments() { return { appended: 1, updated: 0 }; },
    },
    openrouter: {
      async extractDocument() {
        throw new Error("malformed json");
      },
    },
    gmailSend: {
      async getProfileEmail() { return "hello@equisix.com"; },
      async sendPreparedEmail() { sentCount += 1; return { id: `msg-${sentCount}` }; },
    },
  };

  const prepared = await runInvoiceMonthlyWorkflow(root, services, ["--account", "equisix", "--include-account", "kurecko", "--period", "2026-06", "--prepare-only"]);
  assert.equal(prepared.status, "prepared");
  assert.equal(sentCount, 0);

  const firstSend = await runInvoiceMonthlyWorkflow(root, services, ["--account", "equisix", "--include-account", "kurecko", "--period", "2026-06", "--confirm-send", "YES"]);
  assert.equal(firstSend.status, "sent");
  assert.equal(sentCount, 1);

  const secondSend = await runInvoiceMonthlyWorkflow(root, services, ["--account", "equisix", "--include-account", "kurecko", "--period", "2026-06", "--confirm-send", "YES"]);
  assert.equal(secondSend.status, "already_sent");
  assert.equal(sentCount, 1);
});

test("consolidated dry run separates received-date scan window from package period", async () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.copyFileSync(path.join(process.cwd(), "config", "equisix.yaml"), path.join(root, "config", "equisix.yaml"));
  fs.copyFileSync(path.join(process.cwd(), "config", "accounting-keywords.yaml"), path.join(root, "config", "accounting-keywords.yaml"));
  const services = { gmailRead: {}, drive: {}, sheets: {}, openrouter: {} } as InvoiceMonthlyServices;
  const result = await runInvoiceMonthlyWorkflow(root, services, ["--account", "equisix", "--include-account", "kurecko", "--period", "2026-06", "--scan-received-from", "2026-06-01", "--scan-received-to", "2026-07-20", "--dry-run"]);
  assert.deepEqual(result.output, {
    packagePeriod: "2026-06",
    scanReceivedFrom: "2026-06-01",
    scanReceivedTo: "2026-07-20",
    consolidated: true,
    sourceAccounts: ["equisix", "kurecko"],
    incomingQuery: "after:2026/06/01 before:2026/07/20 has:attachment (filename:pdf OR filename:png OR filename:jpg OR filename:jpeg OR filename:webp OR filename:heic OR filename:heif) -in:sent -in:spam -in:trash",
    sentQuery: "in:sent after:2026/06/01 before:2026/07/20 has:attachment (filename:pdf OR filename:png OR filename:jpg OR filename:jpeg OR filename:webp OR filename:heic OR filename:heif) -in:spam -in:trash",
    accountantEmail: "hello@equisix.com",
  });
});

test("monthly second-pass processes only the stored monthly folder and writes route files", async () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.mkdirSync(path.join(root, "data", "invoice-runs", "equisix", "monthly", "2026-06", "downloads"), { recursive: true });
  fs.copyFileSync(path.join(process.cwd(), "config", "equisix.yaml"), path.join(root, "config", "equisix.yaml"));
  fs.copyFileSync(path.join(process.cwd(), "config", "accounting-keywords.yaml"), path.join(root, "config", "accounting-keywords.yaml"));

  const monthlyDir = path.join(root, "data", "invoice-runs", "equisix", "monthly", "2026-06");
  const downloadPath = path.join(monthlyDir, "downloads", "att-demo.pdf");
  fs.writeFileSync(downloadPath, fakePdf());

  const result = await runMonthlySecondPass(root, ["--account", "equisix", "--period", "2026-06"]);
  assert.equal(result.accountId, "equisix");
  assert.equal(result.period, "2026-06");
  assert.equal(result.summary.totalDocuments, 1);
  assert.equal(fs.existsSync(path.join(monthlyDir, "second-pass-results.json")), true);
  assert.equal(fs.existsSync(path.join(monthlyDir, "approved.json")), true);
  assert.equal(fs.existsSync(path.join(monthlyDir, "review-required.json")), true);
  assert.equal(fs.existsSync(path.join(monthlyDir, "rejected.json")), true);

  const routes = JSON.parse(fs.readFileSync(path.join(monthlyDir, "second-pass-results.json"), "utf8"));
  assert.equal(routes.documents.length, 1);
  assert.equal(["APPROVED", "REVIEW_REQUIRED", "REJECTED"].includes(routes.documents[0].route), true);
});

test("monthly second-pass deduplicates identical files by content hash", async () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.mkdirSync(path.join(root, "data", "invoice-runs", "equisix", "monthly", "2026-06", "downloads"), { recursive: true });
  fs.copyFileSync(path.join(process.cwd(), "config", "equisix.yaml"), path.join(root, "config", "equisix.yaml"));
  fs.copyFileSync(path.join(process.cwd(), "config", "accounting-keywords.yaml"), path.join(root, "config", "accounting-keywords.yaml"));

  const monthlyDir = path.join(root, "data", "invoice-runs", "equisix", "monthly", "2026-06");
  const fileA = path.join(monthlyDir, "downloads", "att-a.pdf");
  const fileB = path.join(monthlyDir, "downloads", "att-b.pdf");
  const duplicatePdf = fakePdf("Invoice\nCustomer: Equisix s.r.o.\nIČO 55035523\nIssue Date: 2026-06-10\nTotal: 100.00 EUR\nVAT: 20.00");
  fs.writeFileSync(fileA, duplicatePdf);
  fs.writeFileSync(fileB, duplicatePdf);

  const result = await runMonthlySecondPass(root, ["--account", "equisix", "--period", "2026-06"]);
  assert.equal(result.summary.totalDocuments, 1);
  assert.equal(result.summary.duplicates, 1);
  assert.equal(result.documents.length, 2);

  const primary = result.documents.find((item) => item.duplicateOf === null);
  const duplicate = result.documents.find((item) => item.duplicateOf !== null);
  assert.ok(primary);
  assert.ok(duplicate);
  assert.equal(duplicate?.duplicateOf, primary?.fileId);
});
