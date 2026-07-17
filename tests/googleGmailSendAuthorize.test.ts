import assert from "node:assert/strict";
import test from "node:test";
import {
  SCOPES,
  validateGmailSendAuthorization,
} from "../src/googleGmailSendAuthorize.js";

const CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const EXPECTED_EMAIL = "hello@equisix.com";
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const USERINFO_EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";

function createVerifier(payload: { email?: string; email_verified?: boolean }) {
  return {
    async verifyIdToken() {
      return {
        getPayload() {
          return payload;
        },
      };
    },
  };
}

function createRejectingVerifier(message: string) {
  return {
    async verifyIdToken() {
      throw new Error(message);
    },
  };
}

test("accepts literal email scope when returned", async () => {
  const result = await validateGmailSendAuthorization({
    grantedScopeValue: `openid email ${GMAIL_SEND_SCOPE}`,
    requestedScopes: SCOPES,
    idToken: "header.payload.signature",
    clientId: CLIENT_ID,
    expectedEmail: EXPECTED_EMAIL,
    verifier: createVerifier({
      email: EXPECTED_EMAIL,
      email_verified: true,
    }),
  });

  assert.equal(result.authorizedEmail, EXPECTED_EMAIL);
  assert.equal(result.hasVerifiedEmailInIdToken, true);
  assert.deepEqual(
    [...result.normalizedGrantedScopes].sort(),
    ["email", GMAIL_SEND_SCOPE, "openid"],
  );
});

test("accepts canonical userinfo.email scope alias", async () => {
  const result = await validateGmailSendAuthorization({
    grantedScopeValue: `openid ${USERINFO_EMAIL_SCOPE} ${GMAIL_SEND_SCOPE}`,
    requestedScopes: SCOPES,
    idToken: "header.payload.signature",
    clientId: CLIENT_ID,
    expectedEmail: EXPECTED_EMAIL,
    verifier: createVerifier({
      email: EXPECTED_EMAIL,
      email_verified: true,
    }),
  });

  assert.deepEqual(
    [...result.normalizedGrantedScopes].sort(),
    ["email", GMAIL_SEND_SCOPE, "openid"],
  );
});

test("accepts missing email scope when ID token contains verified email", async () => {
  const result = await validateGmailSendAuthorization({
    grantedScopeValue: `openid ${GMAIL_SEND_SCOPE}`,
    requestedScopes: SCOPES,
    idToken: "header.payload.signature",
    clientId: CLIENT_ID,
    expectedEmail: EXPECTED_EMAIL,
    verifier: createVerifier({
      email: EXPECTED_EMAIL,
      email_verified: true,
    }),
  });

  assert.equal(result.authorizedEmail, EXPECTED_EMAIL);
  assert.equal(result.hasVerifiedEmailInIdToken, true);
});

test("rejects when gmail.send is missing", async () => {
  await assert.rejects(
    validateGmailSendAuthorization({
      grantedScopeValue: "openid email",
      requestedScopes: SCOPES,
      idToken: "header.payload.signature",
      clientId: CLIENT_ID,
      expectedEmail: EXPECTED_EMAIL,
      verifier: createVerifier({
        email: EXPECTED_EMAIL,
        email_verified: true,
      }),
    }),
    (error: unknown) => {
      assert.match(String(error), /Required scope was not granted/);
      assert.match(String(error), /Requested scopes:/);
      assert.match(String(error), /Normalized granted scopes: email, openid/);
      assert.match(String(error), /Verified email in ID token: no/);
      return true;
    },
  );
});

test("rejects wrong email identity", async () => {
  await assert.rejects(
    validateGmailSendAuthorization({
      grantedScopeValue: `openid email ${GMAIL_SEND_SCOPE}`,
      requestedScopes: SCOPES,
      idToken: "header.payload.signature",
      clientId: CLIENT_ID,
      expectedEmail: EXPECTED_EMAIL,
      verifier: createVerifier({
        email: "other@equisix.com",
        email_verified: true,
      }),
    }),
    /Authorized mailbox 'other@equisix\.com' does not match expected 'hello@equisix\.com'/,
  );
});

test("rejects unverified email", async () => {
  await assert.rejects(
    validateGmailSendAuthorization({
      grantedScopeValue: `openid email ${GMAIL_SEND_SCOPE}`,
      requestedScopes: SCOPES,
      idToken: "header.payload.signature",
      clientId: CLIENT_ID,
      expectedEmail: EXPECTED_EMAIL,
      verifier: createVerifier({
        email: EXPECTED_EMAIL,
        email_verified: false,
      }),
    }),
    /is not verified/,
  );
});

test("rejects malformed ID token", async () => {
  await assert.rejects(
    validateGmailSendAuthorization({
      grantedScopeValue: `openid email ${GMAIL_SEND_SCOPE}`,
      requestedScopes: SCOPES,
      idToken: "not-a-valid-token",
      clientId: CLIENT_ID,
      expectedEmail: EXPECTED_EMAIL,
      verifier: createRejectingVerifier("Wrong number of segments in token"),
    }),
    /Malformed ID token/,
  );
});
