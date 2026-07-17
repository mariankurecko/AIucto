import fs from "node:fs";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { ensureDirectory, sanitizePathSegment, writeFileAtomic } from "./fs.js";
import { LocalExtractionResult } from "./types.js";
import { isPdfSignature } from "./pdfValidation.js";
import { normalizeForMatching } from "./textNormalization.js";
import { performLocalOcr } from "./ocr.js";

async function extractNativePdfText(bytes: Buffer): Promise<{
  pageCount: number;
  pageTexts: string[];
}> {
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
  });
  const pdf = await loadingTask.promise;
  const pageTexts: string[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    pageTexts.push(pageText);
    page.cleanup();
  }

  await pdf.cleanup();
  await loadingTask.destroy();
  return { pageCount: pageTexts.length, pageTexts };
}

export async function extractDocumentText(params: {
  sha256: string;
  localPath: string;
  textDirectory: string;
  ocrDirectory: string;
  isPdf: boolean;
  isImage: boolean;
  ocrEnabled: boolean;
  ocrLanguages: string[];
}): Promise<LocalExtractionResult> {
  ensureDirectory(params.textDirectory);
  ensureDirectory(params.ocrDirectory);
  const textFilename = `${sanitizePathSegment(params.sha256)}.txt`;
  const textPath = path.join(params.textDirectory, textFilename);

  if (params.isPdf) {
    const bytes = fs.readFileSync(params.localPath);
    if (!isPdfSignature(bytes)) {
      return {
        extractionStatus: "invalid_pdf",
        extractionMethod: "extraction_failed",
        pageCount: null,
        textPath: null,
        ocrTextPath: null,
        extractedCharacterCount: 0,
        normalizedText: "",
        pageTexts: [],
        error: "File does not begin with a PDF signature.",
        ocr: { provider: "none", language: null, quality: "failed", outputTextPath: null, warnings: [], available: false },
      };
    }

    try {
      const native = await extractNativePdfText(bytes);
      const fullText = native.pageTexts.join("\n\n").trim();
      const normalizedText = normalizeForMatching(fullText);
      const extractedCharacterCount = normalizedText.replace(/\s/g, "").length;
      writeFileAtomic(textPath, `${fullText}\n`, 0o600);

      const needsOcr = extractedCharacterCount < 80;
      if (!needsOcr || !params.ocrEnabled) {
        return {
          extractionStatus: needsOcr ? "needs_ocr" : "text_extracted",
          extractionMethod: needsOcr ? "extraction_failed" : "native_pdf_text",
          pageCount: native.pageCount,
          textPath,
          ocrTextPath: null,
          extractedCharacterCount,
          normalizedText,
          pageTexts: native.pageTexts.map((text, index) => ({ pageNumber: index + 1, source: "native", text })),
          error: needsOcr ? "Native PDF extraction was insufficient and OCR is disabled or unavailable." : null,
          ocr: { provider: "none", language: null, quality: needsOcr ? "failed" : "high", outputTextPath: null, warnings: [], available: false },
        };
      }

      const ocr = await performLocalOcr({
        inputPath: params.localPath,
        outputDirectory: params.ocrDirectory,
        sha256: params.sha256,
        languages: params.ocrLanguages,
      });
      if (!ocr.outputTextPath) {
        return {
          extractionStatus: ocr.available ? "ocr_unavailable" : "needs_ocr",
          extractionMethod: "extraction_failed",
          pageCount: native.pageCount,
          textPath,
          ocrTextPath: null,
          extractedCharacterCount,
          normalizedText,
          pageTexts: native.pageTexts.map((text, index) => ({ pageNumber: index + 1, source: "native", text })),
          error: ocr.warnings.join(" | ") || "OCR did not produce text.",
          ocr,
        };
      }

      const ocrText = fs.readFileSync(ocr.outputTextPath, "utf8").trim();
      const mergedText = [fullText, ocrText].filter(Boolean).join("\n\n");
      const nativeHadUsefulText = extractedCharacterCount >= 20;
      return {
        extractionStatus: nativeHadUsefulText ? "mixed_extraction" : "ocr_succeeded",
        extractionMethod: nativeHadUsefulText ? "mixed_native_and_ocr" : "ocr_pdf",
        pageCount: native.pageCount,
        textPath,
        ocrTextPath: ocr.outputTextPath,
        extractedCharacterCount: normalizeForMatching(mergedText).replace(/\s/g, "").length,
        normalizedText: normalizeForMatching(mergedText),
        pageTexts: [
          ...native.pageTexts.map((text, index) => ({ pageNumber: index + 1, source: "native" as const, text })),
          { pageNumber: 0, source: "ocr" as const, text: ocrText },
        ],
        error: null,
        ocr,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        extractionStatus: message.toLowerCase().includes("password") ? "encrypted_pdf" : "parse_failed",
        extractionMethod: "extraction_failed",
        pageCount: null,
        textPath: null,
        ocrTextPath: null,
        extractedCharacterCount: 0,
        normalizedText: "",
        pageTexts: [],
        error: message,
        ocr: { provider: "none", language: null, quality: "failed", outputTextPath: null, warnings: [], available: false },
      };
    }
  }

  if (params.isImage && params.ocrEnabled) {
    const ocr = await performLocalOcr({
      inputPath: params.localPath,
      outputDirectory: params.ocrDirectory,
      sha256: params.sha256,
      languages: params.ocrLanguages,
    });
    const imageText = ocr.outputTextPath ? fs.readFileSync(ocr.outputTextPath, "utf8").trim() : "";
    if (imageText) {
      return {
        extractionStatus: "ocr_succeeded",
        extractionMethod: "ocr_image",
        pageCount: 1,
        textPath: null,
        ocrTextPath: ocr.outputTextPath,
        extractedCharacterCount: normalizeForMatching(imageText).replace(/\s/g, "").length,
        normalizedText: normalizeForMatching(imageText),
        pageTexts: [{ pageNumber: 1, source: "ocr", text: imageText }],
        error: null,
        ocr,
      };
    }
    return {
      extractionStatus: "ocr_unavailable",
      extractionMethod: "extraction_failed",
      pageCount: 1,
      textPath: null,
      ocrTextPath: null,
      extractedCharacterCount: 0,
      normalizedText: "",
      pageTexts: [],
      error: ocr.warnings.join(" | ") || "Image OCR failed.",
      ocr,
    };
  }

  return {
    extractionStatus: "parse_failed",
    extractionMethod: "extraction_failed",
    pageCount: null,
    textPath: null,
    ocrTextPath: null,
    extractedCharacterCount: 0,
    normalizedText: "",
    pageTexts: [],
    error: "Unsupported document type for extraction.",
    ocr: { provider: "none", language: null, quality: "failed", outputTextPath: null, warnings: [], available: false },
  };
}
