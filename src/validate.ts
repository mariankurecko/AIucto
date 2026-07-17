import {
  AccountsFileSchema,
  ConnectionsFileSchema,
  ProjectsFileSchema,
  WorkspaceFileSchema,
} from "./schema.js";
import { getConfigDir, readYaml } from "./loadConfig.js";
import { loadMonthlyConfig } from "./invoice-monthly/config.js";
import { keywordCounts, loadKeywordConfig } from "./invoice-monthly/accountingKeywords.js";

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }

  if (duplicates.size > 0) {
    throw new Error(`${label} contains duplicate IDs: ${[...duplicates].join(", ")}`);
  }
}

const configDir = getConfigDir();

const workspaceFile = WorkspaceFileSchema.parse(
  readYaml(configDir, "workspace.yaml"),
);
const accountsFile = AccountsFileSchema.parse(
  readYaml(configDir, "accounts.yaml"),
);
const connectionsFile = ConnectionsFileSchema.parse(
  readYaml(configDir, "connections.yaml"),
);
const projectsFile = ProjectsFileSchema.parse(
  readYaml(configDir, "projects.yaml"),
);
const monthlyConfig = loadMonthlyConfig(process.cwd(), "equisix");
const monthlyKeywords = loadKeywordConfig(process.cwd(), monthlyConfig.accountingKeywordsFile);

const accountIds = new Set(accountsFile.accounts.map((account) => account.id));
const projectIds = new Set(projectsFile.projects.map((project) => project.id));

assertUnique([...accountIds], "Account Registry");
assertUnique(
  connectionsFile.connections.map((connection) => connection.id),
  "Connection Registry",
);
assertUnique([...projectIds], "Project Registry");

if (
  workspaceFile.workspace.default_account_id &&
  !accountIds.has(workspaceFile.workspace.default_account_id)
) {
  throw new Error(
    `Workspace default_account_id '${workspaceFile.workspace.default_account_id}' does not exist.`,
  );
}

for (const connection of connectionsFile.connections) {
  if (!accountIds.has(connection.account_id)) {
    throw new Error(
      `Connection '${connection.id}' references unknown account '${connection.account_id}'.`,
    );
  }

  if (
    connection.enabled &&
    connection.identity.startsWith("REPLACE_WITH_")
  ) {
    throw new Error(
      `Connection '${connection.id}' is enabled but still contains a placeholder identity.`,
    );
  }
}

for (const route of connectionsFile.domain_routing) {
  if (!accountIds.has(route.account_id)) {
    throw new Error(
      `Domain route '${route.domain}' references unknown account '${route.account_id}'.`,
    );
  }
}

for (const route of connectionsFile.explicit_identity_routing) {
  if (!accountIds.has(route.account_id)) {
    throw new Error(
      `Identity route '${route.identity}' references unknown account '${route.account_id}'.`,
    );
  }
}

for (const project of projectsFile.projects) {
  if (!accountIds.has(project.account_id)) {
    throw new Error(
      `Project '${project.id}' references unknown account '${project.account_id}'.`,
    );
  }

  if (!accountIds.has(project.ownership.owner_account_id)) {
    throw new Error(
      `Project '${project.id}' has unknown owner account '${project.ownership.owner_account_id}'.`,
    );
  }

  for (const optionalAccountId of [
    project.ownership.development_account_id,
    project.ownership.billing_account_id,
  ]) {
    if (optionalAccountId && !accountIds.has(optionalAccountId)) {
      throw new Error(
        `Project '${project.id}' references unknown optional account '${optionalAccountId}'.`,
      );
    }
  }
}

console.log("Registry validation passed.");
console.log(`Workspace: ${workspaceFile.workspace.name}`);
console.log(`Accounts: ${[...accountIds].join(", ")}`);
console.log(`Projects: ${[...projectIds].join(", ") || "none"}`);
console.log(`Invoice monthly config: ${monthlyConfig.accountId} -> ${monthlyConfig.accountantEmail}`);
console.log(`Accounting keyword counts: +${keywordCounts(monthlyKeywords).positive} / -${keywordCounts(monthlyKeywords).negative}`);
