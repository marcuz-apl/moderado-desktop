import { z } from 'zod';

export const MessageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const ToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.unknown()),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ToolCallChunkSchema = z.object({
  index: z.number().int().nonnegative(),
  id: z.string().optional(),
  name: z.string().optional(),
  argumentsDelta: z.string().optional(),
});
export type ToolCallChunk = z.infer<typeof ToolCallChunkSchema>;

export const SystemMessageSchema = z.object({
  role: z.literal('system'),
  content: z.string(),
});
export type SystemMessage = z.infer<typeof SystemMessageSchema>;

export const UserMessageSchema = z.object({
  role: z.literal('user'),
  content: z.string(),
});
export type UserMessage = z.infer<typeof UserMessageSchema>;

export const AssistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.string().nullable().default(null),
  toolCalls: z.array(ToolCallSchema).optional(),
});
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;

export const ToolMessageSchema = z.object({
  role: z.literal('tool'),
  toolCallId: z.string().min(1),
  name: z.string().min(1),
  content: z.string(),
  status: z.enum(['success', 'error', 'denied']).default('success'),
});
export type ToolMessage = z.infer<typeof ToolMessageSchema>;

export const ChatMessageSchema = z.discriminatedUnion('role', [
  SystemMessageSchema,
  UserMessageSchema,
  AssistantMessageSchema,
  ToolMessageSchema,
]);
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
