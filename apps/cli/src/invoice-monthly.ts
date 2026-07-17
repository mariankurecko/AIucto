import { createJsonLog, runInvoiceMonthly } from "../../../packages/core/src/index.js";

async function main(): Promise<void> {
  const result = await runInvoiceMonthly({
    storage: { kind: "local_fs", projectRoot: process.cwd() },
    argv: process.argv.slice(2),
  });
  console.log(JSON.stringify(createJsonLog("info", "invoice.monthly.completed", { result }), null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify(createJsonLog("error", "invoice.monthly.failed", {
    message: error instanceof Error ? error.message : String(error),
  }), null, 2));
  process.exit(1);
});
