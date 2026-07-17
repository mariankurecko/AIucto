import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { google } from "googleapis";
import YAML from "yaml";

type GoogleConnection = {
  id: string;
  account_id: string;
  provider: string;
  identity: string;
  enabled: boolean;
  status: string;
};

type InvoiceAccountConfig = {
  account_id: string;
  enabled: boolean;
  connection_ids: string[];
  search_terms: string[];
};

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function getPositiveIntegerArg(name: string, fallback: number): number {
  const raw = getArg(name);
  if (!raw) return fallback;

  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer.`);
  }

  return value;
}

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function quoteGmailTerm(term: string): string {
  const trimmed = term.trim();
  if (!trimmed) return "";
  return /\s/.test(trimmed) ? `"${trimmed.replaceAll('"', '\\"')}"` : trimmed;
}

function getHeader(
  headers: Array<{ name?: string | null; value?: string | null }> | undefined,
  name: string,
): string {
  const match = headers?.find(
    (header) => header.name?.toLowerCase() === name.toLowerCase(),
  );
  return match?.value?.trim() || "(missing)";
}

const connectionId = getArg("connection");
if (!connectionId) {
  fail("Missing --connection <connection-id>.");
}

const days = getPositiveIntegerArg("days", 30);
const limit = Math.min(getPositiveIntegerArg("limit", 25), 100);

const projectDir = process.cwd();
const connectionsPath = path.join(projectDir, "config", "connections.yaml");
const workflowPath = path.join(
  projectDir,
  "config",
  "workflows",
  "invoice-collector.yaml",
);
const clientPath = path.join(
  os.homedir(),
  ".config",
  "marian-ai-os",
  "secrets",
  "google",
  "google-oauth-client.json",
);
const tokenPath = path.join(
  os.homedir(),
  ".config",
  "marian-ai-os",
  "secrets",
  "google",
  "tokens",
  `${connectionId}.json`,
);

for (const requiredPath of [
  connectionsPath,
  workflowPath,
  clientPath,
  tokenPath,
]) {
  if (!fs.existsSync(requiredPath)) {
    fail(`Required file not found: ${requiredPath}`);
  }
}

const connectionsConfig = YAML.parse(
  fs.readFileSync(connectionsPath, "utf8"),
) as { connections?: GoogleConnection[] };

const workflowConfig = YAML.parse(
  fs.readFileSync(workflowPath, "utf8"),
) as { account_configs?: InvoiceAccountConfig[] };

const connection = connectionsConfig.connections?.find(
  (item) => item.id === connectionId,
);

if (!connection) {
  fail(`Unknown connection: ${connectionId}`);
}

if (connection.provider !== "google") {
  fail(`Connection '${connectionId}' is not a Google connection.`);
}

if (!connection.enabled || connection.status !== "connected_readonly") {
  fail(
    `Connection '${connectionId}' must be enabled with status connected_readonly.`,
  );
}

const accountConfig = workflowConfig.account_configs?.find(
  (item) => item.account_id === connection.account_id,
);

if (!accountConfig?.enabled) {
  fail(
    `Invoice Collector is not enabled for account '${connection.account_id}'.`,
  );
}

if (!accountConfig.connection_ids.includes(connection.id)) {
  fail(
    `Connection '${connection.id}' is not authorized for the Invoice Collector account configuration.`,
  );
}

const terms = accountConfig.search_terms
  .map(quoteGmailTerm)
  .filter(Boolean);

if (terms.length === 0) {
  fail(`No Invoice Collector search terms configured for '${connection.account_id}'.`);
}

const gmailQuery = [
  `newer_than:${days}d`,
  "has:attachment",
  "filename:pdf",
  `{${terms.join(" ")}}`,
].join(" ");

const clientFile = JSON.parse(fs.readFileSync(clientPath, "utf8")) as {
  installed?: {
    client_id?: string;
    client_secret?: string;
  };
};

const tokenRecord = JSON.parse(fs.readFileSync(tokenPath, "utf8")) as {
  connection_id?: string;
  account_id?: string;
  identity?: string;
  scopes?: string[];
  credentials?: {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    token_type?: string;
    expiry_date?: number;
  };
};

const installed = clientFile.installed;

if (!installed?.client_id || !installed.client_secret) {
  fail("OAuth Desktop client configuration is invalid.");
}

if (
  tokenRecord.connection_id !== connection.id ||
  tokenRecord.account_id !== connection.account_id ||
  tokenRecord.identity?.toLowerCase() !== connection.identity.toLowerCase()
) {
  fail("Stored token metadata does not match the Connection Registry.");
}

if (!tokenRecord.credentials?.refresh_token) {
  fail("Refresh token is missing.");
}

const oauth2Client = new google.auth.OAuth2(
  installed.client_id,
  installed.client_secret,
);
oauth2Client.setCredentials(tokenRecord.credentials);

try {
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  const profile = await gmail.users.getProfile({ userId: "me" });
  const authorizedIdentity = profile.data.emailAddress?.toLowerCase();

  if (authorizedIdentity !== connection.identity.toLowerCase()) {
    fail(
      `Authorized Gmail identity '${authorizedIdentity}' does not match '${connection.identity}'.`,
    );
  }

  const listResponse = await gmail.users.messages.list({
    userId: "me",
    q: gmailQuery,
    maxResults: limit,
  });

  const messageRefs = listResponse.data.messages ?? [];
  const candidates = await Promise.all(
    messageRefs.map(async (message) => {
      if (!message.id) return null;

      const metadata = await gmail.users.messages.get({
        userId: "me",
        id: message.id,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"],
      });

      const headers = metadata.data.payload?.headers;

      return {
        id: message.id,
        from: getHeader(headers, "From"),
        subject: getHeader(headers, "Subject"),
        date: getHeader(headers, "Date"),
      };
    }),
  );

  const safeCandidates = candidates.filter(
    (candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate),
  );

  console.log("Invoice candidate discovery passed.");
  console.log("-----------------------------------");
  console.log(`Connection: ${connection.id}`);
  console.log(`Account: ${connection.account_id}`);
  console.log(`Identity: ${authorizedIdentity}`);
  console.log(`Lookback: ${days} days`);
  console.log(`Result display limit: ${limit}`);
  console.log(`Estimated matching messages: ${listResponse.data.resultSizeEstimate ?? 0}`);
  console.log(`Displayed candidates: ${safeCandidates.length}`);
  console.log(`Query: ${gmailQuery}`);
  console.log("");
  console.log("Candidate metadata:");
  console.log("");

  if (safeCandidates.length === 0) {
    console.log("No matching messages found.");
  } else {
    safeCandidates.forEach((candidate, index) => {
      console.log(`[${index + 1}] ${candidate.subject}`);
      console.log(`    From: ${candidate.from}`);
      console.log(`    Date: ${candidate.date}`);
      console.log(`    Gmail message ID: ${candidate.id}`);
      console.log("");
    });
  }

  console.log("Email bodies read: no");
  console.log("Attachment contents read: no");
  console.log("Attachments downloaded: no");
  console.log("Write capability used: no");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  fail(`Invoice candidate discovery failed: ${message}`);
}
