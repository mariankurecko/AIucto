import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const OPENID_SCOPE = "openid";
export const EMAIL_SCOPE = "email";
export const USERINFO_EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";

export type GoogleConnectionRecord = {
  id: string;
  account_id: string;
  identity: string;
  provider: string;
  enabled?: boolean;
  status?: string;
};

export type GoogleTokenRecord = {
  connection_id?: string;
  account_id?: string;
  identity?: string;
  purpose?: string;
  scopes?: string[];
  created_at?: string;
  credentials?: {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    expiry_date?: number;
    token_type?: string;
    id_token?: string;
  };
};

export type GoogleTokenPurpose = "invoice_core" | "gmail_send";
export type GoogleTokenCapability = "gmail_read" | "drive_sheets" | "gmail_send";

export type GoogleTokenCandidate = {
  filename: string;
  kind: "preferred" | "legacy";
  reason: string;
};

export type GoogleTokenRequirement = {
  purpose: GoogleTokenPurpose;
  title: string;
  scopes: string[];
  filename: string;
  legacyFilenames: string[];
  description: string;
  authorizeCommand: string;
};

export type GoogleCapabilityRequirement = {
  capability: GoogleTokenCapability;
  title: string;
  scopes: string[];
  candidateFilenames: string[];
  description: string;
  authorizeCommand: string;
};

export type ResolvedGoogleToken = {
  requirement: GoogleCapabilityRequirement;
  path: string;
  filename: string;
  record: GoogleTokenRecord;
  matchedLegacyFilename: string | null;
};

const TOKEN_REQUIREMENTS: Record<GoogleTokenPurpose, Omit<GoogleTokenRequirement, "filename" | "legacyFilenames" | "authorizeCommand"> & {
  filenameSuffix: string;
  legacyFilenameSuffixes: string[];
}> = {
  invoice_core: {
    purpose: "invoice_core",
    title: "Invoice core token",
    scopes: [GMAIL_READONLY_SCOPE, DRIVE_FILE_SCOPE],
    filenameSuffix: "-invoice-core.json",
    legacyFilenameSuffixes: [".json", "-drive-sheets.json"],
    description: "Used by the invoice pipeline for Gmail read access plus Google Drive/Sheets writes.",
  },
  gmail_send: {
    purpose: "gmail_send",
    title: "Gmail send token",
    scopes: [GMAIL_SEND_SCOPE],
    filenameSuffix: "-gmail-send.json",
    legacyFilenameSuffixes: [],
    description: "Used only when the invoice pipeline sends the prepared monthly package email.",
  },
};

export function secretsRoot(): string {
  return path.join(os.homedir(), ".config", "marian-ai-os", "secrets");
}

export function googleSecretsRoot(): string {
  return path.join(secretsRoot(), "google");
}

export function googleClientPath(): string {
  return path.join(googleSecretsRoot(), "google-oauth-client.json");
}

export function googleTokenDir(): string {
  return path.join(googleSecretsRoot(), "tokens");
}

export function tokenFilePath(filename: string): string {
  return path.join(googleTokenDir(), filename);
}

export function parseGrantedScopes(scopeValue: string | null | undefined): Set<string> {
  return new Set((scopeValue ?? "").split(/\s+/).filter(Boolean));
}

export function normalizeGrantedScopes(scopeNames: Iterable<string>): Set<string> {
  const normalized = new Set<string>();
  for (const scope of scopeNames) {
    if (scope === USERINFO_EMAIL_SCOPE || scope === EMAIL_SCOPE) {
      normalized.add(EMAIL_SCOPE);
      continue;
    }
    if (scope === OPENID_SCOPE) {
      normalized.add(OPENID_SCOPE);
      continue;
    }
    normalized.add(scope);
  }
  return normalized;
}

export function grantedScopesFromToken(record: GoogleTokenRecord): Set<string> {
  const storedScopes = Array.isArray(record.scopes) ? record.scopes : [];
  const credentialScopes = parseGrantedScopes(record.credentials?.scope);
  return normalizeGrantedScopes([...storedScopes, ...credentialScopes]);
}

export function tokenHasScopes(record: GoogleTokenRecord, requiredScopes: readonly string[]): boolean {
  const grantedScopes = grantedScopesFromToken(record);
  return requiredScopes.every((scope) => grantedScopes.has(scope));
}

export function loadGoogleConnections(projectRoot: string): GoogleConnectionRecord[] {
  const connectionsPath = path.join(projectRoot, "config", "connections.yaml");
  if (!fs.existsSync(connectionsPath)) {
    throw new Error(`Google connection registry not found: ${connectionsPath}`);
  }
  const parsed = YAML.parse(fs.readFileSync(connectionsPath, "utf8")) as {
    connections?: GoogleConnectionRecord[];
  };
  return parsed.connections ?? [];
}

export function loadGoogleConnection(projectRoot: string, connectionId: string): GoogleConnectionRecord {
  const connection = loadGoogleConnections(projectRoot).find((item) => item.id === connectionId);
  if (!connection) {
    throw new Error(`Unknown Google connection '${connectionId}'.`);
  }
  if (connection.provider !== "google") {
    throw new Error(`Connection '${connectionId}' is not a Google connection.`);
  }
  return connection;
}

export function getGoogleTokenRequirement(connectionId: string, purpose: GoogleTokenPurpose): GoogleTokenRequirement {
  const base = TOKEN_REQUIREMENTS[purpose];
  return {
    purpose,
    title: base.title,
    scopes: [...base.scopes],
    filename: `${connectionId}${base.filenameSuffix}`,
    legacyFilenames: base.legacyFilenameSuffixes.map((suffix) =>
      suffix.startsWith(".") ? `${connectionId}${suffix}` : `${connectionId}${suffix}`,
    ),
    description: base.description,
    authorizeCommand: `npm run google:authorize:${purpose === "invoice_core" ? "invoice-core" : "gmail-send"} -- --connection ${connectionId}`,
  };
}

export function getGoogleCapabilityRequirement(connectionId: string, capability: GoogleTokenCapability): GoogleCapabilityRequirement {
  if (capability === "gmail_send") {
    const sendRequirement = getGoogleTokenRequirement(connectionId, "gmail_send");
    return {
      capability,
      title: "Gmail send token",
      scopes: [GMAIL_SEND_SCOPE],
      candidateFilenames: [sendRequirement.filename],
      description: "Used only when the invoice pipeline sends the prepared monthly package email.",
      authorizeCommand: sendRequirement.authorizeCommand,
    };
  }
  const invoiceRequirement = getGoogleTokenRequirement(connectionId, "invoice_core");
  if (capability === "gmail_read") {
    return {
      capability,
      title: "Gmail read token",
      scopes: [GMAIL_READONLY_SCOPE],
      candidateFilenames: [invoiceRequirement.filename, `${connectionId}.json`],
      description: "Used to discover invoice emails and download attachments from Gmail.",
      authorizeCommand: invoiceRequirement.authorizeCommand,
    };
  }
  return {
    capability,
    title: "Drive and Sheets token",
    scopes: [DRIVE_FILE_SCOPE],
    candidateFilenames: [invoiceRequirement.filename, `${connectionId}-drive-sheets.json`],
    description: "Used to create monthly folders, upload package files, and update the invoice register spreadsheet.",
    authorizeCommand: invoiceRequirement.authorizeCommand,
  };
}

export function listGoogleTokenCandidates(connectionId: string, capability: GoogleTokenCapability): GoogleTokenCandidate[] {
  const requirement = getGoogleCapabilityRequirement(connectionId, capability);
  return requirement.candidateFilenames.map((filename, index) => ({
    filename,
    kind: index === 0 ? "preferred" : "legacy",
    reason: index === 0 ? `${requirement.title} with scopes ${requirement.scopes.join(", ")}` : `legacy fallback for ${capability}`,
  }));
}

function readTokenRecord(filePath: string): GoogleTokenRecord {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as GoogleTokenRecord;
}

export function resolveGoogleTokenForCapability(connectionId: string, capability: GoogleTokenCapability): ResolvedGoogleToken | null {
  const requirement = getGoogleCapabilityRequirement(connectionId, capability);
  for (const candidate of listGoogleTokenCandidates(connectionId, capability)) {
    const candidatePath = tokenFilePath(candidate.filename);
    if (!fs.existsSync(candidatePath)) {
      continue;
    }
    const record = readTokenRecord(candidatePath);
    if (!tokenHasScopes(record, requirement.scopes)) {
      continue;
    }
    return {
      requirement,
      path: candidatePath,
      filename: candidate.filename,
      record,
      matchedLegacyFilename: candidate.kind === "legacy" ? candidate.filename : null,
    };
  }
  return null;
}

export function loadGoogleTokenOrThrow(connectionId: string, capability: GoogleTokenCapability): ResolvedGoogleToken {
  const resolved = resolveGoogleTokenForCapability(connectionId, capability);
  if (resolved) {
    return resolved;
  }
  const requirement = getGoogleCapabilityRequirement(connectionId, capability);
  const candidateNames = requirement.candidateFilenames
    .map((filename) => `- ${filename}`)
    .join("\n");
  throw new Error(
    [
      `Missing Google OAuth token for connection '${connectionId}'.`,
      `Required capability: ${requirement.title}.`,
      `Scopes: ${requirement.scopes.join(", ")}.`,
      `Expected filenames checked:`,
      candidateNames,
      `Why it is needed: ${requirement.description}`,
      `Authorize it with: ${requirement.authorizeCommand}`,
    ].join("\n"),
  );
}

export function loadGoogleClientCredentials(): any {
  const clientPath = googleClientPath();
  if (!fs.existsSync(clientPath)) {
    throw new Error(
      `Google OAuth client file not found: ${clientPath}\n` +
      "Place the Desktop OAuth client JSON there before authorizing tokens.",
    );
  }
  const clientFile = JSON.parse(fs.readFileSync(clientPath, "utf8"));
  const installed = clientFile.installed;
  if (!installed?.client_id || !installed?.client_secret) {
    throw new Error("OAuth Desktop client configuration is invalid.");
  }
  return clientFile;
}

export function invoiceGoogleTokenPurposes(options: { automaticMonthlyEmailSend: boolean }): GoogleTokenPurpose[] {
  return options.automaticMonthlyEmailSend ? ["invoice_core", "gmail_send"] : ["invoice_core"];
}

export function summarizeGoogleTokenExpectations(connectionId: string, purposes: readonly GoogleTokenPurpose[]) {
  return purposes.map((purpose) => getGoogleTokenRequirement(connectionId, purpose));
}
