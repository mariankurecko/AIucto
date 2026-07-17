import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { google } from "googleapis";
import YAML from "yaml";

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

const connectionId = getArg("connection");

if (!connectionId) {
  fail("Missing --connection <connection-id>.");
}

const projectDir = process.cwd();

const connectionsPath = path.join(
  projectDir,
  "config",
  "connections.yaml",
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
  clientPath,
  tokenPath,
]) {
  if (!fs.existsSync(requiredPath)) {
    fail(`Required file not found: ${requiredPath}`);
  }
}

const connectionsConfig = YAML.parse(
  fs.readFileSync(connectionsPath, "utf8"),
);

const connection = connectionsConfig.connections?.find(
  (item: any) => item.id === connectionId,
);

if (!connection) {
  fail(`Unknown connection: ${connectionId}`);
}

const clientFile = JSON.parse(
  fs.readFileSync(clientPath, "utf8"),
);

const tokenRecord = JSON.parse(
  fs.readFileSync(tokenPath, "utf8"),
);

const installed = clientFile.installed;

if (!installed?.client_id || !installed?.client_secret) {
  fail("OAuth Desktop client configuration is invalid.");
}

if (tokenRecord.connection_id !== connection.id) {
  fail("Token connection does not match registry.");
}

if (tokenRecord.account_id !== connection.account_id) {
  fail("Token account does not match registry.");
}

if (
  tokenRecord.identity?.toLowerCase() !==
  connection.identity.toLowerCase()
) {
  fail("Token identity does not match registry.");
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
  const gmail = google.gmail({
    version: "v1",
    auth: oauth2Client,
  });

  const profileResponse =
    await gmail.users.getProfile({
      userId: "me",
    });

  const inboxResponse =
    await gmail.users.labels.get({
      userId: "me",
      id: "INBOX",
    });

  const authorizedEmail =
    profileResponse.data.emailAddress?.toLowerCase();

  const expectedEmail =
    connection.identity.toLowerCase();

  if (authorizedEmail !== expectedEmail) {
    fail(
      `Authorized mailbox '${authorizedEmail}' does not match '${expectedEmail}'.`,
    );
  }

  console.log("Gmail read-only health check passed.");
  console.log("----------------------------------");
  console.log(`Connection: ${connection.id}`);
  console.log(`Account: ${connection.account_id}`);
  console.log(`Identity: ${authorizedEmail}`);
  console.log("Scope: gmail.readonly");
  console.log(
    `Total messages: ${profileResponse.data.messagesTotal ?? "unknown"}`,
  );
  console.log(
    `Total threads: ${profileResponse.data.threadsTotal ?? "unknown"}`,
  );
  console.log(
    `Inbox messages: ${inboxResponse.data.messagesTotal ?? "unknown"}`,
  );
  console.log(
    `Unread inbox messages: ${inboxResponse.data.messagesUnread ?? "unknown"}`,
  );
  console.log("Email content read: no");
  console.log("Write capability used: no");
} catch (error) {
  const message =
    error instanceof Error
      ? error.message
      : String(error);

  fail(`Gmail health check failed: ${message}`);
}
