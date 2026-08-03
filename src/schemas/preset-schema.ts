import { z } from 'zod';
import { agentIdSchema } from './agent-schema.js';

export const presetSchema = z.object({
  schema_version: z.literal(1),
  id: agentIdSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  goals: z.array(z.string().min(1)).min(1),
  responsibilities: z.array(z.string().min(1)).min(1),
  policies: z.array(z.string().min(1)).min(1),
  escalation_conditions: z.array(z.string().min(1)).default([]),
  skills: z.array(agentIdSchema).default([]),
});

export type Preset = z.infer<typeof presetSchema>;
