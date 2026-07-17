import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { google } from "googleapis";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function findLatestRun(accountId: string): string {
  const root = path.join(process.cwd(), "data", "invoice-runs", accountId);

  if (!fs.existsSync(root)) {
    fail(`Invoice-runs directory not found for account '${accountId}'.`);
  }

  const latest = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .at(-1);

  if (!latest) {
    fail(`No invoice runs found for account '${accountId}'.`);
  }

  return latest;
}

function deriveYearMonth(runId: string): { year: string; month: string } {
  const match = runId.match(/^(\d{4})-(\d{2})/);

  if (!match) {
    fail(`Could not derive year and month from run ID '${runId}'.`);
  }

  return { year: match[1], month: match[2] };
}

type DriveResource = {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string | null;
  created: boolean;
};

const accountId = getArg("account");
const confirmWrite = getArg("confirm-write") === "YES";

if (!accountId) {
  fail("Missing --account <account-id>.");
}

if (accountId !== "equisix") {
  fail("This bootstrap version is restricted to account 'equisix'.");
}

const runId = findLatestRun(accountId);
const { year, month } = deriveYearMonth(runId);

const tokenPath = path.join(
  os.homedir(),
  ".config",
  "marian-ai-os",
  "secrets",
  "google",
  "tokens",
  "equisix-google-primary-drive-sheets.json",
);

const clientPath = path.join(
  os.homedir(),
  ".config",
  "marian-ai-os",
  "secrets",
  "google",
  "google-oauth-client.json",
);

for (const requiredPath of [tokenPath, clientPath]) {
  if (!fs.existsSync(requiredPath)) {
    fail(`Required file not found: ${requiredPath}`);
  }
}

const clientFile = JSON.parse(fs.readFileSync(clientPath, "utf8"));
const tokenRecord = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
const installed = clientFile.installed;

if (!installed?.client_id || !installed?.client_secret) {
  fail("OAuth Desktop client configuration is invalid.");
}

if (
  tokenRecord.account_id !== "equisix" ||
  tokenRecord.identity?.toLowerCase() !== "hello@equisix.com" ||
  tokenRecord.purpose !== "drive_and_sheets"
) {
  fail("Drive/Sheets token metadata does not match Equisix.");
}

if (
  !Array.isArray(tokenRecord.scopes) ||
  !tokenRecord.scopes.includes(
    "https://www.googleapis.com/auth/drive.file",
  )
) {
  fail("Required drive.file scope is missing.");
}

if (!tokenRecord.credentials?.refresh_token) {
  fail("Refresh token is missing.");
}

console.log("Equisix Google workspace bootstrap");
console.log("----------------------------------");
console.log(`Account: ${accountId}`);
console.log(`Identity: ${tokenRecord.identity}`);
console.log(`Invoice run: ${runId}`);
console.log(`Target period: ${year}/${month}`);
console.log("");
console.log("Planned Drive structure:");
console.log("equisix.com/");
console.log("└── Accounting/");
console.log("    ├── Invoice Register — Equisix");
console.log("    └── Invoices/");
console.log(`        └── ${year}/`);
console.log(`            └── ${month}/`);
console.log("");
console.log("This step creates folders and an empty register header only.");
console.log("PDF uploads: no");
console.log("Invoice rows appended: no");
console.log("Email actions: no");
console.log("");

if (!confirmWrite) {
  console.log("DRY RUN ONLY — Google Drive and Sheets were not changed.");
  console.log("");
  console.log("To create the structure, rerun with:");
  console.log(
    "npx tsx src/googleBootstrapEquisixAccounting.ts --account equisix --confirm-write YES",
  );
  process.exit(0);
}

const auth = new google.auth.OAuth2(
  installed.client_id,
  installed.client_secret,
);
auth.setCredentials(tokenRecord.credentials);

const drive = google.drive({ version: "v3", auth });
const sheets = google.sheets({ version: "v4", auth });

const about = await drive.about.get({
  fields: "user(emailAddress,displayName)",
});

const authorizedIdentity =
  about.data.user?.emailAddress?.toLowerCase() ?? null;

if (authorizedIdentity !== "hello@equisix.com") {
  fail(
    `Authorized identity '${authorizedIdentity}' does not match hello@equisix.com.`,
  );
}

async function findResource(
  name: string,
  mimeType: string,
  parentId: string,
): Promise<DriveResource | null> {
  const escapedName = escapeDriveQueryValue(name);
  const escapedParent = escapeDriveQueryValue(parentId);

  const response = await drive.files.list({
    q: [
      `name = '${escapedName}'`,
      `mimeType = '${mimeType}'`,
      `'${escapedParent}' in parents`,
      "trashed = false",
    ].join(" and "),
    fields: "files(id,name,mimeType,webViewLink,parents)",
    spaces: "drive",
    pageSize: 20,
  });

  const files = response.data.files ?? [];

  if (files.length > 1) {
    fail(
      `Multiple visible resources named '${name}' were found under '${parentId}'.`,
    );
  }

  const file = files[0];

  if (!file?.id || !file.name || !file.mimeType) {
    return null;
  }

  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    webViewLink: file.webViewLink ?? null,
    created: false,
  };
}

async function ensureFolder(
  name: string,
  parentId: string,
  role: string,
): Promise<DriveResource> {
  const existing = await findResource(name, FOLDER_MIME, parentId);

  if (existing) {
    return existing;
  }

  const response = await drive.files.create({
    requestBody: {
      name,
      mimeType: FOLDER_MIME,
      parents: [parentId],
      appProperties: {
        marianAiOs: "true",
        accountId,
        resourceRole: role,
      },
    },
    fields: "id,name,mimeType,webViewLink",
  });

  const file = response.data;

  if (!file.id || !file.name || !file.mimeType) {
    fail(`Google Drive did not return a valid folder for '${name}'.`);
  }

  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    webViewLink: file.webViewLink ?? null,
    created: true,
  };
}

async function ensureSpreadsheet(
  name: string,
  parentId: string,
): Promise<DriveResource> {
  const existing = await findResource(name, SHEET_MIME, parentId);

  if (existing) {
    return existing;
  }

  const response = await drive.files.create({
    requestBody: {
      name,
      mimeType: SHEET_MIME,
      parents: [parentId],
      appProperties: {
        marianAiOs: "true",
        accountId,
        resourceRole: "invoice_register",
      },
    },
    fields: "id,name,mimeType,webViewLink",
  });

  const file = response.data;

  if (!file.id || !file.name || !file.mimeType) {
    fail("Google Drive did not return a valid spreadsheet.");
  }

  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    webViewLink: file.webViewLink ?? null,
    created: true,
  };
}

const rootFolder = await ensureFolder("equisix.com", "root", "account_root");
const accountingFolder = await ensureFolder(
  "Accounting",
  rootFolder.id,
  "accounting_root",
);
const invoicesFolder = await ensureFolder(
  "Invoices",
  accountingFolder.id,
  "invoice_archive",
);
const yearFolder = await ensureFolder(year, invoicesFolder.id, "invoice_year");
const monthFolder = await ensureFolder(
  month,
  yearFolder.id,
  "invoice_month",
);
const register = await ensureSpreadsheet(
  "Invoice Register — Equisix",
  accountingFolder.id,
);

const spreadsheet = await sheets.spreadsheets.get({
  spreadsheetId: register.id,
  fields: "sheets(properties(sheetId,title))",
});

const firstSheet = spreadsheet.data.sheets?.[0]?.properties;

if (
  typeof firstSheet?.sheetId !== "number" ||
  typeof firstSheet.title !== "string"
) {
  fail("Could not determine the first sheet in the Invoice Register.");
}

const targetSheetTitle = "Documents";

await sheets.spreadsheets.batchUpdate({
  spreadsheetId: register.id,
  requestBody: {
    requests: [
      {
        updateSheetProperties: {
          properties: {
            sheetId: firstSheet.sheetId,
            title: targetSheetTitle,
            gridProperties: { frozenRowCount: 1 },
          },
          fields: "title,gridProperties.frozenRowCount",
        },
      },
    ],
  },
});

const headers = [
  "Status",
  "Document Type",
  "Supplier",
  "Supplier Company ID",
  "Supplier VAT ID",
  "Customer",
  "Customer Company ID",
  "Document Number",
  "Issue Date",
  "Due Date",
  "Taxable Supply Date",
  "Subtotal",
  "VAT",
  "Total",
  "Currency",
  "Original Filename",
  "Stored Filename",
  "Gmail Message ID",
  "SHA-256",
  "Drive File URL",
  "Approval",
  "Notes",
];

await sheets.spreadsheets.values.update({
  spreadsheetId: register.id,
  range: `'${targetSheetTitle}'!A1:V1`,
  valueInputOption: "RAW",
  requestBody: { values: [headers] },
});

await sheets.spreadsheets.batchUpdate({
  spreadsheetId: register.id,
  requestBody: {
    requests: [
      {
        repeatCell: {
          range: {
            sheetId: firstSheet.sheetId,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: 0,
            endColumnIndex: headers.length,
          },
          cell: {
            userEnteredFormat: {
              textFormat: { bold: true },
              horizontalAlignment: "CENTER",
              wrapStrategy: "WRAP",
            },
          },
          fields:
            "userEnteredFormat(textFormat,horizontalAlignment,wrapStrategy)",
        },
      },
      {
        setBasicFilter: {
          filter: {
            range: {
              sheetId: firstSheet.sheetId,
              startRowIndex: 0,
              startColumnIndex: 0,
              endColumnIndex: headers.length,
            },
          },
        },
      },
      {
        autoResizeDimensions: {
          dimensions: {
            sheetId: firstSheet.sheetId,
            dimension: "COLUMNS",
            startIndex: 0,
            endIndex: headers.length,
          },
        },
      },
    ],
  },
});

const resourceState = {
  version: 1,
  account_id: accountId,
  identity: authorizedIdentity,
  created_or_verified_at: new Date().toISOString(),
  source_invoice_run: runId,
  target_period: { year, month },
  resources: {
    account_root_folder: rootFolder,
    accounting_folder: accountingFolder,
    invoices_folder: invoicesFolder,
    year_folder: yearFolder,
    month_folder: monthFolder,
    invoice_register: register,
    invoice_register_sheet: {
      sheet_id: firstSheet.sheetId,
      title: targetSheetTitle,
    },
  },
};

const stateDir = path.join(process.cwd(), "data", "google-resources");
const statePath = path.join(stateDir, "equisix.json");

fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
fs.chmodSync(stateDir, 0o700);
fs.writeFileSync(statePath, JSON.stringify(resourceState, null, 2), {
  encoding: "utf8",
  mode: 0o600,
});
fs.chmodSync(statePath, 0o600);

const auditDir = path.join(process.cwd(), "data", "audit");
fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
fs.chmodSync(auditDir, 0o700);

const auditPath = path.join(
  auditDir,
  `google-bootstrap-equisix-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.json`,
);

fs.writeFileSync(
  auditPath,
  JSON.stringify(
    {
      event: "google_accounting_structure_bootstrap",
      account_id: accountId,
      identity: authorizedIdentity,
      timestamp: new Date().toISOString(),
      source_invoice_run: runId,
      resources: resourceState.resources,
      pdf_uploads: 0,
      invoice_rows_appended: 0,
      email_actions: 0,
    },
    null,
    2,
  ),
  { encoding: "utf8", mode: 0o600 },
);
fs.chmodSync(auditPath, 0o600);

console.log("Google accounting structure bootstrap passed.");
console.log("---------------------------------------------");
console.log(`Identity: ${authorizedIdentity}`);
console.log(
  `Account root: ${rootFolder.name} (${rootFolder.created ? "created" : "existing"})`,
);
console.log(
  `Accounting folder: ${accountingFolder.name} (${accountingFolder.created ? "created" : "existing"})`,
);
console.log(
  `Invoices folder: ${invoicesFolder.name} (${invoicesFolder.created ? "created" : "existing"})`,
);
console.log(
  `Year folder: ${yearFolder.name} (${yearFolder.created ? "created" : "existing"})`,
);
console.log(
  `Month folder: ${monthFolder.name} (${monthFolder.created ? "created" : "existing"})`,
);
console.log(
  `Invoice register: ${register.name} (${register.created ? "created" : "existing"})`,
);
console.log(`Register URL: ${register.webViewLink ?? "not returned"}`);
console.log(`State file: ${statePath}`);
console.log(`Audit file: ${auditPath}`);
console.log("");
console.log("PDF uploads: 0");
console.log("Invoice rows appended: 0");
console.log("Email actions: 0");
