import { AgentLoop, PolicyManager, Router } from '@moderado/core';
import { FakeProviderAdapter } from '@moderado/providers';
import { createDefaultToolRegistry, resolveInJail } from '@moderado/tools';
import {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  ChatMessage,
  IApprovalHandler,
} from '@moderado/contracts';
import { ApprovalCoordinator, RawDecision } from './approval.js';

export interface AgentHostOptions {
  workspaceRoot: string;
  /** Receives validated events for rendering. Never receives provider secrets. */
  onEvent: (event: AgentEvent) => void;
  /** Asks the human for a decision. The renderer supplies only the answer. */
  promptForApproval: (request: ApprovalRequest, signal: AbortSignal) => Promise<RawDecision | undefined>;
  approvalTimeoutMs?: number;
  nonInteractive?: boolean;
  allowPaid?: boolean;
  allowUnknown?: boolean;
  pinnedModelId?: string;
}

export interface RunOutcome {
  status: string;
  finalMessage: string | null;
  model: string;
  totalSteps: number;
}

/**
 * Composition root for the Desktop agent.
 *
 * It injects the vendored core loop with a concrete provider, the jailed tool
 * registry, the fail-closed approval handler, and an event consumer. The
 * renderer can ask for a run and answer approvals; it cannot grant itself tool
 * permissions or supply credentials.
 */
export class AgentHost implements IApprovalHandler {
  private readonly options: AgentHostOptions;
  private readonly approvals: ApprovalCoordinator;
  private readonly router = new Router();
  private controller: AbortController | null = null;
  private running = false;

  constructor(options: AgentHostOptions) {
    this.options = options;
    this.approvals = new ApprovalCoordinator({
      prompt: options.promptForApproval,
      timeoutMs: options.approvalTimeoutMs,
      nonInteractive: options.nonInteractive,
    });
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Cancels the active run and denies anything awaiting a decision. */
  cancel(reason = 'Cancelled by the user.'): void {
    this.controller?.abort();
    this.approvals.denyAll('cancelled', reason);
  }

  /** Denies pending approvals, e.g. when the chat view is disposed. */
  dispose(): void {
    this.cancel('The Moderado view was closed.');
  }

  /**
   * The core's approval entry point. Routed through the coordinator so the
   * returned decision id is matched, a real deadline is enforced, and a missing
   * preview, closed view, or cancellation denies instead of approving.
   */
  async requestApproval(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
    return this.approvals.requestApproval(request, signal);
  }

  /**
   * Runs one bounded agent turn against the vendored core.
   *
   * Plan mode is enforced as read-only through core policy, so a plan-mode run
   * cannot mutate files or run commands regardless of any earlier approval.
   */
  async startRun(input: { task: string; planMode?: boolean; conversationHistory?: ChatMessage[] }): Promise<RunOutcome> {
    if (this.running) throw new Error('A Moderado run is already in progress.');

    const controller = new AbortController();
    this.controller = controller;
    this.running = true;

    try {
      const provider = new FakeProviderAdapter();
      const inventory = await provider.discoverModels(controller.signal);
      const policy = new PolicyManager({
        readOnly: input.planMode ?? false,
        nonInteractive: this.options.nonInteractive ?? false,
      });

      const result = await new AgentLoop().run(input.task, {
        workspaceRoot: this.options.workspaceRoot,
        provider,
        tools: createDefaultToolRegistry(),
        approvalHandler: this,
        router: this.router,
        policy,
        signal: controller.signal,
        conversationHistory: input.conversationHistory,
        modelInventory: inventory,
        eventListener: (event) => this.options.onEvent(event),
        routeOptions: {
          pinnedModelId: this.options.pinnedModelId,
          allowPaid: this.options.allowPaid ?? false,
          allowUnknown: this.options.allowUnknown ?? false,
          requireTools: true,
        },
      });

      return {
        status: result.status,
        finalMessage: result.finalMessage,
        model: result.selectedModel.id,
        totalSteps: result.totalSteps,
      };
    } finally {
      this.running = false;
      this.controller = null;
    }
  }
}

/**
 * Builds the payload shown to the human for a proposed tool call.
 *
 * Every affected path is canonicalized inside the workspace jail, so the preview
 * names the file that would really be written rather than an unvalidated
 * model-supplied string.
 */
export function previewFor(toolName: string, parameters: unknown, workspaceRoot: string): Record<string, unknown> {
  const params = (parameters ?? {}) as Record<string, unknown>;
  const relative = typeof params.path === 'string' ? params.path : undefined;
  const target = relative && relative.trim() ? resolveInJail(workspaceRoot, relative) : undefined;

  switch (toolName) {
    case 'write_file':
      return { targetFile: target, contentPreview: String(params.content ?? '') };
    case 'edit_file':
    case 'apply_patch':
      return { targetFile: target, contentPreview: String(params.new_string ?? params.content ?? '') };
    case 'run_command':
      return { command: Array.isArray(params.command) ? params.command : [], cwd: workspaceRoot };
    default:
      return { targetFile: target };
  }
}