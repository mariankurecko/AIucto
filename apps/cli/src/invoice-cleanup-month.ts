import { createJsonLog, runCleanupMonth } from "../../../packages/core/src/index.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const accountIndex = argv.indexOf("--account");
  const periodIndex = argv.indexOf("--period");
  const account = accountIndex >= 0 ? argv[accountIndex + 1] : "equisix";
  const period = periodIndex >= 0 ? argv[periodIndex + 1] : undefined;
  if (!period) throw new Error("Missing required argument --period YYYY-MM");
  const result = await runCleanupMonth({
    storage: { kind: "local_fs", projectRoot: process.cwd() },
    account,
    period,
  });
  console.log(JSON.stringify(createJsonLog("info", "invoice.cleanup_month.completed", { result }), null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify(createJsonLog("error", "invoice.cleanup_month.failed", {
    message: error instanceof Error ? error.message : String(error),
  }), null, 2));
  process.exit(1);
});
