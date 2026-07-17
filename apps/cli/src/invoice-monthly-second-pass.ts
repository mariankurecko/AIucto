import { createJsonLog, runSecondPass } from "../../../packages/core/src/index.js";

async function main(): Promise<void> {
  const result = await runSecondPass({
    storage: { kind: "local_fs", projectRoot: process.cwd() },
    argv: process.argv.slice(2),
  });
  console.log(JSON.stringify(createJsonLog("info", "invoice.second_pass.completed", { result }), null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify(createJsonLog("error", "invoice.second_pass.failed", {
    message: error instanceof Error ? error.message : String(error),
  }), null, 2));
  process.exit(1);
});
