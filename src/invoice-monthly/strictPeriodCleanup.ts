import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMonthlyConfig } from "./config.js";
import { writeJsonAtomic } from "./fs.js";
import { buildManifest } from "./manifest.js";
import { periodFromString } from "./period.js";
import { applyPeriodValidation, reconcileOutOfPeriodDriveFiles } from "./periodValidation.js";
import { ClassifiedDocument, DriveService } from "./types.js";

type CleanupArgs = {
  account: string;
  period: string;
  withDrive: boolean;
};

export type StrictPeriodCleanupResult = {
  account: string;
  period: string;
  totalDocuments: number;
  approved: number;
  reviewRequired: number;
  rejected: number;
  outOfPeriodRejected: number;
  missingDateMovedToReview: number;
  drive: {
    attempted: boolean;
    moved: number;
    deleted: number;
    skipped: number;
  };
};

function parseArgs(argv: string[]): CleanupArgs {
  function getArg(name: string): string | undefined {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  }
  const period = getArg("period");
  if (!period) throw new Error("Missing required --period YYYY-MM");
  return {
    account: getArg("account") ?? "equisix",
    period,
    withDrive: argv.includes("--with-drive"),
  };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function writeOutputs(runDirectory: string, documents: ClassifiedDocument[]) {
  const approved = documents.filter((document) => document.finalDecision === "approved_accounting_document");
  const reviewRequired = documents.filter((document) => document.finalDecision === "review_required");
  const rejected = documents.filter((document) => !["approved_accounting_document", "review_required"].includes(document.finalDecision ?? "rejected_non_accounting"));
  writeJsonAtomic(path.join(runDirectory, "classified.json"), documents, 0o600);
  writeJsonAtomic(path.join(runDirectory, "approved.json"), approved, 0o600);
  writeJsonAtomic(path.join(runDirectory, "review-required.json"), reviewRequired, 0o600);
  writeJsonAtomic(path.join(runDirectory, "review_required.json"), reviewRequired, 0o600);
  writeJsonAtomic(path.join(runDirectory, "rejected.json"), rejected, 0o600);
}

export async function runStrictPeriodCleanup(params: {
  projectRoot: string;
  account: string;
  period: string;
  drive?: DriveService;
}): Promise<StrictPeriodCleanupResult> {
  const config = loadMonthlyConfig(params.projectRoot, params.account);
  const period = periodFromString(params.period, config.timezone);
  const runDirectory = path.join(params.projectRoot, "data", "invoice-runs", config.accountId, "monthly", params.period);
  const classifiedPath = path.join(runDirectory, "classified.json");
  const manifestPath = path.join(runDirectory, "manifest.json");
  const classificationSummaryPath = path.join(runDirectory, "classification-summary.json");

  if (!fs.existsSync(classifiedPath)) {
    throw new Error(`Classified output not found: ${classifiedPath}`);
  }

  const classified = readJson<ClassifiedDocument[]>(classifiedPath);
  const priorApproved = new Set(
    fs.existsSync(path.join(runDirectory, "approved.json"))
      ? readJson<ClassifiedDocument[]>(path.join(runDirectory, "approved.json")).map((document) => document.sha256)
      : [],
  );
  const priorManifest = fs.existsSync(manifestPath) ? readJson<any>(manifestPath) : null;

  let outOfPeriodRejected = 0;
  let missingDateMovedToReview = 0;
  const driveActions: Array<{
    sha256: string;
    filename: string;
    invoiceDate: string | null;
    deliveryDate: string | null;
    detectedPeriod: string | null;
    driveFileId: string | null;
    reason: "out_of_period";
  }> = [];

  for (const document of classified) {
    const before = document.finalDecision;
    applyPeriodValidation(document, period, config);
    if (before === "approved_accounting_document" && document.finalDecision === "rejected_non_accounting" && document.rejectionReasons?.includes("out_of_period")) {
      outOfPeriodRejected += 1;
      driveActions.push({
        sha256: document.sha256,
        filename: document.safeStoredFilename ?? document.storedFilename ?? document.originalFilename,
        invoiceDate: document.invoiceDate ?? null,
        deliveryDate: document.deliveryDate ?? null,
        detectedPeriod: document.detectedPeriod ?? null,
        driveFileId: document.driveFileId ?? null,
        reason: "out_of_period",
      });
      console.log(JSON.stringify({
        level: "info",
        event: "invoice.period_validation.rejected",
        filename: document.originalFilename,
        invoice_date: document.invoiceDate ?? null,
        delivery_date: document.deliveryDate ?? null,
        target_period: params.period,
        reason: "out_of_period",
      }));
    }
    if (before === "approved_accounting_document" && document.finalDecision === "review_required" && document.warnings?.includes("missing_document_date")) {
      missingDateMovedToReview += 1;
    }
  }

  writeOutputs(runDirectory, classified);

  const manifest = buildManifest({
    config,
    period: params.period,
    duplicateCount: priorManifest?.duplicateCount ?? 0,
    excludedCount: classified.length - classified.filter((document) => document.finalDecision === "approved_accounting_document").length,
    documents: classified,
    generatedAt: priorManifest?.generatedAt ?? new Date().toISOString(),
  });
  writeJsonAtomic(manifestPath, manifest, 0o600);
  writeJsonAtomic(classificationSummaryPath, {
    period: params.period,
    approved: manifest.approvedDocumentCount,
    reviewRequired: manifest.reviewRequiredCount,
    rejected: manifest.rejectedDocumentCount,
  }, 0o600);

  let driveResult = { attempted: false, moved: 0, deleted: 0, skipped: 0 };
  if (params.drive && driveActions.length > 0) {
    const folderTree = await params.drive.ensureMonthlyFolder(config, period);
    const reconciled = await reconcileOutOfPeriodDriveFiles({
      config,
      drive: params.drive,
      folderTree,
      period: params.period,
      actions: driveActions.filter((action) => priorApproved.has(action.sha256)),
    });
    driveResult = { attempted: true, ...reconciled };
  }

  return {
    account: config.accountId,
    period: params.period,
    totalDocuments: classified.length,
    approved: manifest.approvedDocumentCount,
    reviewRequired: manifest.reviewRequiredCount,
    rejected: manifest.rejectedDocumentCount,
    outOfPeriodRejected,
    missingDateMovedToReview,
    drive: driveResult,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const projectRoot = process.cwd();
  const drive = args.withDrive
    ? await import("./googleServices.js").then((mod) => mod.createDriveService(loadMonthlyConfig(projectRoot, args.account)))
    : undefined;
  const result = await runStrictPeriodCleanup({
    projectRoot,
    account: args.account,
    period: args.period,
    drive,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
