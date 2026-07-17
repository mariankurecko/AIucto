import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { google } from "googleapis";
import YAML from "yaml";

export const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.send",
] as const;
const HOST = "127.0.0.1";
const PORT = 53684;
const REDIRECT_URI = `http://${HOST}:${PORT}/oauth2callback`;
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const USERINFO_EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";
const EXPECTED_AUTHORIZED_EMAIL = "hello@equisix.com";

type ScopeName = (typeof SCOPES)[number];

type IdTokenPayload = {
  email?: string;
  email_verified?: boolean;
};

type IdTokenTicket = {
  getPayload(): IdTokenPayload | undefined;
};

type IdTokenVerifier = {
  verifyIdToken(args: { idToken: string; audience: string }): Promise<IdTokenTicket>;
};

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

async function runGoogleApiCall<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Google API call failed [${label}]: ${message}`);
  }
}

export function parseGrantedScopes(scopeValue: string | null | undefined): Set<string> {
  return new Set((scopeValue ?? "").split(/\s+/).filter(Boolean));
}

export function normalizeGrantedScopes(scopeNames: Iterable<string>): Set<string> {
  const normalized = new Set<string>();
  for (const scope of scopeNames) {
    if (scope === USERINFO_EMAIL_SCOPE || scope === "email") {
      normalized.add("email");
      continue;
    }
    if (scope === "openid") {
      normalized.add("openid");
      continue;
    }
    normalized.add(scope);
  }
  return normalized;
}

function formatValidationError(args: {
  message: string;
  requestedScopes: readonly string[];
  normalizedGrantedScopes: Iterable<string>;
  hasVerifiedEmailInIdToken: boolean;
}): Error {
  const normalizedScopes = [...new Set(args.normalizedGrantedScopes)].sort();
  return new Error(
    `${args.message}. Requested scopes: ${args.requestedScopes.join(", ")}. ` +
      `Normalized granted scopes: ${normalizedScopes.join(", ") || "(none)"}. ` +
      `Verified email in ID token: ${args.hasVerifiedEmailInIdToken ? "yes" : "no"}.`,
  );
}

export async function verifyAuthorizedIdentity(args: {
  idToken: string | null | undefined;
  clientId: string;
  expectedEmail: string;
  verifier: IdTokenVerifier;
}): Promise<{ authorizedEmail: string; hasVerifiedEmailInIdToken: boolean }> {
  if (!args.idToken) {
    throw new Error("Malformed ID token: missing id_token.");
  }
  const idToken = args.idToken;

  let payload: IdTokenPayload | undefined;
  try {
    const ticket = await runGoogleApiCall("oauth2.verifyIdToken", () =>
      args.verifier.verifyIdToken({
        idToken,
        audience: args.clientId,
      }),
    );
    payload = ticket.getPayload();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed ID token: ${message}`);
  }

  const authorizedEmail = payload?.email?.toLowerCase();
  const isVerified = payload?.email_verified === true;

  if (!authorizedEmail) {
    throw new Error("ID token did not contain an email claim.");
  }

  if (!isVerified) {
    throw new Error(`ID token email '${authorizedEmail}' is not verified.`);
  }

  const expectedEmail = args.expectedEmail.toLowerCase();
  if (authorizedEmail !== expectedEmail) {
    throw new Error(
      `Authorized mailbox '${authorizedEmail}' does not match expected '${expectedEmail}'.`,
    );
  }

  return {
    authorizedEmail,
    hasVerifiedEmailInIdToken: true,
  };
}

export async function validateGmailSendAuthorization(args: {
  grantedScopeValue: string | null | undefined;
  requestedScopes: readonly ScopeName[];
  idToken: string | null | undefined;
  clientId: string;
  expectedEmail: string;
  verifier: IdTokenVerifier;
}): Promise<{
  authorizedEmail: string;
  normalizedGrantedScopes: Set<string>;
  hasVerifiedEmailInIdToken: boolean;
}> {
  const grantedScopes = parseGrantedScopes(args.grantedScopeValue);
  const normalizedGrantedScopes = normalizeGrantedScopes(grantedScopes);

  if (!normalizedGrantedScopes.has(GMAIL_SEND_SCOPE)) {
    throw formatValidationError({
      message: `Required scope was not granted: ${GMAIL_SEND_SCOPE}`,
      requestedScopes: args.requestedScopes,
      normalizedGrantedScopes,
      hasVerifiedEmailInIdToken: false,
    });
  }

  try {
    const identity = await verifyAuthorizedIdentity({
      idToken: args.idToken,
      clientId: args.clientId,
      expectedEmail: args.expectedEmail,
      verifier: args.verifier,
    });

    return {
      authorizedEmail: identity.authorizedEmail,
      normalizedGrantedScopes,
      hasVerifiedEmailInIdToken: identity.hasVerifiedEmailInIdToken,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hasVerifiedEmailInIdToken = /does not match expected|not verified/.test(message)
      ? false
      : !message.includes("did not contain an email claim") && !message.includes("Malformed ID token");
    throw formatValidationError({
      message,
      requestedScopes: args.requestedScopes,
      normalizedGrantedScopes,
      hasVerifiedEmailInIdToken,
    });
  }
}

async function main(): Promise<void> {
  const connectionId = getArg("connection");
  if (!connectionId) fail("Missing --connection <connection-id>.");

  const connectionsPath = path.join(process.cwd(), "config", "connections.yaml");
  const clientPath = path.join(os.homedir(), ".config", "marian-ai-os", "secrets", "google", "google-oauth-client.json");
  const tokenDir = path.join(os.homedir(), ".config", "marian-ai-os", "secrets", "google", "tokens");
  const tokenPath = path.join(tokenDir, `${connectionId}-gmail-send.json`);

  const connectionsConfig = YAML.parse(fs.readFileSync(connectionsPath, "utf8")) as {
    connections?: Array<{ id: string; account_id: string; identity: string; provider: string }>;
  };
  const connection = connectionsConfig.connections?.find((item) => item.id === connectionId);
  if (!connection || connection.provider !== "google") fail(`Unknown Google connection '${connectionId}'.`);
  if (connection.identity.toLowerCase() !== EXPECTED_AUTHORIZED_EMAIL) {
    fail(`Connection '${connectionId}' must use identity '${EXPECTED_AUTHORIZED_EMAIL}'.`);
  }
  if (fs.existsSync(tokenPath)) fail(`Token already exists: ${tokenPath}`);

  const clientFile = JSON.parse(fs.readFileSync(clientPath, "utf8"));
  const installed = clientFile.installed;
  const oauth2Client = new google.auth.OAuth2(installed.client_id, installed.client_secret, REDIRECT_URI);
  const state = crypto.randomBytes(24).toString("hex");

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    scope: [...SCOPES],
    state,
    login_hint: connection.identity,
  });

  const server = http.createServer(async (request, response) => {
    try {
      if (!request.url) throw new Error("Missing callback URL.");
      const callbackUrl = new URL(request.url, REDIRECT_URI);
      if (callbackUrl.pathname !== "/oauth2callback") {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found.");
        return;
      }

      const returnedState = callbackUrl.searchParams.get("state");
      const code = callbackUrl.searchParams.get("code");
      const oauthError = callbackUrl.searchParams.get("error");

      if (oauthError) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(`Google authorization failed: ${oauthError}`);
        console.error(`ERROR: Google authorization failed: ${oauthError}`);
        server.close();
        process.exitCode = 1;
        return;
      }

      if (returnedState !== state) {
        throw new Error("State validation failed.");
      }

      if (!code) {
        throw new Error("Authorization code is missing.");
      }

      const { tokens } = await runGoogleApiCall("oauth2.getToken", () =>
        oauth2Client.getToken(code),
      );
      if (!tokens.refresh_token) throw new Error("Google did not return a refresh token.");
      oauth2Client.setCredentials(tokens);

      const validation = await validateGmailSendAuthorization({
        grantedScopeValue: tokens.scope,
        requestedScopes: SCOPES,
        idToken: tokens.id_token,
        clientId: installed.client_id,
        expectedEmail: EXPECTED_AUTHORIZED_EMAIL,
        verifier: oauth2Client,
      });

      console.log(
        `Normalized granted scopes: ${[...validation.normalizedGrantedScopes].sort().join(", ") || "(none)"}`,
      );

      fs.mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(tokenPath, JSON.stringify({
        connection_id: connection.id,
        account_id: connection.account_id,
        identity: connection.identity,
        purpose: "gmail_send",
        scopes: [...SCOPES],
        created_at: new Date().toISOString(),
        credentials: tokens,
      }, null, 2), { mode: 0o600, flag: "wx" });
      fs.chmodSync(tokenPath, 0o600);

      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<html><body><h1>Authorization successful</h1><p>You can close this tab.</p></body></html>");
      console.log(`Google Gmail send authorization successful for ${validation.authorizedEmail}.`);
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

  server.listen(PORT, HOST, () => {
    console.log("Google Gmail send OAuth helper");
    console.log(`Expected identity: ${connection.identity}`);
    console.log(`Connection: ${connection.id}`);
    console.log(`Account: ${connection.account_id}`);
    console.log(`Callback: ${REDIRECT_URI}`);
    console.log(`Scopes: ${SCOPES.join(", ")}`);
    console.log(authUrl);
  });
}

const isMainModule =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  void main();
}
