import fs from "node:fs";
import path from "node:path";
import { buildClassification, hasVisaEvidence } from "../../packages/classification/src/index.js";
import { loadMonthlyConfig } from "./config.js";
import { finalizeApprovedDocuments } from "./gmailDiscovery.js";
import { ensureDirectory, readJsonFile, safeFileExtension, sha256Hex, writeJsonAtomic } from "./fs.js";
import { periodFromString } from "./period.js";
import { applyPeriodValidation } from "./periodValidation.js";
import { extractDocumentText } from "./pdfExtraction.js";
import { AttachmentSourceRef, ClassifiedDocument, KeywordAnalysis, SecondPassRoute } from "./types.js";

type SecondPassArgs = {
  account: string;
  period: string;
  ocr: boolean;
};

type SecondPassDocumentRecord = {
  fileId: string;
  route: SecondPassRoute;
  sha256: string;
  originalFilename: string;
  localPath: string;
  duplicateOf: string | null;
  decision: ClassifiedDocument["finalDecision"];
  confidence: number;
  decision_reason: string;
  documentType: ClassifiedDocument["documentType"];
  documentTypeConfidence: number;
  detectionReason: string;
  decisionReason: string;
  matchType: NonNullable<ClassifiedDocument["invoiceMatchType"]>;
  type: NonNullable<ClassifiedDocument["transactionType"]> | null;
  category: ClassifiedDocument["expenseCategory"] | null;
  vendor: string | null;
  accountingRelevance: ClassifiedDocument["accountingRelevance"];
  finalDecision: ClassifiedDocument["finalDecision"];
  companyRelation: ClassifiedDocument["companyRelation"];
  overallConfidence: number;
  identityMatched: boolean;
  visa8627Matched: boolean;
  validationReasons: string[];
  rejectionReasons: string[];
  warnings: string[];
  keywordHits: string[];
  structured: {
    supplierName: string | null;
    customerName: string | null;
    documentNumber: string | null;
    issueDate: string | null;
    dueDate: string | null;
    taxableSupplyDate: string | null;
    totalAmount: string | null;
    currency: string | null;
    paymentMethod: string | null;
    receiptNumber: string | null;
  };
};

type SecondPassOutput = {
  accountId: string;
  period: string;
  monthlyFolder: string;
  generatedAt: string;
  summary: {
    totalDocuments: number;
    duplicates: number;
    approved: number;
    reviewRequired: number;
    rejected: number;
  };
  documents: SecondPassDocumentRecord[];
};

function parseArgs(argv: string[]): SecondPassArgs {
  function getArg(name: string): string | undefined {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  }

  const period = getArg("period");
  if (!period) {
    throw new Error("Missing required argument --period YYYY-MM");
  }

  return {
    account: getArg("account") ?? "equisix",
    period,
    ocr: argv.includes("--ocr"),
  };
}

function routeFor(document: ClassifiedDocument): SecondPassRoute {
  if (document.finalDecision === "approved_accounting_document") return "APPROVED";
  if (document.finalDecision === "review_required") return "REVIEW_REQUIRED";
  return "REJECTED";
}

function keywordHits(analysis: KeywordAnalysis): string[] {
  return [
    ...analysis.matchedAccountingKeywords.map((match) => `${match.category}:${match.keyword}`),
    ...analysis.matchedSupportingSignals.map((match) => `support:${match.keyword}`),
    ...analysis.matchedNegativeSignals.map((match) => `negative:${match.keyword}`),
  ];
}

function buildFileId(filePath: string): string {
  return path.basename(filePath);
}

function buildFallbackSource(filename: string): AttachmentSourceRef {
  return {
    messageId: `monthly-folder:${filename}`,
    threadId: null,
    direction: "incoming",
    mailbox: "monthly-folder",
    from: "unknown",
    recipients: [],
    subject: filename,
    timestampIso: new Date(0).toISOString(),
    localDate: "1970-01-01",
    attachmentId: filename,
    originalFilename: filename,
    mimeType: "application/octet-stream",
    sizeBytes: null,
  };
}

export async function runMonthlySecondPass(projectRoot: string, argv = process.argv.slice(2)): Promise<SecondPassOutput> {
  const args = parseArgs(argv);
  const config = loadMonthlyConfig(projectRoot, args.account);
  const period = periodFromString(args.period, config.timezone);
  const monthlyFolder = path.join(projectRoot, "data", "invoice-runs", config.accountId, "monthly", args.period);
  const downloadsDirectory = path.join(monthlyFolder, "downloads");
  const textDirectory = path.join(monthlyFolder, "text");
  const ocrDirectory = path.join(monthlyFolder, "ocr");

  if (!fs.existsSync(downloadsDirectory)) {
    throw new Error(`Monthly downloads folder not found: ${downloadsDirectory}`);
  }

  const existingClassifiedPath = path.join(monthlyFolder, "classified.json");
  const priorClassified = fs.existsSync(existingClassifiedPath)
    ? readJsonFile<ClassifiedDocument[]>(existingClassifiedPath)
    : [];
  const priorByFilename = new Map<string, ClassifiedDocument[]>();
  for (const item of priorClassified) {
    const group = priorByFilename.get(path.basename(item.localPath)) ?? [];
    group.push(item);
    priorByFilename.set(path.basename(item.localPath), group);
  }

  const accountingKeywords = await import("./accountingKeywords.js").then((mod) =>
    mod.loadKeywordConfig(projectRoot, config.accountingKeywordsFile),
  );

  ensureDirectory(textDirectory);
  ensureDirectory(ocrDirectory);

  const filePaths = fs.readdirSync(downloadsDirectory)
    .map((name) => path.join(downloadsDirectory, name))
    .filter((filePath) => fs.statSync(filePath).isFile())
    .sort();

  const classified: ClassifiedDocument[] = [];
  const routed: SecondPassDocumentRecord[] = [];
  const canonicalBySha = new Map<string, {
    fileId: string;
    route: SecondPassRoute;
    record: SecondPassDocumentRecord;
    document: ClassifiedDocument;
  }>();
  let duplicateCount = 0;

  for (const filePath of filePaths) {
    const bytes = fs.readFileSync(filePath);
    const sha256 = sha256Hex(bytes);
    const basename = path.basename(filePath);
    const fileId = buildFileId(filePath);

    const existing = canonicalBySha.get(sha256);
    if (existing) {
      duplicateCount += 1;
      routed.push({
        ...existing.record,
        fileId,
        originalFilename: basename,
        localPath: filePath,
        duplicateOf: existing.fileId,
      });
      continue;
    }

    const extension = safeFileExtension(basename, "application/octet-stream");
    const isPdf = extension === "pdf";
    const isImage = ["jpg", "jpeg", "png", "webp", "heic", "heif"].includes(extension);
    const prior = priorByFilename.get(basename)?.find((item) => item.sha256 === sha256) ?? priorByFilename.get(basename)?.[0] ?? null;
    const source = prior?.sourceMessages?.[0] ?? buildFallbackSource(prior?.originalFilename ?? basename);
    const extraction = await extractDocumentText({
      sha256,
      localPath: filePath,
      textDirectory,
      ocrDirectory,
      isPdf,
      isImage,
      ocrEnabled: args.ocr ? (config.ocrEnabled ?? true) : false,
      ocrLanguages: config.ocrLanguages ?? ["slk", "ces", "eng"],
    });
    const text = extraction.textPath && fs.existsSync(extraction.textPath)
      ? fs.readFileSync(extraction.textPath, "utf8")
      : extraction.ocrTextPath && fs.existsSync(extraction.ocrTextPath)
        ? fs.readFileSync(extraction.ocrTextPath, "utf8")
        : extraction.pageTexts.map((page) => page.text).join("\n\n");

    const document = buildClassification({
      config,
      document: {
        packagePeriod: args.period,
        source,
        localPath: filePath,
        normalizedFilename: basename,
        isPdf,
        isImage,
        sha256,
        sizeBytes: bytes.length,
        fileExtension: extension,
        unsafeSource: false,
        unsafeReason: null,
      },
      text,
      keywordConfig: accountingKeywords,
      extraction,
    });
    applyPeriodValidation(document, period, config);
    document.sourceMessages = prior?.sourceMessages ?? [source];
    document.originalFilename = prior?.originalFilename ?? basename;
    document.storedFilename = prior?.storedFilename ?? null;
    document.safeStoredFilename = prior?.safeStoredFilename ?? null;
    document.duplicateOfSha256 = prior?.duplicateOfSha256 ?? null;
    classified.push(document);

    const record: SecondPassDocumentRecord = {
      fileId,
      route: routeFor(document),
      sha256: document.sha256,
      originalFilename: document.originalFilename,
      localPath: document.localPath,
      duplicateOf: null,
      decision: document.finalDecision,
      confidence: document.decisionConfidence ?? 0.3,
      decision_reason: document.localDecisionReason,
      documentType: document.documentType,
      documentTypeConfidence: document.documentTypeConfidence ?? document.confidence,
      detectionReason: document.detectionReason ?? "unknown",
      decisionReason: document.localDecisionReason,
      matchType: document.invoiceMatchType ?? "no_match",
      type: document.transactionType ?? null,
      category: document.expenseCategory ?? null,
      vendor: document.vendor ?? null,
      accountingRelevance: document.accountingRelevance,
      finalDecision: document.finalDecision,
      companyRelation: document.companyRelation,
      overallConfidence: document.overallConfidence ?? document.confidence,
      identityMatched: Boolean(document.identityMatches?.matchedFields?.length),
      visa8627Matched: hasVisaEvidence(text, config),
      validationReasons: document.validationReasons ?? [],
      rejectionReasons: document.rejectionReasons ?? [],
      warnings: document.warnings,
      keywordHits: keywordHits(document.keywordAnalysis),
      structured: {
        supplierName: document.supplierName ?? null,
        customerName: document.customerName ?? null,
        documentNumber: document.documentNumber ?? null,
        issueDate: document.issueDate ?? null,
        dueDate: document.dueDate ?? null,
        taxableSupplyDate: document.taxableSupplyDate ?? null,
        totalAmount: document.totalAmount ?? null,
        currency: document.currency ?? null,
        paymentMethod: document.document?.paymentMethod ?? null,
        receiptNumber: document.document?.receiptNumber ?? null,
      },
    };
    routed.push(record);
    canonicalBySha.set(sha256, {
      fileId,
      route: record.route,
      record,
      document,
    });
  }

  const finalized = finalizeApprovedDocuments(classified);

  const output: SecondPassOutput = {
    accountId: config.accountId,
    period: args.period,
    monthlyFolder,
    generatedAt: new Date().toISOString(),
    summary: {
      totalDocuments: classified.length,
      duplicates: duplicateCount,
      approved: finalized.approved.length,
      reviewRequired: finalized.reviewRequired.length,
      rejected: finalized.rejected.length,
    },
    documents: routed,
  };

  writeJsonAtomic(existingClassifiedPath, classified, 0o600);
  writeJsonAtomic(path.join(monthlyFolder, "second-pass-results.json"), output, 0o600);
  writeJsonAtomic(path.join(monthlyFolder, "approved.json"), routed.filter((item) => item.route === "APPROVED"), 0o600);
  writeJsonAtomic(path.join(monthlyFolder, "review-required.json"), routed.filter((item) => item.route === "REVIEW_REQUIRED"), 0o600);
  writeJsonAtomic(path.join(monthlyFolder, "rejected.json"), routed.filter((item) => item.route === "REJECTED"), 0o600);

  return output;
}
