import fs from "node:fs";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

type ManifestRecord = {
  messageId: string;
  threadId: string | null;
  from: string;
  subject: string;
  date: string;
  originalFilename: string;
  storedFilename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  exactDuplicateWithinRun: boolean;
  duplicateOfSha256: string | null;
};

type Manifest = {
  runId: string;
  accountId: string;
  connectionId: string;
  identity: string;
  records: ManifestRecord[];
};

type DocumentType =
  | "invoice"
  | "proforma_invoice"
  | "credit_note"
  | "receipt"
  | "contract"
  | "terms_and_conditions"
  | "price_list"
  | "withdrawal_form"
  | "other"
  | "uncertain";

type ExtractionStatus =
  | "text_extracted"
  | "needs_ocr"
  | "encrypted_pdf"
  | "parse_failed"
  | "invalid_pdf";

type AnalysisRecord = ManifestRecord & {
  extractionStatus: ExtractionStatus;
  pageCount: number | null;
  extractedCharacterCount: number;
  textFile: string | null;
  documentType: DocumentType;
  classificationConfidence: "high" | "medium" | "low";
  classificationEvidence: string[];
  error: string | null;
  reusedFromSha256: string | null;
};

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function isPdf(bytes: Buffer): boolean {
  return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
}

function evidenceFragment(source: string, match: RegExpMatchArray): string {
  const index = match.index ?? 0;
  const start = Math.max(0, index - 35);
  const end = Math.min(source.length, index + match[0].length + 35);
  return source.slice(start, end).replace(/\s+/g, " ").trim();
}

function preclassify(
  filename: string,
  subject: string,
  text: string,
): {
  type: DocumentType;
  confidence: "high" | "medium" | "low";
  evidence: string[];
} {
  const source = normalizeText(`${filename}\n${subject}\n${text.slice(0, 30000)}`);

  const rules: Array<{
    type: Exclude<DocumentType, "other" | "uncertain">;
    weight: number;
    patterns: RegExp[];
  }> = [
    {
      type: "credit_note",
      weight: 100,
      patterns: [
        /\bdobropis\b/i,
        /\bcredit note\b/i,
        /\bopravn[ýy] da[nň]ov[ýy] doklad\b/i,
      ],
    },
    {
      type: "proforma_invoice",
      weight: 95,
      patterns: [
        /\bproforma\b/i,
        /\bpro forma\b/i,
        /\bpredfakt[uú]ra\b/i,
        /\bz[aá]lohov[aá] fakt[uú]ra\b/i,
      ],
    },
    {
      type: "invoice",
      weight: 80,
      patterns: [
        /\bfakt[uú]ra\b/i,
        /\binvoice\b/i,
        /\btax invoice\b/i,
        /\bda[nň]ov[ýy] doklad\b/i,
        /\bvy[uú][cč]tovanie\b/i,
      ],
    },
    {
      type: "receipt",
      weight: 75,
      patterns: [
        /\breceipt\b/i,
        /\b[uú][cč]tenka\b/i,
        /\bpokladni[cč]n[ýy] doklad\b/i,
        /\bparag[oó]n\b/i,
      ],
    },
    {
      type: "contract",
      weight: 70,
      patterns: [
        /\bzmluva\b/i,
        /\bdodatok k zmluve\b/i,
        /\bagreement\b/i,
        /\bcontract\b/i,
      ],
    },
    {
      type: "terms_and_conditions",
      weight: 70,
      patterns: [
        /\bv[sš]eobecn[eé] obchodn[eé] podmienky\b/i,
        /\bobchodn[eé] podmienky\b/i,
        /\bterms and conditions\b/i,
        /\bvop[_\s-]/i,
      ],
    },
    {
      type: "price_list",
      weight: 65,
      patterns: [
        /\bcenn[ií]k\b/i,
        /\bprice list\b/i,
        /\bakciov[ýy] cenn[ií]k\b/i,
      ],
    },
    {
      type: "withdrawal_form",
      weight: 65,
      patterns: [
        /\bodst[uú]penie od zmluvy\b/i,
        /\bformul[aá]r odst[uú]penia\b/i,
        /\bwithdrawal form\b/i,
      ],
    },
  ];

  const scores = new Map<DocumentType, number>();
  const evidence = new Map<DocumentType, string[]>();

  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      const match = source.match(pattern);
      if (!match) continue;

      scores.set(rule.type, (scores.get(rule.type) ?? 0) + rule.weight);
      const fragments = evidence.get(rule.type) ?? [];
      fragments.push(evidenceFragment(source, match));
      evidence.set(rule.type, fragments);
    }
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);

  if (ranked.length === 0) {
    return {
      type: text.trim().length >= 80 ? "other" : "uncertain",
      confidence: "low",
      evidence: [],
    };
  }

  const [bestType, bestScore] = ranked[0];
  const secondScore = ranked[1]?.[1] ?? 0;

  // Prefer more specific accounting types over generic invoice when both match.
  if (
    ["credit_note", "proforma_invoice"].includes(bestType) ||
    bestScore >= secondScore + 30
  ) {
    return {
      type: bestType,
      confidence: bestScore >= 95 ? "high" : "medium",
      evidence: (evidence.get(bestType) ?? []).slice(0, 3),
    };
  }

  if (bestScore === secondScore) {
    return {
      type: "uncertain",
      confidence: "low",
      evidence: [
        ...(evidence.get(ranked[0][0]) ?? []),
        ...(evidence.get(ranked[1][0]) ?? []),
      ].slice(0, 4),
    };
  }

  return {
    type: bestType,
    confidence: "medium",
    evidence: (evidence.get(bestType) ?? []).slice(0, 3),
  };
}

async function extractPdfText(
  filePath: string,
): Promise<{
  status: ExtractionStatus;
  pageCount: number | null;
  text: string;
  error: string | null;
}> {
  const bytes = fs.readFileSync(filePath);

  if (!isPdf(bytes)) {
    return {
      status: "invalid_pdf",
      pageCount: null,
      text: "",
      error: "File does not begin with a PDF signature.",
    };
  }

  try {
    const loadingTask = getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: true,
    });

    const pdf = await loadingTask.promise;
    const pageTexts: string[] = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();

      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      pageTexts.push(text);
      page.cleanup();
    }

    await pdf.cleanup();
    await loadingTask.destroy();

    const fullText = pageTexts.join("\n\n").trim();
    const meaningfulCharacters = fullText.replace(/\s/g, "").length;

    if (meaningfulCharacters < 80) {
      return {
        status: "needs_ocr",
        pageCount: pageTexts.length,
        text: fullText,
        error: null,
      };
    }

    return {
      status: "text_extracted",
      pageCount: pageTexts.length,
      text: fullText,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : "";

    if (
      name.toLowerCase().includes("password") ||
      message.toLowerCase().includes("password")
    ) {
      return {
        status: "encrypted_pdf",
        pageCount: null,
        text: "",
        error: message,
      };
    }

    return {
      status: "parse_failed",
      pageCount: null,
      text: "",
      error: message,
    };
  }
}

const accountId = getArg("account");
const explicitRun = getArg("run");

if (!accountId) {
  fail("Missing --account <account-id>.");
}

const accountRunsRoot = path.join(
  process.cwd(),
  "data",
  "invoice-runs",
  accountId,
);

if (!fs.existsSync(accountRunsRoot)) {
  fail(`No invoice run directory found for account '${accountId}'.`);
}

const runDir = explicitRun
  ? path.resolve(explicitRun)
  : fs
      .readdirSync(accountRunsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(accountRunsRoot, entry.name))
      .sort()
      .at(-1);

if (!runDir) {
  fail(`No invoice runs found for account '${accountId}'.`);
}

const manifestPath = path.join(runDir, "manifest.json");
const filesDir = path.join(runDir, "files");
const textDir = path.join(runDir, "text");
const analysisPath = path.join(runDir, "analysis.json");

if (!fs.existsSync(manifestPath)) {
  fail(`Manifest not found: ${manifestPath}`);
}

if (!fs.existsSync(filesDir)) {
  fail(`PDF directory not found: ${filesDir}`);
}

if (fs.existsSync(analysisPath)) {
  fail(
    `Analysis already exists: ${analysisPath}. Remove it explicitly before rerunning.`,
  );
}

fs.mkdirSync(textDir, { recursive: true, mode: 0o700 });
fs.chmodSync(textDir, 0o700);

const manifest = JSON.parse(
  fs.readFileSync(manifestPath, "utf8"),
) as Manifest;

if (manifest.accountId !== accountId) {
  fail(
    `Manifest account '${manifest.accountId}' does not match requested account '${accountId}'.`,
  );
}

const processedByHash = new Map<
  string,
  {
    extractionStatus: ExtractionStatus;
    pageCount: number | null;
    extractedCharacterCount: number;
    textFile: string | null;
    documentType: DocumentType;
    classificationConfidence: "high" | "medium" | "low";
    classificationEvidence: string[];
    error: string | null;
  }
>();

const records: AnalysisRecord[] = [];

for (const record of manifest.records) {
  const prior = processedByHash.get(record.sha256);

  if (prior) {
    records.push({
      ...record,
      ...prior,
      reusedFromSha256: record.sha256,
    });
    continue;
  }

  const pdfPath = path.join(filesDir, record.storedFilename);

  if (!fs.existsSync(pdfPath)) {
    const missing = {
      extractionStatus: "parse_failed" as const,
      pageCount: null,
      extractedCharacterCount: 0,
      textFile: null,
      documentType: "uncertain" as const,
      classificationConfidence: "low" as const,
      classificationEvidence: [],
      error: `PDF file not found: ${pdfPath}`,
    };

    processedByHash.set(record.sha256, missing);
    records.push({
      ...record,
      ...missing,
      reusedFromSha256: null,
    });
    continue;
  }

  const extraction = await extractPdfText(pdfPath);
  const classification = preclassify(
    record.originalFilename,
    record.subject,
    extraction.text,
  );

  let textFile: string | null = null;

  if (extraction.text.length > 0) {
    const textFilename = `${record.sha256}.txt`;
    const textPath = path.join(textDir, textFilename);

    fs.writeFileSync(textPath, extraction.text, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    fs.chmodSync(textPath, 0o600);
    textFile = path.relative(runDir, textPath);
  }

  const result = {
    extractionStatus: extraction.status,
    pageCount: extraction.pageCount,
    extractedCharacterCount: extraction.text.length,
    textFile,
    documentType:
      extraction.status === "text_extracted"
        ? classification.type
        : ("uncertain" as const),
    classificationConfidence:
      extraction.status === "text_extracted"
        ? classification.confidence
        : ("low" as const),
    classificationEvidence:
      extraction.status === "text_extracted"
        ? classification.evidence
        : [],
    error: extraction.error,
  };

  processedByHash.set(record.sha256, result);

  records.push({
    ...record,
    ...result,
    reusedFromSha256: null,
  });
}

const countBy = <T extends string>(
  values: T[],
): Record<string, number> =>
  values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});

const output = {
  runId: manifest.runId,
  accountId: manifest.accountId,
  connectionId: manifest.connectionId,
  identity: manifest.identity,
  analyzedAt: new Date().toISOString(),
  localOnly: true,
  openRouterUsed: false,
  ocrUsed: false,
  totals: {
    records: records.length,
    uniquePdfHashes: processedByHash.size,
    duplicateRecordsReused: records.filter(
      (record) => record.reusedFromSha256 !== null,
    ).length,
    extractionStatuses: countBy(
      records.map((record) => record.extractionStatus),
    ),
    documentTypes: countBy(records.map((record) => record.documentType)),
  },
  records,
};

fs.writeFileSync(analysisPath, JSON.stringify(output, null, 2), {
  encoding: "utf8",
  mode: 0o600,
  flag: "wx",
});
fs.chmodSync(analysisPath, 0o600);

console.log("Local PDF extraction and preclassification passed.");
console.log("------------------------------------------------");
console.log(`Run directory: ${runDir}`);
console.log(`Account: ${manifest.accountId}`);
console.log(`Records analyzed: ${records.length}`);
console.log(`Unique PDF hashes: ${processedByHash.size}`);
console.log(`Duplicate records reused: ${output.totals.duplicateRecordsReused}`);
console.log(`Analysis file: ${analysisPath}`);
console.log("");
console.log("Extraction statuses:");

for (const [status, count] of Object.entries(
  output.totals.extractionStatuses,
)) {
  console.log(`- ${status}: ${count}`);
}

console.log("");
console.log("Preclassified document types:");

for (const [type, count] of Object.entries(output.totals.documentTypes)) {
  console.log(`- ${type}: ${count}`);
}

console.log("");
console.log("Documents:");

records.forEach((record, index) => {
  const duplicate = record.reusedFromSha256 ? " [REUSED DUPLICATE]" : "";
  console.log(`[${index + 1}] ${record.storedFilename}${duplicate}`);
  console.log(`    extraction: ${record.extractionStatus}`);
  console.log(`    pages: ${record.pageCount ?? "unknown"}`);
  console.log(`    characters: ${record.extractedCharacterCount}`);
  console.log(
    `    preliminary type: ${record.documentType} (${record.classificationConfidence})`,
  );
  if (record.error) console.log(`    error: ${record.error}`);
});

console.log("");
console.log("PDF text sent externally: no");
console.log("OpenRouter used: no");
console.log("OCR used: no");
console.log("Google Drive writes: no");
console.log("Google Sheets writes: no");
console.log("Gmail writes: no");
