import path from "node:path";
import { ensureDirectory, writeJsonAtomic } from "./fs.js";
import { AuditSummary } from "./types.js";

export function buildAuditPath(projectRoot: string, accountId: string, period: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = path.join(projectRoot, "data", "audit", "invoice-monthly", accountId);
  ensureDirectory(directory);
  return path.join(directory, `${period}-${timestamp}.json`);
}

export function writeAuditSummary(auditPath: string, summary: AuditSummary): void {
  writeJsonAtomic(auditPath, summary, 0o600);
}
