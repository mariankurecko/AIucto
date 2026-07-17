import { createDriveService, createGmailReadService, createGmailSendService, createSheetsService } from "./googleServices.js";
import { loadMonthlyConfig } from "./config.js";
import { createOpenRouterService } from "./openRouterExtraction.js";
import { parseWorkflowArgs, runInvoiceMonthlyWorkflow } from "./workflow.js";

async function main(): Promise<void> {
  const projectRoot = process.cwd();
  const parsed = parseWorkflowArgs(process.argv.slice(2));
  const config = loadMonthlyConfig(projectRoot, parsed.account);
  const services = {
    gmailRead: createGmailReadService(config),
    drive: createDriveService(config),
    sheets: createSheetsService(config, "placeholder"),
    openrouter: createOpenRouterService(),
    gmailSend: createGmailSendService(config),
  };

  const googleResources = JSON.parse(
    await import("node:fs").then((fs) =>
      fs.readFileSync(`${projectRoot}/data/google-resources/${config.accountId}.json`, "utf8"),
    ),
  );
  services.sheets = createSheetsService(config, googleResources.resources.invoice_register.id);

  const result = await runInvoiceMonthlyWorkflow(projectRoot, services, process.argv.slice(2));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
