import { randomUUID } from 'node:crypto';
import {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRequestSchema,
  ApprovalDecisionSchema,
  ApprovalPayloadSchema,
} from '@moderado/contracts';

/**
 * A decision a human made in the UI. It is deliberately *not* an
 * `ApprovalDecision`: a raw decision from an untrusted renderer must not be
 * trusted until its request id has been matched and its shape validated.
 */
export interface RawDecision {
  requestId?: unknown;
  status?: unknown;
  reason?: unknown;
}

export interface ApprovalPrompt {
  /** Show the request and resolve true when the human chose to approve. */
  (request: ApprovalRequest, signal: AbortSignal): Promise<RawDecision | undefined>;
}

export interface ApprovalCoordinatorOptions {
  prompt: ApprovalPrompt;
  /** Own deadline. The core policy's timeout field is not enforced, so the host owns it. */
  timeoutMs?: number;
  /** True when no human can be present; every request is denied. */
  nonInteractive?: boolean;
}

export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

/** Upper bound on a preview payload forwarded to the UI. */
const MAX_PREVIEW_CHARS = 200_000;

/**
 * Why an approval was refused. Every refusal path is explicit so the UI can
 * explain itself and tests can assert the exact reason.
 */
export type DenialReason =
  | 'approved'
  | 'denied_by_human'
  | 'no_complete_preview'
  | 'timeout'
  | 'ui_closed'
  | 'cancelled'
  | 'malformed_decision'
  | 'request_id_mismatch'
  | 'non_interactive'
  | 'aborted';

export interface ApprovalOutcome {
  decision: ApprovalDecision;
  reason: DenialReason;
}

export function deny(requestId: string, reason: DenialReason, detail?: string): ApprovalOutcome {
  return { decision: { requestId, status: 'denied', reason: detail ?? reason }, reason };
}

/**
 * True when the payload shows a complete proposed change rather than a summary.
 *
 * The PRD requires a complete preview before any write is allowed. A write that
 * cannot produce one is denied rather than approved on the model's say-so.
 */
export function hasCompletePreview(request: ApprovalRequest): boolean {
  const payload = request.exactPayload;
  const mutationTools = new Set(['write_file', 'edit_file', 'apply_patch']);
  if (mutationTools.has(request.toolName)) {
    if (!payload.targetFile?.trim()) return false;
    return !!(payload.diffPreview?.trim() || payload.contentPreview?.trim());
  }
  if (request.toolName === 'run_command') {
    return Array.isArray(payload.command) && payload.command.length > 0 && !!payload.cwd?.trim();
  }
  return true;
}

/**
 * Fails closed. An action is approved only when a human, in a live UI, chose it
 * for this exact request before the deadline.
 *
 * The core does not validate a returned decision id and does not enforce its own
 * timeout, so both are enforced here: the id must match the pending request and
 * the host owns an explicit deadline.
 */
export class ApprovalCoordinator {
  private readonly prompt: ApprovalPrompt;
  private readonly timeoutMs: number;
  private readonly nonInteractive: boolean;
  private readonly open = new Map<string, (outcome: ApprovalOutcome) => void>();

  constructor(options: ApprovalCoordinatorOptions) {
    this.prompt = options.prompt;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.nonInteractive = options.nonInteractive ?? false;
  }

  /** Number of approvals currently awaiting a human decision. */
  get pendingCount(): number {
    return this.open.size;
  }

  /** Denies every in-flight request, e.g. when the view is disposed. */
  denyAll(reason: DenialReason, detail?: string): void {
    for (const [requestId, settle] of [...this.open.entries()]) {
      this.open.delete(requestId);
      settle(deny(requestId, reason, detail));
    }
  }

  async requestApproval(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
    const parsed = ApprovalRequestSchema.safeParse(request);
    if (!parsed.success) {
      const id = typeof (request as ApprovalRequest)?.requestId === 'string' ? (request as ApprovalRequest).requestId : 'unknown';
      return deny(id, 'malformed_decision').decision;
    }
    const valid = parsed.data;

    if (this.nonInteractive) return deny(valid.requestId, 'non_interactive').decision;
    if (signal?.aborted) return deny(valid.requestId, 'aborted').decision;
    if (!hasCompletePreview(valid)) {
      return deny(valid.requestId, 'no_complete_preview', 'Refused: no complete preview was available for this action.').decision;
    }
    return (await this.awaitDecision(valid, signal)).decision;
  }

  private awaitDecision(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalOutcome> {
    return new Promise<ApprovalOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: ApprovalOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.open.delete(request.requestId);
        signal?.removeEventListener('abort', onAbort);
        resolve(outcome);
      };

      const timer = setTimeout(
        () => finish(deny(request.requestId, 'timeout', 'Refused: no human decision arrived before the approval deadline.')),
        this.timeoutMs,
      );
      // Never hold the host process open for a pending approval.
      timer.unref?.();

      const onAbort = () => finish(deny(request.requestId, 'cancelled'));
      this.open.set(request.requestId, finish);
      signal?.addEventListener('abort', onAbort, { once: true });

      this.prompt(request, toAbortSignal(this.open, request.requestId))
        .then((raw) => {
          if (raw === undefined) {
            finish(deny(request.requestId, 'ui_closed', 'Refused: the approval view closed before a decision was made.'));
            return;
          }
          finish(this.evaluate(request, raw));
        })
        .catch(() => finish(deny(request.requestId, 'ui_closed')));
    });
  }

  private evaluate(request: ApprovalRequest, raw: RawDecision): ApprovalOutcome {
    const candidate = ApprovalDecisionSchema.safeParse(raw);
    if (!candidate.success) {
      return deny(request.requestId, 'malformed_decision', 'Refused: the decision did not match the expected approval format.');
    }
    if (candidate.data.requestId !== request.requestId) {
      // A decision for a different request must never authorize this one.
      return deny(request.requestId, 'request_id_mismatch', 'Refused: the decision did not match the request awaiting approval.');
    }
    if (candidate.data.status === 'approved') return { decision: candidate.data, reason: 'approved' };
    if (candidate.data.status === 'aborted') return { decision: candidate.data, reason: 'aborted' };
    return deny(request.requestId, 'denied_by_human', candidate.data.reason);
  }
}

function toAbortSignal(open: Map<string, unknown>, requestId: string): AbortSignal {
  const controller = new AbortController();
  const timer = setInterval(() => {
    if (!open.has(requestId)) {
      clearInterval(timer);
      controller.abort();
    }
  }, 50);
  timer.unref?.();
  return controller.signal;
}

/** Builds an approval request with a validated, size-capped payload. */
export function buildApprovalRequest(input: {
  toolName: string;
  actionSummary: string;
  payload: Record<string, unknown>;
}): ApprovalRequest {
  const payload = ApprovalPayloadSchema.parse(capPreview(input.payload));
  return ApprovalRequestSchema.parse({
    requestId: randomUUID(),
    toolName: input.toolName,
    actionSummary: input.actionSummary,
    exactPayload: payload,
    timestamp: Date.now(),
  });
}

function capPreview(payload: Record<string, unknown>): Record<string, unknown> {
  const capped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    capped[key] =
      typeof value === 'string' && value.length > MAX_PREVIEW_CHARS
        ? `${value.slice(0, MAX_PREVIEW_CHARS)}\n... [truncated at ${MAX_PREVIEW_CHARS} characters]`
        : value;
  }
  return capped;
}