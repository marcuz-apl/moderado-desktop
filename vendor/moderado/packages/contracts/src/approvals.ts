import { z } from 'zod';

export const ApprovalStatusSchema = z.enum(['approved', 'denied', 'aborted']);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalPayloadSchema = z.object({
  targetFile: z.string().optional(),
  diffPreview: z.string().optional(),
  contentPreview: z.string().optional(),
  command: z.array(z.string()).optional(),
  cwd: z.string().optional(),
});
export type ApprovalPayload = z.infer<typeof ApprovalPayloadSchema>;

export const ApprovalRequestSchema = z.object({
  requestId: z.string().min(1),
  toolName: z.string().min(1),
  actionSummary: z.string().min(1),
  exactPayload: ApprovalPayloadSchema,
  timestamp: z.number().int().nonnegative(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalDecisionSchema = z.object({
  requestId: z.string().min(1),
  status: ApprovalStatusSchema,
  reason: z.string().optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export interface IApprovalHandler {
  requestApproval(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision>;
}
