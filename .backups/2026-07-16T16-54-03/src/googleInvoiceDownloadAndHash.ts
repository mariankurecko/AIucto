import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { google, gmail_v1 } from "googleapis";
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

type AttachmentCandidate = {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number | null;
};

type ManifestRecord = {
  messageId: string;
  threadId: string | null;
  from: string;
  subject: string;
  date: string;
  originalFilename: string;
  storedFilename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  exactDuplicateWithinRun: boolean;
  duplicateOfSha256: string | null;
};

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveInt(name: string, fallback: number): number {
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

function headerValue(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  const header = headers?.find(
    (item) => item.name?.toLowerCase() === name.toLowerCase(),
  );
  return header?.value?.trim() || "(missing)";
}

function collectPdfAttachments(
  part: gmail_v1.Schema$MessagePart | undefined,
  results: AttachmentCandidate[] = [],
): AttachmentCandidate[] {
  if (!part) return results;

  const filename = part.filename?.trim() || "";
  const mimeType = part.mimeType?.toLowerCase() || "";
  const attachmentId = part.body?.attachmentId || "";
  const isPdf =
    mimeType === "application/pdf" || filename.toLowerCase().endsWith(".pdf");

  if (isPdf && attachmentId) {
    results.push({
      attachmentId,
      filename: filename || "attachment.pdf",
      mimeType: mimeType || "application/pdf",
      size: typeof part.body?.size === "number" ? part.body.size : null,
    });
  }

  for (const child of part.parts ?? []) {
    collectPdfAttachments(child, results);
  }

  return results;
}

function decodeBase64Url(data: string): Buffer {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  const padded = padding === 0 ? normalized : normalized + "=".repeat(4 - padding);
  return Buffer.from(padded, "base64");
}

function sanitizeFilename(value: string): string {
  const ext = path.extname(value).toLowerCase() === ".pdf" ? ".pdf" : ".pdf";
  const base = path.basename(value, path.extname(value))
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "-")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 120);

  return `${base || "attachment"}${ext}`;
}

function uniqueFilename(directory: string, preferred: string): string {
  let candidate = preferred;
  let counter = 2;

  while (fs.existsSync(path.join(directory, candidate))) {
    const ext = path.extname(preferred);
    const base = path.basename(preferred, ext);
    candidate = `${base}_${counter}${ext}`;
    counter += 1;
  }

  return candidate;
}

const connectionId = getArg("connection");
if (!connectionId) fail("Missing --connection <connection-id>.");

const days = positiveInt("days", 30);
const limit = Math.min(positiveInt("limit", 25), 100);
const maxMb = Math.min(positiveInt("max-mb", 20), 100);
const maxBytes = maxMb * 1024 * 1024;

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

for (const required of [
  connectionsPath,
  workflowPath,
  clientPath,
  tokenPath,
]) {
  if (!fs.existsSync(required)) fail(`Required file not found: ${required}`);
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

if (!connection) fail(`Unknown connection: ${connectionId}`);
if (connection.provider !== "google") fail("Connection is not Google.");
if (!connection.enabled || connection.status !== "connected_readonly") {
  fail("Connection must be enabled with status connected_readonly.");
}

const accountConfig = workflowConfig.account_configs?.find(
  (item) => item.account_id === connection.account_id,
);

if (!accountConfig?.enabled) {
  fail(`Invoice Collector is disabled for account '${connection.account_id}'.`);
}

if (!accountConfig.connection_ids.includes(connection.id)) {
  fail(`Connection '${connection.id}' is not allowed for Invoice Collector.`);
}

const terms = accountConfig.search_terms.map(quoteGmailTerm).filter(Boolean);
const query = [
  `newer_than:${days}d`,
  "has:attachment",
  "filename:pdf",
  `{${terms.join(" ")}}`,
].join(" ");

const clientFile = JSON.parse(fs.readFileSync(clientPath, "utf8"));
const tokenRecord = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
const installed = clientFile.installed;

if (!installed?.client_id || !installed?.client_secret) {
  fail("OAuth Desktop client configuration is invalid.");
}

if (
  tokenRecord.connection_id !== connection.id ||
  tokenRecord.account_id !== connection.account_id ||
  tokenRecord.identity?.toLowerCase() !== connection.identity.toLowerCase()
) {
  fail("Stored token metadata does not match Connection Registry.");
}

if (!tokenRecord.credentials?.refresh_token) fail("Refresh token is missing.");

const oauth2Client = new google.auth.OAuth2(
  installed.client_id,
  installed.client_secret,
);
oauth2Client.setCredentials(tokenRecord.credentials);

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = path.join(
  projectDir,
  "data",
  "invoice-runs",
  connection.account_id,
  runId,
);
const filesDir = path.join(runDir, "files");

fs.mkdirSync(filesDir, { recursive: true, mode: 0o700 });

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
    q: query,
    maxResults: limit,
  });

  const refs = listResponse.data.messages ?? [];
  const manifest: ManifestRecord[] = [];
  const firstSeenByHash = new Map<string, ManifestRecord>();

  for (const ref of refs) {
    if (!ref.id) continue;

    const message = await gmail.users.messages.get({
      userId: "me",
      id: ref.id,
      format: "full",
      metadataHeaders: ["From", "Subject", "Date"],
    });

    const headers = message.data.payload?.headers;
    const from = headerValue(headers, "From");
    const subject = headerValue(headers, "Subject");
    const date = headerValue(headers, "Date");
    const attachments = collectPdfAttachments(message.data.payload);

    for (const attachment of attachments) {
      if (attachment.size !== null && attachment.size > maxBytes) {
        console.log(
          `SKIPPED oversized attachment: ${attachment.filename} (${attachment.size} bytes)`,
        );
        continue;
      }

      const response = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId: ref.id,
        id: attachment.attachmentId,
      });

      const encoded = response.data.data;
      if (!encoded) {
        console.log(`SKIPPED attachment with no data: ${attachment.filename}`);
        continue;
      }

      const bytes = decodeBase64Url(encoded);
      if (bytes.length > maxBytes) {
        console.log(
          `SKIPPED oversized attachment after download: ${attachment.filename}`,
        );
        continue;
      }

      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      const preferred = sanitizeFilename(attachment.filename);
      const storedFilename = uniqueFilename(filesDir, preferred);
      const storedPath = path.join(filesDir, storedFilename);

      fs.writeFileSync(storedPath, bytes, { mode: 0o600, flag: "wx" });
      fs.chmodSync(storedPath, 0o600);

      const prior = firstSeenByHash.get(sha256);
      const record: ManifestRecord = {
        messageId: ref.id,
        threadId: message.data.threadId ?? null,
        from,
        subject,
        date,
        originalFilename: attachment.filename,
        storedFilename,
        mimeType: attachment.mimeType,
        sizeBytes: bytes.length,
        sha256,
        exactDuplicateWithinRun: Boolean(prior),
        duplicateOfSha256: prior?.sha256 ?? null,
      };

      if (!prior) firstSeenByHash.set(sha256, record);
      manifest.push(record);
    }
  }

  const manifestPath = path.join(runDir, "manifest.json");
  const summary = {
    runId,
    connectionId: connection.id,
    accountId: connection.account_id,
    identity: authorizedIdentity,
    lookbackDays: days,
    query,
    candidateMessages: refs.length,
    pdfAttachmentsDownloaded: manifest.length,
    exactDuplicatesWithinRun: manifest.filter(
      (item) => item.exactDuplicateWithinRun,
    ).length,
    createdAt: new Date().toISOString(),
    records: manifest,
  };

  fs.writeFileSync(manifestPath, JSON.stringify(summary, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
  fs.chmodSync(manifestPath, 0o600);

  console.log("Invoice PDF download and hashing passed.");
  console.log("----------------------------------------");
  console.log(`Run ID: ${runId}`);
  console.log(`Connection: ${connection.id}`);
  console.log(`Account: ${connection.account_id}`);
  console.log(`Identity: ${authorizedIdentity}`);
  console.log(`Candidate messages: ${refs.length}`);
  console.log(`PDF attachments downloaded: ${manifest.length}`);
  console.log(
    `Exact duplicates within run: ${
      manifest.filter((item) => item.exactDuplicateWithinRun).length
    }`,
  );
  console.log(`Run directory: ${runDir}`);
  console.log(`Manifest: ${manifestPath}`);
  console.log("");
  console.log("Downloaded PDFs:");

  manifest.forEach((record, index) => {
    const duplicateLabel = record.exactDuplicateWithinRun
      ? " [EXACT DUPLICATE]"
      : "";
    console.log(
      `[${index + 1}] ${record.storedFilename} — ${record.sizeBytes} bytes${duplicateLabel}`,
    );
    console.log(`    SHA-256: ${record.sha256}`);
    console.log(`    Subject: ${record.subject}`);
  });

  console.log("");
  console.log("Email body content stored: no");
  console.log("OpenRouter used: no");
  console.log("OCR used: no");
  console.log("Google Drive writes: no");
  console.log("Google Sheets writes: no");
  console.log("Gmail writes: no");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  fail(`Invoice PDF download failed: ${message}`);
}
