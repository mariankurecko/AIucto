import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import { google } from "googleapis";
import {
  EMAIL_SCOPE,
  GMAIL_SEND_SCOPE,
  GoogleTokenPurpose,
  getGoogleTokenRequirement,
  googleTokenDir,
  loadGoogleClientCredentials,
  loadGoogleConnection,
  normalizeGrantedScopes,
  parseGrantedScopes,
  tokenFilePath,
} from "./googleAuth.js";
import { SCOPES as GMAIL_SEND_AUTHORIZATION_SCOPES, validateGmailSendAuthorization } from "./googleGmailSendAuthorize.js";

type AuthorizePurposeConfig = {
  port: number;
  requestedScopes: string[];
  includeGrantedScopes: boolean;
  validateIdentity(args: {
    auth: InstanceType<typeof google.auth.OAuth2>;
    expectedEmail: string;
  }): Promise<string>;
  validateToken?(args: {
    oauth2Client: InstanceType<typeof google.auth.OAuth2>;
    tokens: any;
    clientId: string;
    expectedEmail: string;
  }): Promise<string>;
};

const AUTHORIZE_PURPOSES: Record<GoogleTokenPurpose, AuthorizePurposeConfig> = {
  invoice_core: {
    port: 53685,
    requestedScopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/drive.file",
    ],
    includeGrantedScopes: true,
    async validateIdentity({ auth, expectedEmail }) {
      const gmail = google.gmail({ version: "v1", auth });
      const profile = await gmail.users.getProfile({ userId: "me" });
      const authorizedEmail = profile.data.emailAddress?.toLowerCase() ?? null;
      if (!authorizedEmail) {
        throw new Error("Could not determine the authorized Gmail identity.");
      }
      if (authorizedEmail !== expectedEmail.toLowerCase()) {
        throw new Error(
          `Authorized mailbox '${authorizedEmail}' does not match expected identity '${expectedEmail.toLowerCase()}'.`,
        );
      }
      return authorizedEmail;
    },
  },
  gmail_send: {
    port: 53684,
    requestedScopes: [...GMAIL_SEND_AUTHORIZATION_SCOPES],
    includeGrantedScopes: true,
    async validateIdentity({ expectedEmail }) {
      return expectedEmail.toLowerCase();
    },
    async validateToken({ oauth2Client, tokens, clientId, expectedEmail }) {
      const validation = await validateGmailSendAuthorization({
        grantedScopeValue: tokens.scope,
        requestedScopes: GMAIL_SEND_AUTHORIZATION_SCOPES,
        idToken: tokens.id_token,
        clientId,
        expectedEmail,
        verifier: oauth2Client,
      });
      return validation.authorizedEmail;
    },
  },
};

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const connectionId = getArg("connection");
  const purpose = getArg("purpose") as GoogleTokenPurpose | undefined;

  if (!connectionId) fail("Missing --connection <connection-id>.");
  if (!purpose || !(purpose in AUTHORIZE_PURPOSES)) {
    fail("Missing or invalid --purpose <invoice_core|gmail_send>.");
  }

  const projectRoot = process.cwd();
  const connection = loadGoogleConnection(projectRoot, connectionId);
  const clientFile = loadGoogleClientCredentials();
  const installed = clientFile.installed;
  const requirement = getGoogleTokenRequirement(connectionId, purpose);
  const purposeConfig = AUTHORIZE_PURPOSES[purpose];
  const tokenDir = googleTokenDir();
  const tokenPath = tokenFilePath(requirement.filename);

  fs.mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(tokenDir, 0o700);

  if (fs.existsSync(tokenPath)) {
    fail(`Token already exists: ${tokenPath}`);
  }

  const redirectUri = `http://127.0.0.1:${purposeConfig.port}/oauth2callback`;
  const oauth2Client = new google.auth.OAuth2(
    installed.client_id,
    installed.client_secret,
    redirectUri,
  );
  const state = crypto.randomBytes(24).toString("hex");
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: purposeConfig.includeGrantedScopes,
    scope: purposeConfig.requestedScopes,
    state,
    login_hint: connection.identity,
  });

  const server = http.createServer(async (request, response) => {
    try {
      if (!request.url) {
        throw new Error("Missing request URL.");
      }

      const callbackUrl = new URL(request.url, redirectUri);
      if (callbackUrl.pathname !== "/oauth2callback") {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found.");
        return;
      }

      const returnedState = callbackUrl.searchParams.get("state");
      const code = callbackUrl.searchParams.get("code");
      const oauthError = callbackUrl.searchParams.get("error");

      if (oauthError) {
        throw new Error(`Google authorization failed: ${oauthError}`);
      }

      if (returnedState !== state) {
        throw new Error("State validation failed.");
      }

      if (!code) {
        throw new Error("Authorization code is missing.");
      }

      const { tokens } = await oauth2Client.getToken(code);
      if (!tokens.refresh_token) {
        throw new Error(
          "Google did not return a refresh token. Revoke the existing app grant and retry with consent.",
        );
      }
      oauth2Client.setCredentials(tokens);

      const grantedScopes = normalizeGrantedScopes(parseGrantedScopes(tokens.scope));
      for (const scope of requirement.scopes) {
        if (!grantedScopes.has(scope)) {
          throw new Error(`Required scope was not granted: ${scope}`);
        }
      }

      const authorizedEmail = purposeConfig.validateToken
        ? await purposeConfig.validateToken({
            oauth2Client,
            tokens,
            clientId: installed.client_id,
            expectedEmail: connection.identity,
          })
        : await purposeConfig.validateIdentity({
            auth: oauth2Client,
            expectedEmail: connection.identity,
          });

      fs.writeFileSync(tokenPath, JSON.stringify({
        connection_id: connection.id,
        account_id: connection.account_id,
        identity: connection.identity,
        purpose,
        scopes: purposeConfig.requestedScopes,
        created_at: new Date().toISOString(),
        credentials: tokens,
      }, null, 2), { mode: 0o600, flag: "wx" });
      fs.chmodSync(tokenPath, 0o600);

      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<html><body><h1>Authorization successful</h1><p>You can close this tab.</p></body></html>");

      console.log("");
      console.log("Google authorization successful.");
      console.log(`Connection: ${connection.id}`);
      console.log(`Account: ${connection.account_id}`);
      console.log(`Identity: ${authorizedEmail}`);
      console.log(`Purpose: ${purpose}`);
      console.log(`Scopes: ${purposeConfig.requestedScopes.join(", ")}`);
      console.log(`Token stored: ${tokenPath}`);
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

  server.listen(purposeConfig.port, "127.0.0.1", () => {
    console.log("Google OAuth authorization helper");
    console.log("---------------------------------");
    console.log(`Connection: ${connection.id}`);
    console.log(`Account: ${connection.account_id}`);
    console.log(`Identity: ${connection.identity}`);
    console.log(`Purpose: ${purpose}`);
    console.log(`Token file: ${path.basename(tokenPath)}`);
    console.log(`Callback: ${redirectUri}`);
    console.log(`Scopes: ${purposeConfig.requestedScopes.join(", ")}`);
    if (purpose === "gmail_send" && purposeConfig.requestedScopes.includes(EMAIL_SCOPE)) {
      console.log("This authorization also requests email identity scopes for mailbox verification.");
    }
    console.log("");
    console.log("Open this URL in the browser:");
    console.log("");
    console.log(authUrl);
    console.log("");
    console.log("Waiting for the Google callback...");
  });
}

void main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
