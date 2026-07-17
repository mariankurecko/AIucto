import fs from "node:fs";
import { google, gmail_v1 } from "googleapis";
import { DriveFileRecord, DriveFolderTree, DriveService, GmailReadService, GmailSourceMessage, GmailSendService, MonthlyWorkflowConfig, SheetsService } from "./types.js";
import { formatInternalDateToLocalDate } from "./period.js";
import { loadGoogleClientCredentials, loadGoogleTokenOrThrow } from "../googleAuth.js";

function oauthClient(credentials: any, token: any) {
  const installed = credentials.installed;
  const client = new google.auth.OAuth2(installed.client_id, installed.client_secret);
  client.setCredentials(token.credentials);
  return client;
}

function headerValue(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value?.trim() || "";
}

function parseRecipients(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function collectAttachments(
  part: gmail_v1.Schema$MessagePart | undefined,
  prefix = "0",
  results: GmailSourceMessage["attachments"] = [],
): GmailSourceMessage["attachments"] {
  if (!part) return results;
  const filename = part.filename?.trim() || "attachment";
  const mimeType = part.mimeType?.toLowerCase() || "application/octet-stream";
  const attachmentId = part.body?.attachmentId || "";
  if (attachmentId && (mimeType === "application/pdf" || mimeType.startsWith("image/") || /\.(pdf|png|jpe?g|webp|heic|heif)$/i.test(filename))) {
    results.push({
      attachmentId,
      filename,
      mimeType,
      sizeBytes: typeof part.body?.size === "number" ? part.body.size : null,
      partPath: prefix,
    });
  }
  for (const [index, child] of (part.parts ?? []).entries()) {
    collectAttachments(child, `${prefix}.${index}`, results);
  }
  return results;
}

function decodeBase64Url(data: string): Buffer {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  return Buffer.from(normalized + "=".repeat(padding === 0 ? 0 : 4 - padding), "base64");
}

function escapeDrive(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function recordFromDrive(file: any): DriveFileRecord {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    webViewLink: file.webViewLink ?? null,
    appProperties: file.appProperties ?? {},
    parents: file.parents ?? [],
  };
}

export function createGmailReadService(config: MonthlyWorkflowConfig): GmailReadService {
  const credentials = loadGoogleClientCredentials();
  const token = loadGoogleTokenOrThrow(config.googleConnectionId, "gmail_read").record;
  const auth = oauthClient(credentials, token);
  const gmail = google.gmail({ version: "v1", auth });
  return {
    async getProfileEmail() {
      const profile = await gmail.users.getProfile({ userId: "me" });
      return profile.data.emailAddress ?? "";
    },
    async listMessages(query, pageToken) {
      const response = await gmail.users.messages.list({ userId: "me", q: query, pageToken: pageToken ?? undefined, maxResults: 100 });
      return {
        messageIds: (response.data.messages ?? []).map((message) => message.id).filter((id): id is string => Boolean(id)),
        nextPageToken: response.data.nextPageToken ?? null,
      };
    },
    async getMessage(messageId) {
      const response = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
      const data = response.data;
      const internalDateMs = Number.parseInt(data.internalDate ?? "0", 10);
      const { localDate, timestampIso } = formatInternalDateToLocalDate(internalDateMs, config.timezone);
      const headers = data.payload?.headers;
      return {
        messageId,
        threadId: data.threadId ?? null,
        internalDateMs,
        localDate,
        timestampIso,
        direction: "incoming",
        mailbox: config.sourceEmail,
        from: headerValue(headers, "From"),
        to: parseRecipients(headerValue(headers, "To")),
        cc: parseRecipients(headerValue(headers, "Cc")),
        bcc: parseRecipients(headerValue(headers, "Bcc")),
        subject: headerValue(headers, "Subject"),
        attachments: collectAttachments(data.payload),
      };
    },
    async getAttachment(messageId, attachmentId) {
      const response = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId });
      if (!response.data.data) throw new Error(`Attachment '${attachmentId}' had no data.`);
      return decodeBase64Url(response.data.data);
    },
  };
}

export function createDriveService(config: MonthlyWorkflowConfig): DriveService {
  const credentials = loadGoogleClientCredentials();
  const token = loadGoogleTokenOrThrow(config.googleConnectionId, "drive_sheets").record;
  const auth = oauthClient(credentials, token);
  const drive = google.drive({ version: "v3", auth });

  async function listSingle(query: string): Promise<DriveFileRecord | null> {
    const response = await drive.files.list({
      q: query,
      fields: "files(id,name,mimeType,webViewLink,appProperties,parents)",
      spaces: "drive",
      pageSize: 10,
    });
    const files = response.data.files ?? [];
    if (files.length > 1) throw new Error(`Drive ambiguity for query: ${query}`);
    return files[0] ? recordFromDrive(files[0]) : null;
  }

  async function ensureFolder(name: string, parentId: string, appProperties: Record<string, string>): Promise<DriveFileRecord> {
    const query = [`name = '${escapeDrive(name)}'`, `mimeType = 'application/vnd.google-apps.folder'`, `'${escapeDrive(parentId)}' in parents`, "trashed = false"].join(" and ");
    const existing = await listSingle(query);
    if (existing) return existing;
    const created = await drive.files.create({
      requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [parentId], appProperties },
      fields: "id,name,mimeType,webViewLink,appProperties,parents",
    });
    return recordFromDrive(created.data);
  }

  return {
    async getAuthorizedEmail() {
      const about = await drive.about.get({ fields: "user(emailAddress)" });
      return about.data.user?.emailAddress ?? "";
    },
    async ensureMonthlyFolder(monthlyConfig, period) {
      const rootQuery = [`name = '${escapeDrive(monthlyConfig.driveRootName)}'`, "mimeType = 'application/vnd.google-apps.folder'", "trashed = false"].join(" and ");
      const accountRoot = await listSingle(rootQuery);
      if (!accountRoot) throw new Error(`Drive root '${monthlyConfig.driveRootName}' was not found.`);
      const accounting = await ensureFolder(monthlyConfig.driveAccountingFolder, accountRoot.id, { marianAiOs: "true", accountId: monthlyConfig.accountId, resourceRole: "accounting_folder" });
      const invoices = await ensureFolder(monthlyConfig.driveInvoicesFolder, accounting.id, { marianAiOs: "true", accountId: monthlyConfig.accountId, resourceRole: "invoices_folder" });
      const year = await ensureFolder(String(period.year), invoices.id, { marianAiOs: "true", accountId: monthlyConfig.accountId, resourceRole: "year_folder", packagePeriod: period.period });
      const month = await ensureFolder(String(period.month).padStart(2, "0"), year.id, { marianAiOs: "true", accountId: monthlyConfig.accountId, resourceRole: "month_folder", packagePeriod: period.period });
      const approved = await ensureFolder("Approved Documents", month.id, { marianAiOs: "true", accountId: monthlyConfig.accountId, resourceRole: "approved_documents", packagePeriod: period.period });
      const review = await ensureFolder("Review Required", month.id, { marianAiOs: "true", accountId: monthlyConfig.accountId, resourceRole: "review_required", packagePeriod: period.period });
      const previousRunUnverified = await ensureFolder("Previous Run - Unverified", month.id, { marianAiOs: "true", accountId: monthlyConfig.accountId, resourceRole: "previous_run_unverified", packagePeriod: period.period });
      return { accountRoot, accounting, invoices, year, month, approved, review, previousRunUnverified } satisfies DriveFolderTree;
    },
    async ensureChildFolder(name, parentId, appProperties) {
      return ensureFolder(name, parentId, appProperties);
    },
    async findFileByAppProperties(parentId, appProperties) {
      const propertyQuery = Object.entries(appProperties).map(([key, value]) => `appProperties has { key='${escapeDrive(key)}' and value='${escapeDrive(value)}' }`).join(" and ");
      const query = [`'${escapeDrive(parentId)}' in parents`, "trashed = false", propertyQuery].join(" and ");
      return listSingle(query);
    },
    async listFiles(parentId) {
      const response = await drive.files.list({
        q: [`'${escapeDrive(parentId)}' in parents`, "trashed = false"].join(" and "),
        fields: "files(id,name,mimeType,webViewLink,appProperties,parents)",
        spaces: "drive",
        pageSize: 1000,
      });
      return (response.data.files ?? []).map(recordFromDrive);
    },
    async getFile(fileId) {
      try {
        const response = await drive.files.get({
          fileId,
          fields: "id,name,mimeType,webViewLink,appProperties,parents",
        });
        return recordFromDrive(response.data);
      } catch (error: any) {
        if (error?.code === 404) return null;
        throw error;
      }
    },
    async moveFile(fileId, addParentId, removeParentIds) {
      const updated = await drive.files.update({
        fileId,
        addParents: addParentId,
        removeParents: removeParentIds.join(","),
        fields: "id,name,mimeType,webViewLink,appProperties,parents",
      });
      return recordFromDrive(updated.data);
    },
    async uploadOrReuseFile(input) {
      const existing = await this.findFileByAppProperties(input.parentId, { marianAiOs: "true", sha256: input.appProperties.sha256, packagePeriod: input.appProperties.packagePeriod });
      if (existing) return { file: existing, created: false };
      const created = await drive.files.create({
        requestBody: { name: input.filename, parents: [input.parentId], appProperties: input.appProperties },
        media: { mimeType: input.mimeType, body: fs.createReadStream(input.localPath) },
        fields: "id,name,mimeType,webViewLink,appProperties,parents",
      });
      return { file: recordFromDrive(created.data), created: true };
    },
    async uploadOrReusePdf(input) {
      return this.uploadOrReuseFile!({
        parentId: input.parentId,
        localPath: input.localPath,
        filename: input.filename,
        mimeType: "application/pdf",
        appProperties: input.appProperties,
      });
    },
    async uploadOrReplaceJson(input) {
      const existing = await this.findFileByAppProperties(input.parentId, { marianAiOs: "true", resourceRole: input.appProperties.resourceRole, packagePeriod: input.appProperties.packagePeriod });
      if (existing) {
        const updated = await drive.files.update({
          fileId: existing.id,
          requestBody: { name: input.filename, appProperties: input.appProperties },
          media: { mimeType: "application/json", body: fs.createReadStream(input.localPath) },
          fields: "id,name,mimeType,webViewLink,appProperties,parents",
        });
        return recordFromDrive(updated.data);
      }
      const created = await drive.files.create({
        requestBody: { name: input.filename, parents: [input.parentId], appProperties: input.appProperties },
        media: { mimeType: "application/json", body: fs.createReadStream(input.localPath) },
        fields: "id,name,mimeType,webViewLink,appProperties,parents",
      });
      return recordFromDrive(created.data);
    },
    async uploadOrReplaceBinary(input) {
      const existing = await this.findFileByAppProperties(input.parentId, { marianAiOs: "true", resourceRole: input.appProperties.resourceRole, packagePeriod: input.appProperties.packagePeriod });
      if (existing) {
        const updated = await drive.files.update({
          fileId: existing.id,
          requestBody: { name: input.filename, appProperties: input.appProperties },
          media: { mimeType: input.mimeType, body: fs.createReadStream(input.localPath) },
          fields: "id,name,mimeType,webViewLink,appProperties,parents",
        });
        return recordFromDrive(updated.data);
      }
      const created = await drive.files.create({
        requestBody: { name: input.filename, parents: [input.parentId], appProperties: input.appProperties },
        media: { mimeType: input.mimeType, body: fs.createReadStream(input.localPath) },
        fields: "id,name,mimeType,webViewLink,appProperties,parents",
      });
      return recordFromDrive(created.data);
    },
  };
}

export function createSheetsService(config: MonthlyWorkflowConfig, spreadsheetId: string): SheetsService {
  const credentials = loadGoogleClientCredentials();
  const token = loadGoogleTokenOrThrow(config.googleConnectionId, "drive_sheets").record;
  const auth = oauthClient(credentials, token);
  const sheets = google.sheets({ version: "v4", auth });

  const headers = [
    "Accounting Period", "Source Mailbox", "Source Direction", "Gmail Message ID", "Gmail Thread ID", "Email Date", "Sender", "Recipients", "Email Subject",
    "Original Filename", "Safe Stored Filename", "MIME Type", "SHA-256", "Extraction Method", "OCR Used", "OCR Language", "OCR Quality",
    "Document Type", "Company Relation", "Matched Equisix Identity Fields", "Supplier", "Supplier IČO", "Supplier DIČ", "Supplier IČ DPH",
    "Customer", "Customer IČO", "Customer DIČ", "Customer IČ DPH", "Document Number", "Issue Date", "Taxable Supply Date", "Due Date",
    "Subtotal", "VAT Amount", "Total", "Currency", "Receipt Number", "Payment Method", "Document Type Confidence", "Company Relation Confidence",
    "Overall Confidence", "Final Decision", "Validation Reasons", "Warnings", "Drive File URL", "Run ID", "Classification Version",
  ];

  return {
    async ensureDocumentsSheet() {
      const metadata = await sheets.spreadsheets.get({ spreadsheetId });
      const existing = metadata.data.sheets?.find((sheet) => sheet.properties?.title === "Documents");
      if (!existing) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: [{ addSheet: { properties: { title: "Documents", gridProperties: { frozenRowCount: 1 } } } }] },
        });
      }
      const firstRow = await sheets.spreadsheets.values.get({ spreadsheetId, range: "Documents!1:1" });
      if ((firstRow.data.values?.[0] ?? []).length === 0) {
        await sheets.spreadsheets.values.update({ spreadsheetId, range: "Documents!A1", valueInputOption: "RAW", requestBody: { values: [headers] } });
      }
    },
    async upsertDocuments(params) {
      const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range: "Documents!A:AZ" });
      const rows = existing.data.values ?? [];
      const shaIndex = headers.indexOf("SHA-256");
      const existingRows = new Map<string, number>();
      rows.slice(1).forEach((row, index) => {
        const sha = row[shaIndex];
        if (sha) existingRows.set(sha, index + 2);
      });

      const updates: Array<{ rowNumber: number; values: string[] }> = [];
      const appends: string[][] = [];
      for (const document of params.documents) {
        const identityMatches = document.identityMatches ?? { legalName: false, registrationNumber: false, taxId: false, vatId: false, address: false, email: false, matchedFields: [] };
        const supplier = document.supplier ?? { legalName: null, registrationNumber: null, taxId: null, vatId: null, address: null, email: null };
        const customer = document.customer ?? { legalName: null, registrationNumber: null, taxId: null, vatId: null, address: null, email: null };
        const fields = document.document ?? { documentNumber: null, variableSymbol: null, issueDate: null, taxableSupplyDate: null, dueDate: null, orderNumber: null, receiptNumber: null, cashRegisterNumber: null, paymentMethod: null };
        const amounts = document.amounts ?? { subtotal: null, vatBase: null, vatAmount: null, vatRates: [], totalAmount: null, currency: null };
        const values = [
          document.sourceMessages[0]?.localDate?.slice(0, 7) ?? "",
          [...new Set(document.sourceMessages.map((source) => source.mailbox))].join(", "),
          [...new Set(document.sourceMessages.map((source) => source.direction))].join(", "),
          [...new Set(document.sourceMessages.map((source) => source.messageId))].join(", "),
          [...new Set(document.sourceMessages.map((source) => source.threadId).filter(Boolean))].join(", "),
          document.sourceMessages[0]?.localDate ?? "",
          document.sourceMessages[0]?.from ?? "",
          [...new Set(document.sourceMessages.flatMap((source) => source.recipients))].join(", "),
          document.sourceMessages[0]?.subject ?? "",
          document.originalFilename,
          document.safeStoredFilename ?? "",
          document.mimeType,
          document.sha256,
          document.extractionMethod ?? "extraction_failed",
          document.ocrUsed ? "yes" : "no",
          document.ocrLanguage ?? "",
          document.ocrQuality ?? "",
          document.documentType,
          document.companyRelation ?? "",
          identityMatches.matchedFields.join(", "),
          supplier.legalName ?? "",
          supplier.registrationNumber ?? "",
          supplier.taxId ?? "",
          supplier.vatId ?? "",
          customer.legalName ?? "",
          customer.registrationNumber ?? "",
          customer.taxId ?? "",
          customer.vatId ?? "",
          fields.documentNumber ?? "",
          fields.issueDate ?? "",
          fields.taxableSupplyDate ?? "",
          fields.dueDate ?? "",
          amounts.subtotal ?? "",
          amounts.vatAmount ?? "",
          amounts.totalAmount ?? "",
          amounts.currency ?? "",
          fields.receiptNumber ?? "",
          fields.paymentMethod ?? "",
          String(document.documentTypeConfidence ?? ""),
          String(document.companyRelationConfidence ?? ""),
          String(document.overallConfidence ?? ""),
          document.finalDecision ?? "",
          (document.validationReasons ?? []).join(" | "),
          document.warnings.join(" | "),
          document.driveFileUrl ?? document.reviewDriveFileUrl ?? "",
          params.runId,
          String(config.packageVersion),
        ];
        const existingRow = existingRows.get(document.sha256);
        if (existingRow) updates.push({ rowNumber: existingRow, values });
        else appends.push(values);
      }

      for (const update of updates) {
        await sheets.spreadsheets.values.update({ spreadsheetId, range: `Documents!A${update.rowNumber}`, valueInputOption: "RAW", requestBody: { values: [update.values] } });
      }
      if (appends.length > 0) {
        await sheets.spreadsheets.values.append({ spreadsheetId, range: "Documents!A:AZ", valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", requestBody: { values: appends } });
      }
      return { appended: appends.length, updated: updates.length };
    },
  };
}

export function createGmailSendService(config: MonthlyWorkflowConfig): GmailSendService | null {
  const resolvedToken = loadGoogleTokenOrThrowSafe(config.googleConnectionId);
  if (!resolvedToken) return null;
  const credentials = loadGoogleClientCredentials();
  const auth = oauthClient(credentials, resolvedToken.record);
  const gmail = google.gmail({ version: "v1", auth });

  function buildMime(email: { to: string; from: string; subject: string; textBody: string; attachZip: boolean; zipPath: string; zipFilename: string }): string {
    if (!email.attachZip) {
      return [`From: ${email.from}`, `To: ${email.to}`, `Subject: ${email.subject}`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "", email.textBody].join("\r\n");
    }
    const boundary = `boundary_${Date.now()}`;
    const attachment = fs.readFileSync(email.zipPath).toString("base64");
    return [
      `From: ${email.from}`, `To: ${email.to}`, `Subject: ${email.subject}`, "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
      `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', "", email.textBody,
      `--${boundary}`, `Content-Type: application/zip; name="${email.zipFilename}"`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${email.zipFilename}"`, "", attachment, `--${boundary}--`,
    ].join("\r\n");
  }

  return {
    async getProfileEmail() {
      const profile = await gmail.users.getProfile({ userId: "me" });
      return profile.data.emailAddress ?? "";
    },
    async sendPreparedEmail(email) {
      const raw = Buffer.from(buildMime(email)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
      const response = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
      if (!response.data.id) throw new Error("Gmail did not return a sent message ID.");
      return { id: response.data.id };
    },
  };
}

function loadGoogleTokenOrThrowSafe(connectionId: string) {
  try {
    return loadGoogleTokenOrThrow(connectionId, "gmail_send");
  } catch {
    return null;
  }
}
