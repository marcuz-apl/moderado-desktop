import { z } from 'zod';

export const AccessTierSchema = z.enum(['free_trial', 'paid', 'local', 'unknown']);
export type AccessTier = z.infer<typeof AccessTierSchema>;

export const ToolSupportSchema = z.enum(['supported', 'unsupported', 'unknown']);
export type ToolSupport = z.infer<typeof ToolSupportSchema>;

export const ClassificationSourceSchema = z.enum([
  'official_metadata',
  'active_probe',
  'user_config',
  'heuristic',
]);
export type ClassificationSource = z.infer<typeof ClassificationSourceSchema>;

export const ModelInventoryEntrySchema = z.object({
  id: z.string().min(1),
  object: z.literal('model').default('model'),
  created: z.number().int().nonnegative().optional(),
  owned_by: z.string().default('nvidia'),
  permission: z.array(z.unknown()).optional(),
  root: z.string().optional(),
  parent: z.string().optional(),
  /** Optional OpenAI-compatible per-token pricing, supplied as decimal strings. */
  pricing: z.record(z.string(), z.string()).optional(),
  /** Optional provider-advertised request parameters, used for capability checks. */
  supported_parameters: z.array(z.string()).optional(),
});
export type ModelInventoryEntry = z.infer<typeof ModelInventoryEntrySchema>;

export const ModelClassificationSchema = z.object({
  modelId: z.string().min(1),
  accessTier: AccessTierSchema,
  toolSupport: ToolSupportSchema,
  source: ClassificationSourceSchema,
  verifiedAt: z.string().datetime().optional(),
  notes: z.string().optional(),
});
export type ModelClassification = z.infer<typeof ModelClassificationSchema>;

export const DiscoveredModelSchema = z.object({
  id: z.string().min(1),
  created: z.number().int().nonnegative().optional(),
  ownedBy: z.string(),
  classification: ModelClassificationSchema,
});
export type DiscoveredModel = z.infer<typeof DiscoveredModelSchema>;
