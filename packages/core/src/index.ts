import { createDriveService, createGmailReadService, createGmailSendService, createSheetsService } from "../../google/src/index.js";
import { loadMonthlyConfig } from "../../../src/invoice-monthly/config.js";
import { buildCleanupPlan } from "../../../src/invoice-monthly/cleanupMonth.js";
import { createOpenRouterService } from "../../../src/invoice-monthly/openRouterExtraction.js";
import { runMonthlySecondPass } from "../../../src/invoice-monthly/secondPass.js";
import { runInvoiceMonthlyWorkflow } from "../../../src/invoice-monthly/workflow.js";
import { InvoiceMonthlyServices } from "../../../src/invoice-monthly/types.js";

function resolveAccount(argv: string[]): string {
  const index = argv.indexOf("--account");
  return index >= 0 ? argv[index + 1] : "equisix";
}

export type LocalStorageAdapter = {
  kind: "local_fs";
  projectRoot: string;
};

export type CoreRunOptions = {
  storage: LocalStorageAdapter;
  argv?: string[];
  services?: InvoiceMonthlyServices;
};

export function createJsonLog(level: "info" | "error", event: string, payload: Record<string, unknown>) {
  return {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...payload,
  };
}

function createDefaultServices(projectRoot: string, argv: string[]): InvoiceMonthlyServices {
  const config = loadMonthlyConfig(projectRoot, resolveAccount(argv));
  return {
    gmailRead: createGmailReadService(config),
    drive: createDriveService(config),
    sheets: createSheetsService(config, "placeholder"),
    openrouter: createOpenRouterService(),
    gmailSend: createGmailSendService(config),
  };
}

export async function runInvoiceMonthly(options: CoreRunOptions) {
  const argv = options.argv ?? process.argv.slice(2);
  const services = options.services ?? createDefaultServices(options.storage.projectRoot, argv);
  return runInvoiceMonthlyWorkflow(options.storage.projectRoot, services, argv);
}

export async function runSecondPass(options: CoreRunOptions) {
  const argv = options.argv ?? process.argv.slice(2);
  return runMonthlySecondPass(options.storage.projectRoot, argv);
}

export async function runCleanupMonth(options: { storage: LocalStorageAdapter; account: string; period: string; }) {
  return buildCleanupPlan(options.storage.projectRoot, options.account, options.period);
}

export * from "../../../src/invoice-monthly/cleanupMonth.js";
export * from "../../../src/invoice-monthly/workflow.js";
export * from "../../../src/invoice-monthly/secondPass.js";
