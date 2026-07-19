import test from "node:test";
import assert from "node:assert/strict";
import { extractGmailBodyText } from "../src/invoice-monthly/googleServices.js";

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

test("extractGmailBodyText reads a plain-text Gmail body", () => {
  const body = extractGmailBodyText({
    mimeType: "multipart/alternative",
    parts: [{ mimeType: "text/plain", body: { data: base64Url("Please find the invoice attached.") } }],
  });
  assert.equal(body, "Please find the invoice attached.");
});

test("extractGmailBodyText reads an HTML-only Gmail body", () => {
  const body = extractGmailBodyText({
    mimeType: "multipart/alternative",
    parts: [{ mimeType: "text/html", body: { data: base64Url("<p>Please find the <strong>invoice</strong> attached.</p>") } }],
  });
  assert.equal(body, "Please find the invoice attached.");
});
