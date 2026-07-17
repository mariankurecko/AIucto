import { z } from "zod";

export const WorkspaceFileSchema = z.object({
  workspace: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    owner: z.string().min(1),
    default_account_id: z.string().min(1).nullable(),
    require_explicit_account_context_for_writes: z.boolean(),
    created_version: z.string().min(1),
  }),
});

const LegalEntitySchema = z.object({
  name: z.string().min(1),
  registration_id: z.string().nullable(),
  vat_id: z.string().nullable(),
  tax_id: z.string().nullable(),
});

export const AccountsFileSchema = z.object({
  accounts: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      type: z.enum(["company", "personal"]),
      legal_entity: LegalEntitySchema.nullable(),
      domains: z.array(z.string().min(1)),
      drive_root_name: z.string().min(1),
      memory_namespace: z.string().min(1),
      default_folders: z.array(z.string().min(1)),
      positioning: z.string().min(1),
    }),
  ).min(1),
});

export const ConnectionsFileSchema = z.object({
  connections: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      account_id: z.string().min(1),
      provider: z.enum(["google"]),
      identity: z.string().min(1),
      enabled: z.boolean(),
      status: z.string().min(1),
      capabilities: z.array(z.string().min(1)),
    }),
  ),
  domain_routing: z.array(
    z.object({
      domain: z.string().min(1),
      account_id: z.string().min(1),
    }),
  ),
  explicit_identity_routing: z.array(
    z.object({
      identity: z.string().min(1),
      account_id: z.string().min(1),
    }),
  ),
});

export const ProjectsFileSchema = z.object({
  projects: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      account_id: z.string().min(1),
      type: z.string().min(1),
      status: z.string().min(1),
      aliases: z.array(z.string()),
      drive_relative_path: z.string().min(1),
      memory_namespace: z.string().min(1),
      ownership: z.object({
        owner_account_id: z.string().min(1),
        development_account_id: z.string().nullable(),
        billing_account_id: z.string().nullable(),
      }),
      notes: z.string(),
    }),
  ),
});

export type WorkspaceFile = z.infer<typeof WorkspaceFileSchema>;
export type AccountsFile = z.infer<typeof AccountsFileSchema>;
export type ConnectionsFile = z.infer<typeof ConnectionsFileSchema>;
export type ProjectsFile = z.infer<typeof ProjectsFileSchema>;
