import { createDriveService, createGmailReadService, createGmailSendService, createSheetsService } from "../../google/src/index.js";
import { loadMonthlyConfig } from "../../../src/invoice-monthly/config.js";
import { createOpenRouterService } from "../../../src/invoice-monthly/openRouterExtraction.js";
import { buildCleanupPlan } from "../../../src/invoice-monthly/cleanupMonth.js";
import { runInvoiceMonthlyWorkflow } from "../../../src/invoice-monthly/workflow.js";
import { runMonthlySecondPass } from "../../../src/invoice-monthly/secondPass.js";

function resolveAccount(argv: string[]): string {
  const index = argv.indexOf("--account");
  return index >= 0 ? argv[index + 1] : "equisix";
}

export async function runInvoiceMonthlyCli(projectRoot: string, argv = process.argv.slice(2)): Promise<void> {
  const config = loadMonthlyConfig(projectRoot, resolveAccount(argv));
  const services = {
    gmailRead: createGmailReadService(config),
    drive: createDriveService(config),
    sheets: createSheetsService(config, "placeholder"),
    openrouter: createOpenRouterService(),
    gmailSend: createGmailSendService(config),
  };
  const result = await runInvoiceMonthlyWorkflow(projectRoot, services, argv);
  console.log(JSON.stringify(result, null, 2));
}

export async function runInvoiceMonthlySecondPassCli(projectRoot: string, argv = process.argv.slice(2)): Promise<void> {
  const result = await runMonthlySecondPass(projectRoot, argv);
  console.log(JSON.stringify(result, null, 2));
}

export async function runInvoiceCleanupMonthCli(projectRoot: string, argv = process.argv.slice(2)): Promise<void> {
  const account = resolveAccount(argv);
  const periodIndex = argv.indexOf("--period");
  const period = periodIndex >= 0 ? argv[periodIndex + 1] : undefined;
  if (!period) throw new Error("Missing required argument --period YYYY-MM");
  const plan = buildCleanupPlan(projectRoot, account, period);
  console.log(JSON.stringify(plan, null, 2));
}
