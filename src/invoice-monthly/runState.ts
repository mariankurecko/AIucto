import fs from "node:fs";
import path from "node:path";
import { ensureDirectory, readJsonFile, writeJsonAtomic } from "./fs.js";
import { RunStage, RunState, WorkflowMode } from "./types.js";

export function buildRunDirectory(projectRoot: string, accountId: string, period: string): string {
  return path.join(projectRoot, "data", "invoice-runs", accountId, "monthly", period);
}

export function buildRunStatePath(runDirectory: string): string {
  return path.join(runDirectory, "run-state.json");
}

export function initializeRunState(params: {
  runDirectory: string;
  accountId: string;
  period: string;
  mode: WorkflowMode;
  forcedResend: boolean;
}): RunState {
  ensureDirectory(params.runDirectory);
  const statePath = buildRunStatePath(params.runDirectory);
  if (fs.existsSync(statePath)) {
    return readJsonFile<RunState>(statePath);
  }
  const state: RunState = {
    runId: `${params.period}-${Date.now()}`,
    accountId: params.accountId,
    period: params.period,
    mode: params.mode,
    stage: "initialized",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    preparedEmailPath: null,
    monthlyFolderId: null,
    monthlyFolderUrl: null,
    manifestPath: null,
    manifestDriveFileId: null,
    manifestDriveUrl: null,
    zipPath: null,
    zipSha256: null,
    zipBytes: null,
    zipDriveFileId: null,
    zipDriveUrl: null,
    invoiceRegisterUrl: null,
    emailMessageId: null,
    emailSentAt: null,
    documentHashes: [],
    forcedResend: params.forcedResend,
  };
  writeRunState(statePath, state);
  return state;
}

export function writeRunState(statePath: string, state: RunState): void {
  writeJsonAtomic(statePath, {
    ...state,
    updatedAt: new Date().toISOString(),
  }, 0o600);
}

export function updateRunState(
  statePath: string,
  state: RunState,
  updates: Partial<RunState> & { stage?: RunStage },
): RunState {
  const nextState: RunState = {
    ...state,
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  writeRunState(statePath, nextState);
  return nextState;
}
