import { z } from 'zod';
import { AccessTierSchema } from './models.js';
import { DiagnosticSchema, ToolResultSchema } from './tools.js';
import { ApprovalRequestSchema, ApprovalStatusSchema } from './approvals.js';
import { ChatUsageSchema } from './provider.js';

/** Cumulative task usage; estimates are never provider-reported billing counts. */
export const UsageEventSchema = z.object({
  type: z.literal('usage'),
  usage: ChatUsageSchema,
  estimated: z.boolean(),
  outputTokensPerSecond: z.number().finite().nonnegative(),
  generationMs: z.number().finite().nonnegative(),
  final: z.boolean(),
  timestamp: z.number().int().nonnegative(),
});
export type UsageEvent = z.infer<typeof UsageEventSchema>;

export const ProgressEventSchema = z.object({
  type: z.literal('progress'),
  step: z.number().int().nonnegative(),
  maxSteps: z.number().int().positive(),
  status: z.string(),
  timestamp: z.number().int().nonnegative(),
});
export type ProgressEvent = z.infer<typeof ProgressEventSchema>;

export const ModelChangeEventSchema = z.object({
  type: z.literal('model_change'),
  previousModelId: z.string().optional(),
  newModelId: z.string().min(1),
  reason: z.enum(['initial_selection', 'fallback_rate_limit', 'fallback_unavailable', 'user_pinned']),
  accessClass: AccessTierSchema,
  timestamp: z.number().int().nonnegative(),
});
export type ModelChangeEvent = z.infer<typeof ModelChangeEventSchema>;

export const AssistantDeltaEventSchema = z.object({
  type: z.literal('assistant_delta'),
  delta: z.string(),
  timestamp: z.number().int().nonnegative(),
});
export type AssistantDeltaEvent = z.infer<typeof AssistantDeltaEventSchema>;

export const ReasoningDeltaEventSchema = z.object({
  type: z.literal('reasoning_delta'),
  delta: z.string(),
  timestamp: z.number().int().nonnegative(),
});
export type ReasoningDeltaEvent = z.infer<typeof ReasoningDeltaEventSchema>;

export const ToolCallInitiatedEventSchema = z.object({
  type: z.literal('tool_call_initiated'),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  parameters: z.record(z.unknown()),
  timestamp: z.number().int().nonnegative(),
});
export type ToolCallInitiatedEvent = z.infer<typeof ToolCallInitiatedEventSchema>;

export const ApprovalRequestEventSchema = z.object({
  type: z.literal('approval_request'),
  request: ApprovalRequestSchema,
  timestamp: z.number().int().nonnegative(),
});
export type ApprovalRequestEvent = z.infer<typeof ApprovalRequestEventSchema>;

export const ApprovalResolvedEventSchema = z.object({
  type: z.literal('approval_resolved'),
  requestId: z.string().min(1),
  status: ApprovalStatusSchema,
  reason: z.string().optional(),
  timestamp: z.number().int().nonnegative(),
});
export type ApprovalResolvedEvent = z.infer<typeof ApprovalResolvedEventSchema>;

export const ToolResultEventSchema = z.object({
  type: z.literal('tool_result'),
  toolCallId: z.string().min(1),
  result: ToolResultSchema,
  timestamp: z.number().int().nonnegative(),
});
export type ToolResultEvent = z.infer<typeof ToolResultEventSchema>;

export const DiagnosticResultEventSchema = z.object({
  type: z.literal('diagnostic_result'), toolCallId: z.string().min(1), diagnostics: z.array(DiagnosticSchema), exitCode: z.number().int(), timestamp: z.number().int().nonnegative(),
});
export type DiagnosticResultEvent = z.infer<typeof DiagnosticResultEventSchema>;
export const CompletionEventSchema = z.object({
  type: z.literal('completion'),
  status: z.enum(['completed', 'step_limit_reached', 'timeout', 'cancelled', 'failed']),
  totalSteps: z.number().int().nonnegative(),
  summary: z.string().optional(),
  timestamp: z.number().int().nonnegative(),
});
export type CompletionEvent = z.infer<typeof CompletionEventSchema>;

export const ErrorEventSchema = z.object({
  type: z.literal('error'),
  code: z.string().min(1),
  message: z.string(),
  recoverable: z.boolean().default(false),
  timestamp: z.number().int().nonnegative(),
});
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;

export const CancellationEventSchema = z.object({
  type: z.literal('cancellation'),
  reason: z.string(),
  timestamp: z.number().int().nonnegative(),
});
export type CancellationEvent = z.infer<typeof CancellationEventSchema>;

export const AgentEventSchema = z.discriminatedUnion('type', [
  UsageEventSchema,
  ProgressEventSchema,
  ModelChangeEventSchema,
  AssistantDeltaEventSchema,
  ReasoningDeltaEventSchema,
  ToolCallInitiatedEventSchema,
  ApprovalRequestEventSchema,
  ApprovalResolvedEventSchema,
  ToolResultEventSchema,
  DiagnosticResultEventSchema,
  CompletionEventSchema,
  ErrorEventSchema,
  CancellationEventSchema,
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export const HostEventEnvelopeSchema = z.object({
  protocolVersion: z.literal(1), sessionId: z.string().min(1), sequence: z.number().int().positive(), timestamp: z.number().int().nonnegative(), event: AgentEventSchema,
});
export type HostEventEnvelope = z.infer<typeof HostEventEnvelopeSchema>;
export type AgentEventListener = (event: AgentEvent) => void;
export type HostEventListener = (envelope: HostEventEnvelope) => void;
