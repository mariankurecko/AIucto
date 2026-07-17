import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { executeCleanupPlan, runCleanupMonth } from "../src/invoice-monthly/cleanupMonth.js";
import { DriveFileRecord, DriveService } from "../src/invoice-monthly/types.js";

function tempProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-live-"));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.mkdirSync(path.join(root, "data", "invoice-runs", "equisix", "monthly", "2026-06"), { recursive: true });
  fs.mkdirSync(path.join(root, "data", "audit", "invoice-monthly", "equisix"), { recursive: true });
  fs.copyFileSync(path.join(process.cwd(), "config", "equisix.yaml"), path.join(root, "config", "equisix.yaml"));
  return root;
}

function seedCleanupState(root: string, driveIds = ["file-1", "zip-1"]): void {
  const runDir = path.join(root, "data", "invoice-runs", "equisix", "monthly", "2026-06");
  const auditDir = path.join(root, "data", "audit", "invoice-monthly", "equisix");
  fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify({
    documents: [
      { sha256: "sha-1", originalFilename: "one.pdf", storedFilename: "one.pdf", driveFileId: driveIds[0], driveFileUrl: `https://drive/${driveIds[0]}`, mimeType: "application/pdf" },
    ],
  }));
  fs.writeFileSync(path.join(runDir, "run-state.json"), JSON.stringify({
    runId: "run-1",
    monthlyFolderId: "month-1",
    monthlyFolderUrl: "https://drive/month-1",
    zipDriveFileId: driveIds[1],
    zipDriveUrl: `https://drive/${driveIds[1]}`,
    zipPath: "/tmp/Accounting-Package-Equisix-2026-06.zip",
    zipSha256: "zipsha",
  }));
  fs.writeFileSync(path.join(runDir, "prepared-email.json"), JSON.stringify({ zipFilename: "Accounting-Package-Equisix-2026-06.zip" }));
  fs.writeFileSync(path.join(auditDir, "2026-06-2026-07-17T13-08-51-107Z.json"), JSON.stringify({ runId: "run-1", monthlyFolderDriveId: "month-1", monthlyFolderDriveUrl: "https://drive/month-1" }));
}

function makeFile(id: string, name: string, parent: string): DriveFileRecord {
  return { id, name, mimeType: "application/pdf", webViewLink: `https://drive/${id}`, appProperties: {}, parents: [parent] };
}

function fakeDrive(options?: {
  existingPreviousFolder?: boolean;
  destinationHasIds?: string[];
  missingIds?: string[];
  failMoveIds?: string[];
}): DriveService & { moveCalls: Array<{ fileId: string; addParentId: string; removeParentIds: string[] }>; createdFolders: string[]; deleteCalls: number; gmailSendCalls: number; files: Map<string, DriveFileRecord>; } {
  const moveCalls: Array<{ fileId: string; addParentId: string; removeParentIds: string[] }> = [];
  const createdFolders: string[] = [];
  const files = new Map<string, DriveFileRecord>([
    ["file-1", makeFile("file-1", "one.pdf", "month-1")],
    ["zip-1", { id: "zip-1", name: "Accounting-Package-Equisix-2026-06.zip", mimeType: "application/zip", webViewLink: "https://drive/zip-1", appProperties: {}, parents: ["month-1"] }],
  ]);
  const previousFolder = options?.existingPreviousFolder
    ? { id: "prev-1", name: "Previous Run - Unverified", mimeType: "application/vnd.google-apps.folder", webViewLink: "https://drive/prev-1", appProperties: {}, parents: ["month-1"] }
    : undefined;
  if (previousFolder) files.set(previousFolder.id, previousFolder);
  for (const id of options?.destinationHasIds ?? []) {
    const existing = files.get(id);
    if (existing) existing.parents = ["prev-1"];
  }

  return {
    moveCalls,
    createdFolders,
    deleteCalls: 0,
    gmailSendCalls: 0,
    files,
    async getAuthorizedEmail() { return "hello@equisix.com"; },
    async ensureMonthlyFolder() {
      return {
        accountRoot: { id: "root", name: "equisix.com", mimeType: "application/vnd.google-apps.folder", webViewLink: "https://drive/root", appProperties: {}, parents: [] },
        accounting: { id: "acct", name: "Accounting", mimeType: "application/vnd.google-apps.folder", webViewLink: "https://drive/acct", appProperties: {}, parents: ["root"] },
        invoices: { id: "inv", name: "Invoices", mimeType: "application/vnd.google-apps.folder", webViewLink: "https://drive/inv", appProperties: {}, parents: ["acct"] },
        year: { id: "year", name: "2026", mimeType: "application/vnd.google-apps.folder", webViewLink: "https://drive/year", appProperties: {}, parents: ["inv"] },
        month: { id: "month-1", name: "06", mimeType: "application/vnd.google-apps.folder", webViewLink: "https://drive/month-1", appProperties: {}, parents: ["year"] },
        approved: { id: "approved", name: "Approved Documents", mimeType: "application/vnd.google-apps.folder", webViewLink: "https://drive/approved", appProperties: {}, parents: ["month-1"] },
        review: { id: "review", name: "Review Required", mimeType: "application/vnd.google-apps.folder", webViewLink: "https://drive/review", appProperties: {}, parents: ["month-1"] },
        previousRunUnverified: previousFolder,
      };
    },
    async ensureChildFolder(name, parentId) {
      createdFolders.push(name);
      const folder = { id: "prev-1", name, mimeType: "application/vnd.google-apps.folder", webViewLink: "https://drive/prev-1", appProperties: {}, parents: [parentId] };
      files.set(folder.id, folder);
      return folder;
    },
    async findFileByAppProperties() { return null; },
    async listFiles(parentId) {
      return [...files.values()].filter((file) => file.parents.includes(parentId));
    },
    async getFile(fileId) {
      if (options?.missingIds?.includes(fileId)) return null;
      return files.get(fileId) ?? null;
    },
    async moveFile(fileId, addParentId, removeParentIds) {
      if (options?.failMoveIds?.includes(fileId)) throw new Error(`move failed for ${fileId}`);
      const file = files.get(fileId);
      if (!file) throw new Error(`missing ${fileId}`);
      file.parents = file.parents.filter((parent) => !removeParentIds.includes(parent));
      if (!file.parents.includes(addParentId)) file.parents.push(addParentId);
      moveCalls.push({ fileId, addParentId, removeParentIds });
      return file;
    },
    async uploadOrReuseFile() { throw new Error("not used"); },
    async uploadOrReplaceJson() { throw new Error("not used"); },
    async uploadOrReplaceBinary() { throw new Error("not used"); },
  };
}

test("destination folder creation", async () => {
  const root = tempProject();
  seedCleanupState(root);
  const drive = fakeDrive();
  const result = await executeCleanupPlan({ projectRoot: root, account: "equisix", period: "2026-06", drive });
  assert.deepEqual(drive.createdFolders, ["Previous Run - Unverified"]);
  assert.equal(result.destinationFolderId, "prev-1");
});

test("existing destination folder reuse", async () => {
  const root = tempProject();
  seedCleanupState(root);
  const drive = fakeDrive({ existingPreviousFolder: true });
  const result = await executeCleanupPlan({ projectRoot: root, account: "equisix", period: "2026-06", drive });
  assert.deepEqual(drive.createdFolders, []);
  assert.equal(result.destinationFolderId, "prev-1");
});

test("parent update move", async () => {
  const root = tempProject();
  seedCleanupState(root);
  const drive = fakeDrive({ existingPreviousFolder: true });
  const result = await executeCleanupPlan({ projectRoot: root, account: "equisix", period: "2026-06", drive });
  assert.equal(result.moved, 2);
  assert.deepEqual(drive.moveCalls[0], { fileId: "file-1", addParentId: "prev-1", removeParentIds: ["month-1"] });
});

test("already-moved file skip", async () => {
  const root = tempProject();
  seedCleanupState(root);
  const drive = fakeDrive({ existingPreviousFolder: true, destinationHasIds: ["file-1"] });
  const result = await executeCleanupPlan({ projectRoot: root, account: "equisix", period: "2026-06", drive });
  assert.equal(result.skippedAlreadyMoved, 1);
});

test("missing source file handling", async () => {
  const root = tempProject();
  seedCleanupState(root);
  const drive = fakeDrive({ existingPreviousFolder: true, missingIds: ["file-1"] });
  drive.files.delete("file-1");
  const result = await executeCleanupPlan({ projectRoot: root, account: "equisix", period: "2026-06", drive });
  assert.equal(result.missingSource, 1);
});

test("partial failure handling", async () => {
  const root = tempProject();
  seedCleanupState(root);
  const drive = fakeDrive({ existingPreviousFolder: true, failMoveIds: ["zip-1"] });
  const result = await executeCleanupPlan({ projectRoot: root, account: "equisix", period: "2026-06", drive });
  assert.equal(result.moved, 1);
  assert.equal(result.failed, 1);
});

test("idempotent rerun", async () => {
  const root = tempProject();
  seedCleanupState(root);
  const drive = fakeDrive({ existingPreviousFolder: true });
  const first = await executeCleanupPlan({ projectRoot: root, account: "equisix", period: "2026-06", drive });
  const second = await executeCleanupPlan({ projectRoot: root, account: "equisix", period: "2026-06", drive });
  assert.equal(first.moved, 2);
  assert.equal(second.skippedAlreadyMoved, 2);
});

test("no delete calls and no Gmail send calls", async () => {
  const root = tempProject();
  seedCleanupState(root);
  const drive = fakeDrive({ existingPreviousFolder: true });
  await executeCleanupPlan({ projectRoot: root, account: "equisix", period: "2026-06", drive });
  assert.equal(drive.deleteCalls, 0);
  assert.equal(drive.gmailSendCalls, 0);
});

test("dry-run stays local", async () => {
  const root = tempProject();
  seedCleanupState(root);
  const drive = fakeDrive({ existingPreviousFolder: true });
  const result = await runCleanupMonth(root, drive, ["--account", "equisix", "--period", "2026-06", "--dry-run"]);
  assert.equal("proposedMoves" in result, true);
  assert.equal(drive.moveCalls.length, 0);
});
