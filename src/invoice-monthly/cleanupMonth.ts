import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMonthlyConfig } from "./config.js";
import { createDriveService } from "./googleServices.js";
import { periodFromString } from "./period.js";
import { DriveFileRecord, DriveService } from "./types.js";

type CleanupArgs = {
  account: string;
  period: string;
  dryRun: boolean;
  confirmMove: boolean;
};

export type CleanupMove = {
  sourceRunId: string | null;
  driveFileId: string;
  originalFilename: string;
  mimeType: string;
  originalDriveParentId: string | null;
  destinationFolderId: string;
  originalDriveUrl: string | null;
  cleanupAction: "move";
  cleanupTimestamp: string;
  sha256: string | null;
  reason: "reclassification_with_ocr_and_company_validation";
};

export type CleanupPlan = {
  account: string;
  period: string;
  dryRun: boolean;
  monthlyFolderId: string | null;
  monthlyFolderUrl: string | null;
  destinationFolderName: "Previous Run - Unverified";
  destinationFolderId: string;
  proposedMoves: CleanupMove[];
};

export type CleanupManifestEntry = CleanupMove & {
  destinationFolderUrl: string | null;
  moveStatus: "moved" | "skipped_already_moved" | "missing_source" | "failed";
  error: string | null;
};

export type CleanupExecutionResult = {
  account: string;
  period: string;
  dryRun: boolean;
  monthlyFolderId: string;
  monthlyFolderUrl: string | null;
  destinationFolderId: string;
  destinationFolderUrl: string | null;
  sourceRunId: string | null;
  totalCandidates: number;
  moved: number;
  skippedAlreadyMoved: number;
  missingSource: number;
  failed: number;
  manifestPath: string;
  entries: CleanupManifestEntry[];
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
    dryRun: argv.includes("--dry-run"),
    confirmMove: getArg("confirm-move") === "YES",
  };
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function latestAuditPath(projectRoot: string, account: string, period: string): string | null {
  const auditDir = path.join(projectRoot, "data", "audit", "invoice-monthly", account);
  if (!fs.existsSync(auditDir)) return null;
  const candidates = fs.readdirSync(auditDir)
    .filter((name) => name.startsWith(`${period}-`) && name.endsWith(".json"))
    .sort();
  return candidates.length ? path.join(auditDir, candidates[candidates.length - 1]) : null;
}

export function buildCleanupPlan(projectRoot: string, account: string, period: string): CleanupPlan {
  const runDir = path.join(projectRoot, "data", "invoice-runs", account, "monthly", period);
  const manifest = readJson(path.join(runDir, "manifest.json"));
  const runState = readJson(path.join(runDir, "run-state.json"));
  const preparedEmailPath = path.join(runDir, "prepared-email.json");
  const preparedEmail = fs.existsSync(preparedEmailPath) ? readJson(preparedEmailPath) : null;
  const auditPath = latestAuditPath(projectRoot, account, period);
  const audit = auditPath ? readJson(auditPath) : null;
  const sourceRunId = runState.runId ?? audit?.runId ?? null;
  const destinationFolderId = `dry-run:${account}:${period}:previous-run-unverified`;
  const cleanupTimestamp = new Date().toISOString();

  const proposedMoves: CleanupMove[] = [];
  for (const document of manifest.documents ?? []) {
    if (!document.driveFileId) continue;
    proposedMoves.push({
      sourceRunId,
      driveFileId: document.driveFileId,
      originalFilename: document.storedFilename ?? document.safeStoredFilename ?? document.originalFilename,
      mimeType: document.mimeType ?? "application/octet-stream",
      originalDriveParentId: runState.monthlyFolderId ?? audit?.monthlyFolderDriveId ?? null,
      destinationFolderId,
      originalDriveUrl: document.driveFileUrl ?? null,
      cleanupAction: "move",
      cleanupTimestamp,
      sha256: document.sha256 ?? null,
      reason: "reclassification_with_ocr_and_company_validation",
    });
  }

  if (runState.zipDriveFileId || audit?.zipDriveId) {
    proposedMoves.push({
      sourceRunId,
      driveFileId: runState.zipDriveFileId ?? audit.zipDriveId,
      originalFilename: preparedEmail?.zipFilename ?? path.basename(runState.zipPath ?? `Accounting-Package-${account}-${period}.zip`),
      mimeType: "application/zip",
      originalDriveParentId: runState.monthlyFolderId ?? audit?.monthlyFolderDriveId ?? null,
      destinationFolderId,
      originalDriveUrl: runState.zipDriveUrl ?? audit?.zipDriveUrl ?? null,
      cleanupAction: "move",
      cleanupTimestamp,
      sha256: runState.zipSha256 ?? null,
      reason: "reclassification_with_ocr_and_company_validation",
    });
  }

  const deduped = Array.from(new Map(proposedMoves.map((move) => [move.driveFileId, move])).values());
  return {
    account,
    period,
    dryRun: true,
    monthlyFolderId: runState.monthlyFolderId ?? audit?.monthlyFolderDriveId ?? null,
    monthlyFolderUrl: runState.monthlyFolderUrl ?? audit?.monthlyFolderDriveUrl ?? null,
    destinationFolderName: "Previous Run - Unverified",
    destinationFolderId,
    proposedMoves: deduped,
  };
}

function writeCleanupManifest(projectRoot: string, account: string, period: string, payload: CleanupExecutionResult): string {
  const outputPath = path.join(projectRoot, "data", "invoice-runs", account, "monthly", period, "cleanup-manifest.json");
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return outputPath;
}

function entryFromMove(move: CleanupMove, destinationFolderUrl: string | null): CleanupManifestEntry {
  return {
    ...move,
    destinationFolderUrl,
    moveStatus: "failed",
    error: null,
  };
}

function assertDriveCapability<T>(value: T | undefined, name: string): T {
  if (!value) throw new Error(`Drive service does not implement required capability: ${name}`);
  return value;
}

export async function executeCleanupPlan(params: {
  projectRoot: string;
  account: string;
  period: string;
  drive: DriveService;
}): Promise<CleanupExecutionResult> {
  const config = loadMonthlyConfig(params.projectRoot, params.account);
  const periodInfo = periodFromString(params.period, config.timezone);
  const plan = buildCleanupPlan(params.projectRoot, params.account, params.period);
  const ensureChildFolder = assertDriveCapability(params.drive.ensureChildFolder, "ensureChildFolder");
  const listFiles = assertDriveCapability(params.drive.listFiles, "listFiles");
  const moveFile = assertDriveCapability(params.drive.moveFile, "moveFile");
  const getFile = assertDriveCapability(params.drive.getFile, "getFile");

  const folderTree = await params.drive.ensureMonthlyFolder(config, periodInfo);
  const monthlyFolder = folderTree.month;
  const destinationFolder = folderTree.previousRunUnverified
    ?? await ensureChildFolder("Previous Run - Unverified", monthlyFolder.id, {
      marianAiOs: "true",
      accountId: config.accountId,
      resourceRole: "previous_run_unverified",
      packagePeriod: params.period,
    });

  const monthlyChildren = await listFiles(monthlyFolder.id);
  const destinationChildren = await listFiles(destinationFolder.id);
  const monthlyById = new Map(monthlyChildren.map((file) => [file.id, file]));
  const destinationById = new Map(destinationChildren.map((file) => [file.id, file]));

  const entries: CleanupManifestEntry[] = [];
  let moved = 0;
  let skippedAlreadyMoved = 0;
  let missingSource = 0;
  let failed = 0;

  for (const move of plan.proposedMoves) {
    const entry = entryFromMove({
      ...move,
      originalDriveParentId: monthlyFolder.id,
      destinationFolderId: destinationFolder.id,
    }, destinationFolder.webViewLink ?? null);

    try {
      if (destinationById.has(move.driveFileId)) {
        entry.moveStatus = "skipped_already_moved";
        skippedAlreadyMoved += 1;
        entries.push(entry);
        continue;
      }

      const sourceFile = monthlyById.get(move.driveFileId) ?? await getFile(move.driveFileId);
      if (!sourceFile || !sourceFile.parents.includes(monthlyFolder.id)) {
        entry.moveStatus = "missing_source";
        entry.error = sourceFile ? "File is not in the expected monthly folder." : "Source file was not found in Google Drive.";
        missingSource += 1;
        entries.push(entry);
        continue;
      }

      await moveFile(sourceFile.id, destinationFolder.id, [monthlyFolder.id]);
      entry.moveStatus = "moved";
      moved += 1;
      entries.push(entry);
    } catch (error) {
      entry.moveStatus = "failed";
      entry.error = error instanceof Error ? error.message : String(error);
      failed += 1;
      entries.push(entry);
    }
  }

  const result: CleanupExecutionResult = {
    account: params.account,
    period: params.period,
    dryRun: false,
    monthlyFolderId: monthlyFolder.id,
    monthlyFolderUrl: monthlyFolder.webViewLink ?? null,
    destinationFolderId: destinationFolder.id,
    destinationFolderUrl: destinationFolder.webViewLink ?? null,
    sourceRunId: plan.proposedMoves[0]?.sourceRunId ?? null,
    totalCandidates: plan.proposedMoves.length,
    moved,
    skippedAlreadyMoved,
    missingSource,
    failed,
    manifestPath: "",
    entries,
  };
  result.manifestPath = writeCleanupManifest(params.projectRoot, params.account, params.period, result);
  return result;
}

export async function runCleanupMonth(
  projectRoot: string,
  drive: DriveService,
  argv = process.argv.slice(2),
): Promise<CleanupPlan | CleanupExecutionResult> {
  const args = parseArgs(argv);
  const plan = buildCleanupPlan(projectRoot, args.account, args.period);

  if (!args.dryRun && !args.confirmMove) {
    throw new Error("Real cleanup requires --confirm-move YES");
  }
  if (args.dryRun) return plan;
  return executeCleanupPlan({
    projectRoot,
    account: args.account,
    period: args.period,
    drive,
  });
}

export async function main(): Promise<void> {
  const projectRoot = process.cwd();
  const args = parseArgs(process.argv.slice(2));
  const config = loadMonthlyConfig(projectRoot, args.account);
  const drive = createDriveService(config);
  const result = await runCleanupMonth(projectRoot, drive, process.argv.slice(2));
  console.log(JSON.stringify(result, null, 2));
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const modulePath = fileURLToPath(import.meta.url);

if (entryPath === modulePath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
