import { runMonthlySecondPass } from "./secondPass.js";

async function main(): Promise<void> {
  const result = await runMonthlySecondPass(process.cwd(), process.argv.slice(2));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
