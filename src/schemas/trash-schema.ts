import { z } from 'zod';
import { agentIdSchema } from './agent-schema.js';
import { registryAgentSchema } from './registry-schema.js';

export const trashComponentNameSchema = z.enum([
  'workspace',
  'runtime',
  'bridge',
  'logs',
  'services',
  'schedules',
]);

export const trashComponentSchema = z.object({
  name: trashComponentNameSchema,
  source: z.string().min(1),
  trashed: z.string().min(1),
  existed: z.boolean(),
  moved: z.boolean(),
});

export const trashManifestSchema = z.object({
  schema_version: z.literal(1),
  trash_id: z.string().uuid(),
  agent_id: agentIdSchema,
  name: z.string().min(1),
  deleted_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  state: z.enum(['moving', 'ready', 'restoring', 'purging', 'failed']),
  registry: registryAgentSchema,
  components: z.array(trashComponentSchema).length(6),
  error: z.string().min(1).optional(),
});

export const trashIndexSchema = z.object({
  schema_version: z.literal(1),
  entries: z.array(z.string().uuid()),
});

export type TrashManifest = z.infer<typeof trashManifestSchema>;
export type TrashComponent = z.infer<typeof trashComponentSchema>;
export type TrashComponentName = z.infer<typeof trashComponentNameSchema>;
