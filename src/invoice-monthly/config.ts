import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { googleClientPath as sharedGoogleClientPath, secretsRoot as sharedSecretsRoot } from "../googleAuth.js";
import { MonthlyWorkflowConfig } from "./types.js";

const IdentitySchema = z.object({
  legal_name: z.string().min(1),
  known_names: z.array(z.string().min(1)).min(1),
  company_registration_number: z.object({
    value: z.string().min(1),
    label_sk: z.string().min(1),
    aliases: z.array(z.string().min(1)).min(1),
  }),
  tax_identification_number: z.object({
    value: z.string().min(1),
    label_sk: z.string().min(1),
    aliases: z.array(z.string().min(1)).min(1),
  }),
  vat_identification_number: z.object({
    value: z.string().min(1),
    label_sk: z.string().min(1),
    aliases: z.array(z.string().min(1)).min(1),
  }),
  registered_address: z.object({
    street: z.string().min(1),
    postal_code: z.string().min(1),
    city: z.string().min(1),
    country: z.string().min(1),
  }),
  registered_address_variants: z.array(z.string().min(1)).min(1),
  known_emails: z.array(z.string().email()).min(1),
  company_country: z.array(z.string().min(1)).min(1),
  company_creation_date: z.array(z.string().min(1)).min(1),
  business_activity_reference: z.object({
    primary_sk_nace: z.string().min(1),
  }),
});

const ThresholdSchema = z.object({
  invoice_auto_approve_overall: z.number().int().min(1).max(100).default(90),
  invoice_auto_approve_relation: z.number().int().min(1).max(100).default(90),
  invoice_auto_approve_document_type: z.number().int().min(1).max(100).default(90),
  receipt_auto_approve_overall: z.number().int().min(1).max(100).default(88),
  review_floor: z.number().int().min(1).max(100).default(55),
}).default({});

const ClassificationSchema = z.object({
  invoice_keywords: z.array(z.string().min(1)).default(["faktura", "invoice"]),
  receipt_keywords: z.array(z.string().min(1)).default(["blok", "pokladnicny doklad", "receipt"]),
  receipt_tax_patterns: z.array(z.string().min(1)).default(["dph", "zaklad dane", "základ dane", "cena spolu"]),
  fuel_vendors: z.array(z.string().min(1)).default(["shell", "omv", "slovnaft", "lukoil", "benzina"]),
  fuel_keywords: z.array(z.string().min(1)).default(["fuel", "diesel", "benzin", "nafta", "tank", "cerpacia stanica", "phm"]),
  meal_keywords: z.array(z.string().min(1)).default(["restaurant", "restauracia", "food", "meal", "obed", "vecera", "cafe", "coffee", "bistro"]),
  software_keywords: z.array(z.string().min(1)).default(["software", "saas", "subscription", "licence", "license", "hosting", "domain", "cloud", "api"]),
  visa_last_4: z.string().min(4).default("8627"),
  fuzzy_name_distance: z.number().int().min(0).max(4).default(1),
  short_receipt_text_threshold: z.number().int().positive().default(1000),
}).default({});

const PeriodValidationSchema = z.object({
  enabled: z.boolean().default(true),
  strict: z.boolean().default(true),
  allow_fallback_to_delivery_date: z.boolean().default(true),
  drive_cleanup_action: z.enum(["move_to_out_of_period", "delete"]).default("move_to_out_of_period"),
}).default({});

const IngestionSchema = z.object({
  next_month_scan_days: z.number().int().min(0).max(31).default(15),
}).default({});

const ConfigSchema = z.object({
  account_id: z.string().min(1),
  accounting_identity: z.string().min(1).optional(),
  source_email: z.string().email(),
  sender_email: z.string().email(),
  accountant_email: z.string().email(),
  timezone: z.string().min(1),
  schedule_day: z.number().int().min(1).max(28),
  schedule_time: z.string().regex(/^\d{2}:\d{2}$/),
  google_connection_id: z.string().min(1),
  drive_google_connection_id: z.string().min(1).optional(),
  scan_incoming_mail: z.boolean(),
  scan_sent_mail: z.boolean(),
  accounting_keywords_file: z.string().min(1),
  openrouter_model: z.string().min(1),
  drive_root_name: z.string().min(1),
  drive_root_folder_id: z.string().min(1).optional(),
  drive_accounting_folder: z.string().min(1),
  drive_invoices_folder: z.string().min(1),
  invoice_register_name: z.string().min(1),
  high_recall: z.boolean(),
  automatic_document_approval: z.boolean(),
  automatic_monthly_email_send: z.boolean(),
  include_manifest_in_zip: z.boolean(),
  always_include_monthly_drive_folder_link: z.boolean(),
  always_include_zip_drive_link: z.boolean(),
  zip_name_template: z.string().min(1),
  gmail_attachment_limit_bytes: z.number().int().positive().default(24 * 1024 * 1024),
  package_version: z.number().int().positive().default(1),
  company_identity: IdentitySchema,
  thresholds: ThresholdSchema.optional(),
  ocr_enabled: z.boolean().default(true),
  ocr_languages: z.array(z.string().min(1)).default(["slk", "ces", "eng"]),
  allow_external_models_for_documents: z.boolean().default(false),
  classification: ClassificationSchema.optional(),
  period_validation: PeriodValidationSchema.optional(),
  ingestion: IngestionSchema.optional(),
});

export function loadMonthlyConfig(projectRoot: string, accountId: string): MonthlyWorkflowConfig {
  const configCandidates = [
    path.join(projectRoot, "config", `${accountId}.yaml`),
    path.join(projectRoot, "config", `invoice-monthly.${accountId}.yaml`),
  ];
  const configPath = configCandidates.find((candidate) => fs.existsSync(candidate));
  if (!configPath) {
    throw new Error(`Missing config for account "${accountId}". Looked for: ${configCandidates.join(", ")}`);
  }
  const parsed = ConfigSchema.parse(YAML.parse(fs.readFileSync(configPath, "utf8")));
  const thresholds = ThresholdSchema.parse(parsed.thresholds ?? {});
  const classification = ClassificationSchema.parse(parsed.classification ?? {});
  const periodValidation = PeriodValidationSchema.parse(parsed.period_validation ?? {});
  const ingestion = IngestionSchema.parse(parsed.ingestion ?? {});

  return {
    accountId: parsed.account_id,
    accountingIdentity: parsed.accounting_identity ?? parsed.account_id,
    sourceEmail: parsed.source_email,
    senderEmail: parsed.sender_email,
    accountantEmail: parsed.accountant_email,
    timezone: parsed.timezone,
    scheduleDay: parsed.schedule_day,
    scheduleTime: parsed.schedule_time,
    googleConnectionId: parsed.google_connection_id,
    driveGoogleConnectionId: parsed.drive_google_connection_id ?? parsed.google_connection_id,
    scanIncomingMail: parsed.scan_incoming_mail,
    scanSentMail: parsed.scan_sent_mail,
    accountingKeywordsFile: parsed.accounting_keywords_file,
    openrouterModel: parsed.openrouter_model,
    driveRootName: parsed.drive_root_name,
    driveRootFolderId: parsed.drive_root_folder_id ?? null,
    driveAccountingFolder: parsed.drive_accounting_folder,
    driveInvoicesFolder: parsed.drive_invoices_folder,
    invoiceRegisterName: parsed.invoice_register_name,
    highRecall: parsed.high_recall,
    automaticDocumentApproval: parsed.automatic_document_approval,
    automaticMonthlyEmailSend: parsed.automatic_monthly_email_send,
    includeManifestInZip: parsed.include_manifest_in_zip,
    alwaysIncludeMonthlyDriveFolderLink: parsed.always_include_monthly_drive_folder_link,
    alwaysIncludeZipDriveLink: parsed.always_include_zip_drive_link,
    zipNameTemplate: parsed.zip_name_template,
    gmailAttachmentLimitBytes: parsed.gmail_attachment_limit_bytes,
    packageVersion: parsed.package_version,
    companyIdentity: {
      legalName: parsed.company_identity.legal_name,
      knownNames: parsed.company_identity.known_names,
      companyRegistrationNumber: {
        value: parsed.company_identity.company_registration_number.value,
        labelSk: parsed.company_identity.company_registration_number.label_sk,
        aliases: parsed.company_identity.company_registration_number.aliases,
      },
      taxIdentificationNumber: {
        value: parsed.company_identity.tax_identification_number.value,
        labelSk: parsed.company_identity.tax_identification_number.label_sk,
        aliases: parsed.company_identity.tax_identification_number.aliases,
      },
      vatIdentificationNumber: {
        value: parsed.company_identity.vat_identification_number.value,
        labelSk: parsed.company_identity.vat_identification_number.label_sk,
        aliases: parsed.company_identity.vat_identification_number.aliases,
      },
      registeredAddress: {
        street: parsed.company_identity.registered_address.street,
        postalCode: parsed.company_identity.registered_address.postal_code,
        city: parsed.company_identity.registered_address.city,
        country: parsed.company_identity.registered_address.country,
      },
      registeredAddressVariants: parsed.company_identity.registered_address_variants,
      knownEmails: parsed.company_identity.known_emails,
      companyCountry: parsed.company_identity.company_country,
      companyCreationDate: parsed.company_identity.company_creation_date,
      businessActivityReference: {
        primarySkNace: parsed.company_identity.business_activity_reference.primary_sk_nace,
      },
    },
    thresholds: {
      invoiceAutoApproveOverall: thresholds.invoice_auto_approve_overall,
      invoiceAutoApproveRelation: thresholds.invoice_auto_approve_relation,
      invoiceAutoApproveDocumentType: thresholds.invoice_auto_approve_document_type,
      receiptAutoApproveOverall: thresholds.receipt_auto_approve_overall,
      reviewFloor: thresholds.review_floor,
    },
    ocrEnabled: parsed.ocr_enabled,
    ocrLanguages: parsed.ocr_languages,
    allowExternalModelsForDocuments: parsed.allow_external_models_for_documents,
    classification: {
      invoiceKeywords: classification.invoice_keywords,
      receiptKeywords: classification.receipt_keywords,
      receiptTaxPatterns: classification.receipt_tax_patterns,
      fuelVendors: classification.fuel_vendors,
      fuelKeywords: classification.fuel_keywords,
      mealKeywords: classification.meal_keywords,
      softwareKeywords: classification.software_keywords,
      visaLast4: classification.visa_last_4,
      fuzzyNameDistance: classification.fuzzy_name_distance,
      shortReceiptTextThreshold: classification.short_receipt_text_threshold,
    },
    periodValidation: {
      enabled: periodValidation.enabled,
      strict: periodValidation.strict,
      allowFallbackToDeliveryDate: periodValidation.allow_fallback_to_delivery_date,
      driveCleanupAction: periodValidation.drive_cleanup_action,
    },
    ingestion: {
      nextMonthScanDays: ingestion.next_month_scan_days,
    },
  };
}

export function secretsRoot(): string {
  return sharedSecretsRoot();
}

export function googleClientPath(): string {
  return sharedGoogleClientPath();
}

export function gmailReadonlyTokenPath(connectionId: string): string {
  return path.join(secretsRoot(), "google", "tokens", `${connectionId}.json`);
}

export function driveSheetsTokenPath(connectionId: string): string {
  return path.join(secretsRoot(), "google", "tokens", `${connectionId}-drive-sheets.json`);
}

export function gmailSendTokenPath(connectionId: string): string {
  return path.join(secretsRoot(), "google", "tokens", `${connectionId}-gmail-send.json`);
}

export function openRouterKeyPath(): string {
  return path.join(secretsRoot(), "openrouter", "invoice-collector.key");
}
