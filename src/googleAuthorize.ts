import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { google } from "googleapis";
import YAML from "yaml";

const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const HOST = "127.0.0.1";
const PORT = 53682;
const REDIRECT_URI = `http://${HOST}:${PORT}/oauth2callback`;

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
const connectionsPath = path.join(projectDir, "config", "connections.yaml");
const clientPath = path.join(
  os.homedir(),
  ".config",
  "marian-ai-os",
  "secrets",
  "google",
  "google-oauth-client.json",
);
const tokenDir = path.join(
  os.homedir(),
  ".config",
  "marian-ai-os",
  "secrets",
  "google",
  "tokens",
);
const tokenPath = path.join(tokenDir, `${connectionId}.json`);

if (!fs.existsSync(connectionsPath)) {
  fail(`Connection registry not found: ${connectionsPath}`);
}

if (!fs.existsSync(clientPath)) {
  fail(`OAuth client file not found: ${clientPath}`);
}

const connectionsConfig = YAML.parse(
  fs.readFileSync(connectionsPath, "utf8"),
) as {
  connections?: Array<{
    id: string;
    account_id: string;
    identity: string;
    provider: string;
  }>;
};

const connection = connectionsConfig.connections?.find(
  (item) => item.id === connectionId,
);

if (!connection) {
  fail(`Unknown connection: ${connectionId}`);
}

if (connection.provider !== "google") {
  fail(`Connection ${connectionId} is not a Google connection.`);
}

if (
  connection.identity.startsWith("REPLACE_WITH_") ||
  !connection.identity.includes("@")
) {
  fail(`Connection ${connectionId} has an invalid identity.`);
}

const clientFile = JSON.parse(fs.readFileSync(clientPath, "utf8")) as {
  installed?: {
    client_id?: string;
    client_secret?: string;
  };
};

const installed = clientFile.installed;
if (!installed?.client_id || !installed.client_secret) {
  fail("OAuth JSON does not contain a valid Desktop client.");
}

fs.mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
fs.chmodSync(tokenDir, 0o700);

if (fs.existsSync(tokenPath)) {
  fail(
    `Token already exists at ${tokenPath}. Remove it explicitly before re-authorizing.`,
  );
}

const oauth2Client = new google.auth.OAuth2(
  installed.client_id,
  installed.client_secret,
  REDIRECT_URI,
);

const state = crypto.randomBytes(24).toString("hex");

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  include_granted_scopes: true,
  scope: [SCOPE],
  state,
  login_hint: connection.identity,
});

const server = http.createServer(async (request, response) => {
  try {
    if (!request.url) {
      response.writeHead(400);
      response.end("Missing request URL.");
      return;
    }

    const callbackUrl = new URL(request.url, REDIRECT_URI);

    if (callbackUrl.pathname !== "/oauth2callback") {
      response.writeHead(404);
      response.end("Not found.");
      return;
    }

    const returnedState = callbackUrl.searchParams.get("state");
    const code = callbackUrl.searchParams.get("code");
    const oauthError = callbackUrl.searchParams.get("error");

    if (oauthError) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(`Google authorization failed: ${oauthError}`);
      server.close();
      return;
    }

    if (!returnedState || returnedState !== state) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("State validation failed.");
      server.close();
      return;
    }

    if (!code) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Authorization code is missing.");
      server.close();
      return;
    }

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    if (!tokens.refresh_token) {
      throw new Error(
        "Google did not return a refresh token. Revoke the app grant and retry with consent.",
      );
    }

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: "me" });
    const authorizedEmail = profile.data.emailAddress?.toLowerCase();
    const expectedEmail = connection.identity.toLowerCase();

    if (!authorizedEmail) {
      throw new Error("Could not determine the authorized Gmail identity.");
    }

    if (authorizedEmail !== expectedEmail) {
      throw new Error(
        `Authorized mailbox '${authorizedEmail}' does not match expected identity '${expectedEmail}'. Token was not saved.`,
      );
    }

    const tokenRecord = {
      connection_id: connection.id,
      account_id: connection.account_id,
      identity: connection.identity,
      scopes: [SCOPE],
      created_at: new Date().toISOString(),
      credentials: tokens,
    };

    fs.writeFileSync(tokenPath, JSON.stringify(tokenRecord, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    fs.chmodSync(tokenPath, 0o600);

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`
      <!doctype html>
      <html>
        <head><title>Marián AI OS authorization</title></head>
        <body style="font-family: sans-serif; max-width: 680px; margin: 60px auto;">
          <h1>Authorization successful</h1>
          <p>Connected mailbox: <strong>${authorizedEmail}</strong></p>
          <p>You can close this browser tab and return to Terminal.</p>
        </body>
      </html>
    `);

    console.log("");
    console.log("Google authorization successful.");
    console.log(`Connection: ${connection.id}`);
    console.log(`Account: ${connection.account_id}`);
    console.log(`Identity: ${authorizedEmail}`);
    console.log(`Token stored: ${tokenPath}`);
    console.log("Scope: gmail.readonly");
    server.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(`Authorization failed: ${message}`);
    console.error(`ERROR: ${message}`);
    server.close();
    process.exitCode = 1;
  }
});

server.on("error", (error) => {
  fail(`OAuth callback server failed: ${error.message}`);
});

server.listen(PORT, HOST, () => {
  console.log("Google OAuth authorization helper");
  console.log("---------------------------------");
  console.log(`Expected identity: ${connection.identity}`);
  console.log(`Connection: ${connection.id}`);
  console.log(`Account: ${connection.account_id}`);
  console.log(`Callback: ${REDIRECT_URI}`);
  console.log("");
  console.log("Open this URL in the Mac browser:");
  console.log("");
  console.log(authUrl);
  console.log("");
  console.log("Waiting for the Google callback...");
});
