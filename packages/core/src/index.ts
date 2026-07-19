import { createDriveService, createGmailReadService, createGmailSendService, createSheetsService } from "../../google/src/index.js";
import { loadMonthlyConfig } from "../../../src/invoice-monthly/config.js";
import { buildCleanupPlan } from "../../../src/invoice-monthly/cleanupMonth.js";
import { createOpenRouterService } from "../../../src/invoice-monthly/openRouterExtraction.js";
import { runMonthlySecondPass } from "../../../src/invoice-monthly/secondPass.js";
import { runInvoiceMonthlyWorkflow } from "../../../src/invoice-monthly/workflow.js";
import { InvoiceMonthlyServices } from "../../../src/invoice-monthly/types.js";

function resolveAccount(argv: string[]): string {
  const index = argv.indexOf("--account");
  return index >= 0 ? argv[index + 1] : "equisix";
}

function resolveIncludedAccounts(argv: string[]): string[] {
  return argv.flatMap((value, index) => value === "--include-account" && argv[index + 1] ? [argv[index + 1]] : []);
}

export type LocalStorageAdapter = {
  kind: "local_fs";
  projectRoot: string;
};

export type CoreRunOptions = {
  storage: LocalStorageAdapter;
  argv?: string[];
  services?: InvoiceMonthlyServices;
};

export function createJsonLog(level: "info" | "error", event: string, payload: Record<string, unknown>) {
  return {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...payload,
  };
}

function createDefaultServices(projectRoot: string, argv: string[]): InvoiceMonthlyServices {
  const config = loadMonthlyConfig(projectRoot, resolveAccount(argv));
  const sourceConfigs = [config, ...resolveIncludedAccounts(argv)
    .filter((accountId) => accountId !== config.accountId)
    .map((accountId) => loadMonthlyConfig(projectRoot, accountId))];
  const gmailSources = sourceConfigs.map((sourceConfig) => ({
      accountId: sourceConfig.accountId,
      config: sourceConfig,
      gmail: createGmailReadService(sourceConfig),
    }));
  const gmailRead = gmailSources.length === 1 ? gmailSources[0].gmail : {
    async getProfileEmail() { return config.sourceEmail; },
    async listMessages(query: string, pageToken?: string | null) {
      const tokens = pageToken ? JSON.parse(Buffer.from(pageToken, "base64url").toString("utf8")) as Array<string | null | false> : gmailSources.map(() => null);
      const pages = await Promise.all(gmailSources.map((source, index) => tokens[index] === false ? null : source.gmail.listMessages(query, tokens[index])));
      const nextTokens = pages.map((page, index) => page ? page.nextPageToken ?? false : tokens[index]);
      return {
        messageIds: pages.flatMap((page, index) => (page?.messageIds ?? []).map((id) => `${gmailSources[index].accountId}:${id}`)),
        nextPageToken: nextTokens.some((token) => token !== false) ? Buffer.from(JSON.stringify(nextTokens)).toString("base64url") : null,
      };
    },
    async getMessage(encodedId: string) {
      const [accountId, ...rest] = encodedId.split(":");
      const source = gmailSources.find((item) => item.accountId === accountId);
      if (!source) throw new Error(`Unknown Gmail source '${accountId}'.`);
      const message = await source.gmail.getMessage(rest.join(":"));
      return { ...message, messageId: encodedId, mailbox: source.config.sourceEmail };
    },
    async getAttachment(encodedId: string, attachmentId: string) {
      const [accountId, ...rest] = encodedId.split(":");
      const source = gmailSources.find((item) => item.accountId === accountId);
      if (!source) throw new Error(`Unknown Gmail source '${accountId}'.`);
      return source.gmail.getAttachment(rest.join(":"), attachmentId);
    },
  };
  return {
    gmailRead,
    gmailSources,
    drive: createDriveService(config),
    sheets: createSheetsService(config, "placeholder"),
    openrouter: createOpenRouterService(),
    gmailSend: createGmailSendService(config),
  };
}

export async function runInvoiceMonthly(options: CoreRunOptions) {
  const argv = options.argv ?? process.argv.slice(2);
  const services = options.services ?? createDefaultServices(options.storage.projectRoot, argv);
  return runInvoiceMonthlyWorkflow(options.storage.projectRoot, services, argv);
}

export async function runSecondPass(options: CoreRunOptions) {
  const argv = options.argv ?? process.argv.slice(2);
  return runMonthlySecondPass(options.storage.projectRoot, argv);
}

export async function runCleanupMonth(options: { storage: LocalStorageAdapter; account: string; period: string; }) {
  return buildCleanupPlan(options.storage.projectRoot, options.account, options.period);
}

export * from "../../../src/invoice-monthly/cleanupMonth.js";
export * from "../../../src/invoice-monthly/workflow.js";
export * from "../../../src/invoice-monthly/secondPass.js";
