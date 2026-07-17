import fs from "node:fs";
import path from "node:path";

type AnalysisRecord = {
  messageId: string;
  subject: string;
  originalFilename: string;
  storedFilename: string;
  sha256: string;
  extractionStatus:
    | "text_extracted"
    | "needs_ocr"
    | "encrypted_pdf"
    | "parse_failed"
    | "invalid_pdf";
  textFile: string | null;
  documentType: string;
  classificationConfidence: string;
  reusedFromSha256: string | null;
};

type AnalysisFile = {
  runId: string;
  accountId: string;
  connectionId: string;
  identity: string;
  records: AnalysisRecord[];
};

type Signal = {
  id: string;
  label: string;
  weight: number;
  matched: boolean;
  evidence: string | null;
};

type Decision =
  | "accounting_candidate"
  | "manual_review"
  | "non_accounting"
  | "encrypted_or_unreadable"
  | "duplicate";

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function excerpt(source: string, match: RegExpMatchArray): string {
  const index = match.index ?? 0;
  const start = Math.max(0, index - 28);
  const end = Math.min(source.length, index + match[0].length + 40);
  return source.slice(start, end).replace(/\s+/g, " ").trim();
}

function signal(
  id: string,
  label: string,
  weight: number,
  source: string,
  patterns: RegExp[],
): Signal {
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) {
      return {
        id,
        label,
        weight,
        matched: true,
        evidence: excerpt(source, match),
      };
    }
  }

  return {
    id,
    label,
    weight,
    matched: false,
    evidence: null,
  };
}

function detectSignals(source: string): Signal[] {
  return [
    signal(
      "invoice_keyword",
      "Invoice or tax-document terminology",
      5,
      source,
      [
        /\bfaktura\b/i,
        /\binvoice\b/i,
        /\btax invoice\b/i,
        /\bdanovy doklad\b/i,
        /\bvyuctovanie\b/i,
      ],
    ),
    signal(
      "proforma_keyword",
      "Proforma or advance invoice terminology",
      6,
      source,
      [
        /\bpredfaktura\b/i,
        /\bproforma\b/i,
        /\bpro forma\b/i,
        /\bzalohova faktura\b/i,
      ],
    ),
    signal(
      "credit_note_keyword",
      "Credit-note terminology",
      6,
      source,
      [
        /\bdobropis\b/i,
        /\bcredit note\b/i,
        /\bopravny danovy doklad\b/i,
      ],
    ),
    signal(
      "receipt_keyword",
      "Receipt terminology",
      5,
      source,
      [
        /\breceipt\b/i,
        /\buctenka\b/i,
        /\bpokladnicny doklad\b/i,
        /\bparagon\b/i,
      ],
    ),
    signal(
      "invoice_number",
      "Invoice or document number",
      2,
      source,
      [
        /\b(cislo|c\.)\s*(faktury|dokladu)\s*[:#]?\s*[a-z0-9][a-z0-9\/._-]{2,}/i,
        /\binvoice\s*(number|no\.?|#)\s*[:#]?\s*[a-z0-9][a-z0-9\/._-]{2,}/i,
        /\bfa\s*[:#]?\s*[0-9][0-9\/._-]{3,}/i,
      ],
    ),
    signal(
      "due_date",
      "Due date",
      2,
      source,
      [
        /\bdatum splatnosti\b/i,
        /\bsplatnost\b/i,
        /\bdue date\b/i,
        /\bpayment due\b/i,
      ],
    ),
    signal(
      "issue_date",
      "Issue date",
      1,
      source,
      [
        /\bdatum vystavenia\b/i,
        /\bdatum vyhotovenia\b/i,
        /\bdate of issue\b/i,
        /\bissue date\b/i,
      ],
    ),
    signal(
      "taxable_supply_date",
      "Taxable-supply date",
      1,
      source,
      [
        /\bdatum dodania\b/i,
        /\bdatum zdanitelneho plnenia\b/i,
        /\btax point\b/i,
      ],
    ),
    signal(
      "vat_identifier",
      "VAT identifier",
      2,
      source,
      [
        /\bic dph\b/i,
        /\bvat\s*(id|number|no\.?)\b/i,
        /\bsk[0-9]{10}\b/i,
      ],
    ),
    signal(
      "company_identifier",
      "Company or tax identifier",
      1,
      source,
      [
        /\bico\b/i,
        /\bdic\b/i,
        /\bcompany\s*(id|number)\b/i,
        /\btax\s*(id|number)\b/i,
      ],
    ),
    signal(
      "iban",
      "IBAN",
      2,
      source,
      [
        /\biban\b/i,
        /\bsk[0-9]{2}(?:\s?[0-9a-z]){16,30}\b/i,
      ],
    ),
    signal(
      "variable_symbol",
      "Variable symbol",
      2,
      source,
      [
        /\bvariabilny symbol\b/i,
        /\bvar\.?\s*symbol\b/i,
        /\bvs\s*[:#]?\s*[0-9]{3,}\b/i,
      ],
    ),
    signal(
      "amount_and_currency",
      "Amount with currency",
      2,
      source,
      [
        /\b(?:eur|usd|gbp|czk)\b/i,
        /(?:€|\$|£)\s*[0-9]/i,
        /[0-9][0-9 .,'’]*\s*(?:€|eur|usd|gbp|czk)\b/i,
      ],
    ),
    signal(
      "total_amount",
      "Total or amount due",
      2,
      source,
      [
        /\bcelkom\b/i,
        /\bcelkova suma\b/i,
        /\bsuma na uhradu\b/i,
        /\bamount due\b/i,
        /\btotal\b/i,
      ],
    ),
    signal(
      "vat_breakdown",
      "VAT breakdown",
      1,
      source,
      [
        /\bzaklad dane\b/i,
        /\bsadzba dph\b/i,
        /\bvat rate\b/i,
        /\bvat amount\b/i,
      ],
    ),

    // Negative evidence
    signal(
      "contract_keyword",
      "Contract terminology",
      -7,
      source,
      [
        /\bzmluva\b/i,
        /\bdodatok k zmluve\b/i,
        /\bcontract\b/i,
        /\bagreement\b/i,
      ],
    ),
    signal(
      "terms_keyword",
      "Terms and conditions",
      -8,
      source,
      [
        /\bvseobecne obchodne podmienky\b/i,
        /\bobchodne podmienky\b/i,
        /\bterms and conditions\b/i,
        /\bvop[_\s-]/i,
      ],
    ),
    signal(
      "price_list_keyword",
      "Price list",
      -7,
      source,
      [
        /\bcennik\b/i,
        /\bprice list\b/i,
        /\bakciovy cennik\b/i,
      ],
    ),
    signal(
      "withdrawal_keyword",
      "Withdrawal form",
      -8,
      source,
      [
        /\bodstupenie od zmluvy\b/i,
        /\bformular odstupenia\b/i,
        /\bwithdrawal form\b/i,
      ],
    ),
  ];
}

function determineSpecificType(
  matched: Signal[],
): string | null {
  const ids = new Set(matched.map((item) => item.id));

  if (ids.has("credit_note_keyword")) return "credit_note";
  if (ids.has("proforma_keyword")) return "proforma_invoice";
  if (ids.has("receipt_keyword")) return "receipt";
  if (ids.has("invoice_keyword")) return "invoice";

  return null;
}

function decide(
  record: AnalysisRecord,
  score: number,
  matched: Signal[],
): { decision: Decision; reason: string } {
  if (record.reusedFromSha256) {
    return {
      decision: "duplicate",
      reason: "Exact duplicate; reuse the first document result.",
    };
  }

  if (record.extractionStatus !== "text_extracted") {
    return {
      decision: "encrypted_or_unreadable",
      reason: `Document extraction status is ${record.extractionStatus}.`,
    };
  }

  const matchedIds = new Set(matched.map((item) => item.id));
  const strongNegative =
    matchedIds.has("terms_keyword") ||
    matchedIds.has("price_list_keyword") ||
    matchedIds.has("withdrawal_keyword");

  const accountingSignals = matched.filter((item) => item.weight > 0).length;

  if (strongNegative && score < 5) {
    return {
      decision: "non_accounting",
      reason: "Strong non-accounting terminology outweighs accounting signals.",
    };
  }

  if (score >= 8 && accountingSignals >= 3) {
    return {
      decision: "accounting_candidate",
      reason: "Multiple independent accounting signals were found.",
    };
  }

  if (score >= 3 || accountingSignals >= 2) {
    return {
      decision: "manual_review",
      reason: "Some accounting signals were found, but evidence is not strong enough.",
    };
  }

  return {
    decision: "non_accounting",
    reason: "Insufficient accounting evidence.",
  };
}

const accountId = getArg("account");
const explicitRun = getArg("run");

if (!accountId) {
  fail("Missing --account <account-id>.");
}

const root = path.join(
  process.cwd(),
  "data",
  "invoice-runs",
  accountId,
);

if (!fs.existsSync(root)) {
  fail(`No run directory found for account '${accountId}'.`);
}

const runDir = explicitRun
  ? path.resolve(explicitRun)
  : fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name))
      .sort()
      .at(-1);

if (!runDir) {
  fail(`No runs found for account '${accountId}'.`);
}

const analysisPath = path.join(runDir, "analysis.json");
const outputPath = path.join(runDir, "accounting-signals.json");

if (!fs.existsSync(analysisPath)) {
  fail(`Analysis not found: ${analysisPath}`);
}

if (fs.existsSync(outputPath)) {
  fail(
    `Output already exists: ${outputPath}. Remove it explicitly before rerunning.`,
  );
}

const analysis = JSON.parse(
  fs.readFileSync(analysisPath, "utf8"),
) as AnalysisFile;

if (analysis.accountId !== accountId) {
  fail(
    `Analysis account '${analysis.accountId}' does not match '${accountId}'.`,
  );
}

const records = analysis.records.map((record) => {
  let text = "";

  if (record.textFile) {
    const textPath = path.join(runDir, record.textFile);
    if (fs.existsSync(textPath)) {
      text = fs.readFileSync(textPath, "utf8");
    }
  }

  const source = normalize(
    [
      record.originalFilename,
      record.storedFilename,
      record.subject,
      text.slice(0, 60000),
    ].join("\n"),
  );

  const signals = detectSignals(source);
  const matched = signals.filter((item) => item.matched);
  const score = matched.reduce((sum, item) => sum + item.weight, 0);
  const specificType = determineSpecificType(matched);
  const result = decide(record, score, matched);

  return {
    messageId: record.messageId,
    subject: record.subject,
    originalFilename: record.originalFilename,
    storedFilename: record.storedFilename,
    sha256: record.sha256,
    extractionStatus: record.extractionStatus,
    exactDuplicate: Boolean(record.reusedFromSha256),
    priorPreclassification: {
      type: record.documentType,
      confidence: record.classificationConfidence,
    },
    localSignalScore: score,
    suggestedDocumentType: specificType ?? record.documentType,
    decision: result.decision,
    decisionReason: result.reason,
    matchedSignals: matched,
  };
});

const countBy = (
  values: string[],
): Record<string, number> =>
  values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});

const output = {
  runId: analysis.runId,
  accountId: analysis.accountId,
  connectionId: analysis.connectionId,
  identity: analysis.identity,
  analyzedAt: new Date().toISOString(),
  localOnly: true,
  openRouterUsed: false,
  totals: {
    records: records.length,
    decisions: countBy(records.map((record) => record.decision)),
    suggestedTypes: countBy(
      records.map((record) => record.suggestedDocumentType),
    ),
  },
  records,
};

fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), {
  encoding: "utf8",
  mode: 0o600,
  flag: "wx",
});
fs.chmodSync(outputPath, 0o600);

console.log("Local accounting-signal analysis passed.");
console.log("----------------------------------------");
console.log(`Run directory: ${runDir}`);
console.log(`Records analyzed: ${records.length}`);
console.log(`Output: ${outputPath}`);
console.log("");
console.log("Decisions:");

for (const [decision, count] of Object.entries(output.totals.decisions)) {
  console.log(`- ${decision}: ${count}`);
}

console.log("");
console.log("Documents:");

records.forEach((record, index) => {
  console.log(`[${index + 1}] ${record.storedFilename}`);
  console.log(`    decision: ${record.decision}`);
  console.log(`    score: ${record.localSignalScore}`);
  console.log(`    suggested type: ${record.suggestedDocumentType}`);
  console.log(
    `    matched signals: ${
      record.matchedSignals.map((item) => item.id).join(", ") || "none"
    }`,
  );
});

console.log("");
console.log("PDF text sent externally: no");
console.log("OpenRouter used: no");
console.log("Google writes: no");
