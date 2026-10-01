/**
 * M7.10 — Core subagent delegation via dependency injection.
 *
 * A subagent is a child AgentLoop that reuses the same tool registry and
 * approval handler as its parent, so it cannot bypass core policy. No new
 * package. No LSP work. Minimal surface: one class, one method.
 */
import { AgentLoop } from './agent.js';
import type { AgentRunOptions, AgentRunResult } from './agent.js';
import { AgentEventListener, IApprovalHandler, IProviderAdapter, IToolRegistry } from '@moderado/contracts';
import { PolicyManager } from './policy.js';

export class SubagentDelegator {
  constructor(
    private readonly parentWorkspaceRoot: string,
    private readonly tools: IToolRegistry,
    private readonly approvalHandler: IApprovalHandler,
    private readonly parentEventListener?: AgentEventListener,
    private readonly parentPolicy = new PolicyManager(),
    private readonly onMutationApproved?: AgentRunOptions['onMutationApproved'],
    private readonly onMutationCompleted?: AgentRunOptions['onMutationCompleted'],
  ) {}

  /**
   * Delegate a focused sub-task to a child agent loop. The child:
   * - Inherits the same tool registry (same capabilities, same approval surface).
   * - Inherits the same approval handler (parent policy governs subagent mutations).
   * - Is bounded by a step budget (default 5 steps, capped).
   * - Emits events to the parent listener so the host sees subagent activity.
   *
   * The provider must be supplied by the caller (parent) so the child can
   * perform model inference. This keeps the child provider-agnostic — same as
   * the parent AgentLoop.
   */
  async delegate(
    task: string,
    provider: IProviderAdapter,
    options: { maxSteps?: number; signal?: AbortSignal } = {},
  ): Promise<AgentRunResult> {
    const childSteps = Math.min(options.maxSteps ?? 5, this.parentPolicy.maxSteps);
    const signal = options.signal;

    const childEventListener: AgentEventListener = (event) => {
      this.parentEventListener?.(event);
    };

    const child = new AgentLoop();
    const childOptions: AgentRunOptions = {
      workspaceRoot: this.parentWorkspaceRoot,
      provider,
      tools: this.tools,
      approvalHandler: this.approvalHandler,
      policy: new PolicyManager({
        maxSteps: childSteps,
        readOnly: this.parentPolicy.readOnly,
        nonInteractive: this.parentPolicy.nonInteractive,
        timeoutSeconds: this.parentPolicy.timeoutSeconds,
      }),
      eventListener: childEventListener,
      signal,
      conversationHistory: [],
      allowSubagentDelegation: false,
      onMutationApproved: this.onMutationApproved,
      onMutationCompleted: this.onMutationCompleted,
    };

    return child.run(task, childOptions);
  }
}
