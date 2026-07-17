import { spawnSync } from "node:child_process";
import { invoiceGoogleTokenPurposes, loadGoogleConnection, resolveGoogleTokenForCapability, summarizeGoogleTokenExpectations } from "./googleAuth.js";
import { loadMonthlyConfig } from "./invoice-monthly/config.js";

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function runAuthorization(connectionId: string, purpose: "invoice_core" | "gmail_send") {
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/googleAuthorizeConnection.ts", "--connection", connectionId, "--purpose", purpose],
    { stdio: "inherit" },
  );
  if (child.status !== 0) {
    fail(`Authorization step failed for purpose '${purpose}'.`);
  }
}

async function main(): Promise<void> {
  const accountId = getArg("account");
  if (!accountId) {
    fail("Missing --account <account-id>.");
  }

  const projectRoot = process.cwd();
  const config = loadMonthlyConfig(projectRoot, accountId);
  const connection = loadGoogleConnection(projectRoot, config.googleConnectionId);
  const requiredPurposes = invoiceGoogleTokenPurposes({
    automaticMonthlyEmailSend: config.automaticMonthlyEmailSend,
  });
  const expectations = summarizeGoogleTokenExpectations(connection.id, requiredPurposes);

  console.log("Google invoice authorization bootstrap");
  console.log("--------------------------------------");
  console.log(`Account: ${accountId}`);
  console.log(`Connection: ${connection.id}`);
  console.log(`Identity: ${connection.identity}`);
  console.log("");
  console.log("Required tokens:");
  for (const requirement of expectations) {
    console.log(`- ${requirement.filename}: ${requirement.scopes.join(", ")}`);
  }
  console.log("");

  for (const purpose of requiredPurposes) {
    const satisfied = purpose === "invoice_core"
      ? resolveGoogleTokenForCapability(connection.id, "gmail_read") &&
        resolveGoogleTokenForCapability(connection.id, "drive_sheets")
      : resolveGoogleTokenForCapability(connection.id, "gmail_send");
    if (satisfied) {
      const label = purpose === "invoice_core" ? "invoice core capabilities" : "gmail send";
      console.log(`Already authorized: ${label}`);
      continue;
    }
    console.log(`Authorizing missing token: ${getGoogleTokenPurposeLabel(purpose)}`);
    runAuthorization(connection.id, purpose);
    const stillMissing = purpose === "invoice_core"
      ? !resolveGoogleTokenForCapability(connection.id, "gmail_read") ||
        !resolveGoogleTokenForCapability(connection.id, "drive_sheets")
      : !resolveGoogleTokenForCapability(connection.id, "gmail_send");
    if (stillMissing) {
      fail(`Authorization completed but token resolution still failed for '${purpose}'.`);
    }
  }

  console.log("");
  console.log("Google invoice authorization bootstrap passed.");
}

function getGoogleTokenPurposeLabel(purpose: "invoice_core" | "gmail_send"): string {
  return purpose === "invoice_core" ? "invoice core" : "gmail send";
}

void main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
