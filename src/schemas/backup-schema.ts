import { z } from 'zod';
import { agentIdSchema, runtimeProviderSchema } from './agent-schema.js';

export const backupManifestSchema = z.object({
  schema_version: z.literal(1),
  created_at: z.string().datetime(),
  agent: z.object({ id: agentIdSchema, name: z.string().min(1), runtime: runtimeProviderSchema }),
  include_runtime: z.boolean(),
  files: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) })),
  environment: z.object({ node: z.string(), platform: z.string(), arch: z.string() }),
  // OP3-B：加性字段，记录生产者 Factory 版本；旧备份默认 ''（前向兼容，零行为变更）。
  factory_version: z.string().default(''),
});

export type BackupManifest = z.infer<typeof backupManifestSchema>;
