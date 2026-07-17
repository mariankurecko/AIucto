import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadGoogleTokenOrThrow, resolveGoogleTokenForCapability } from "../src/googleAuth.js";

function withTempHome<T>(fn: () => T): T {
  const originalHome = process.env.HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "google-auth-test-"));
  process.env.HOME = tempHome;
  try {
    return fn();
  } finally {
    process.env.HOME = originalHome;
  }
}

function writeToken(filename: string, scopes: string[]) {
  const tokenDir = path.join(os.homedir(), ".config", "marian-ai-os", "secrets", "google", "tokens");
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(path.join(tokenDir, filename), JSON.stringify({
    scopes,
    credentials: {
      refresh_token: "refresh-token",
      scope: scopes.join(" "),
    },
  }));
}

test("shared invoice-core token is reused for Gmail read and Drive/Sheets", () => withTempHome(() => {
  writeToken("equisix-google-primary-invoice-core.json", [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/drive.file",
  ]);

  const gmailRead = resolveGoogleTokenForCapability("equisix-google-primary", "gmail_read");
  const driveSheets = resolveGoogleTokenForCapability("equisix-google-primary", "drive_sheets");

  assert.equal(gmailRead?.filename, "equisix-google-primary-invoice-core.json");
  assert.equal(driveSheets?.filename, "equisix-google-primary-invoice-core.json");
}));

test("legacy split tokens are still accepted per capability", () => withTempHome(() => {
  writeToken("equisix-google-primary.json", [
    "https://www.googleapis.com/auth/gmail.readonly",
  ]);
  writeToken("equisix-google-primary-drive-sheets.json", [
    "https://www.googleapis.com/auth/drive.file",
  ]);

  const gmailRead = resolveGoogleTokenForCapability("equisix-google-primary", "gmail_read");
  const driveSheets = resolveGoogleTokenForCapability("equisix-google-primary", "drive_sheets");

  assert.equal(gmailRead?.filename, "equisix-google-primary.json");
  assert.equal(driveSheets?.filename, "equisix-google-primary-drive-sheets.json");
}));

test("missing token error includes remediation command", () => withTempHome(() => {
  assert.throws(
    () => loadGoogleTokenOrThrow("equisix-google-primary", "gmail_send"),
    (error: unknown) => {
      assert.match(String(error), /Missing Google OAuth token/);
      assert.match(String(error), /equisix-google-primary-gmail-send\.json/);
      assert.match(String(error), /npm run google:authorize:gmail-send -- --connection equisix-google-primary/);
      return true;
    },
  );
}));
