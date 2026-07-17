import {
  AccountsFileSchema,
  ConnectionsFileSchema,
  ProjectsFileSchema,
  WorkspaceFileSchema,
} from "./schema.js";
import { getConfigDir, readYaml } from "./loadConfig.js";

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
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

const requestedAccountId =
  getArg("account") ?? workspaceFile.workspace.default_account_id;

if (!requestedAccountId) {
  throw new Error(
    "Account context is required. Use --account equisix, --account 85runtime, or --account personal.",
  );
}
const requestedProjectId = getArg("project");
const requestedConnectionId = getArg("connection");

const account = accountsFile.accounts.find(
  (item) => item.id === requestedAccountId,
);

if (!account) {
  throw new Error(`Unknown account: ${requestedAccountId}`);
}

const project = requestedProjectId
  ? projectsFile.projects.find((item) => item.id === requestedProjectId)
  : undefined;

if (requestedProjectId && !project) {
  throw new Error(`Unknown project: ${requestedProjectId}`);
}

if (project && project.account_id !== account.id) {
  throw new Error(
    `Project '${project.id}' belongs to account '${project.account_id}', not '${account.id}'.`,
  );
}

const connection = requestedConnectionId
  ? connectionsFile.connections.find((item) => item.id === requestedConnectionId)
  : undefined;

if (requestedConnectionId && !connection) {
  throw new Error(`Unknown connection: ${requestedConnectionId}`);
}

if (connection && connection.account_id !== account.id) {
  throw new Error(
    `Connection '${connection.id}' belongs to account '${connection.account_id}', not '${account.id}'.`,
  );
}

const resolvedContext = {
  workspace_id: workspaceFile.workspace.id,
  workspace_name: workspaceFile.workspace.name,
  account_id: account.id,
  account_name: account.name,
  project_id: project?.id ?? null,
  project_name: project?.name ?? null,
  connection_id: connection?.id ?? null,
  connection_identity: connection?.identity ?? null,
  drive_root_name: account.drive_root_name,
  memory_namespace: project?.memory_namespace ?? account.memory_namespace,
};

console.log(JSON.stringify(resolvedContext, null, 2));
