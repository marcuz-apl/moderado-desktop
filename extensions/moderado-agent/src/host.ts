import { AgentLoop, PolicyManager, Router } from '@moderado/core';
import { FakeProviderAdapter, freeModelPolicyFor, isFreeModelOption } from '@moderado/providers';
import { createDefaultToolRegistry, resolveInJail } from '@moderado/tools';
import {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  ChatMessage,
  IApprovalHandler,
  ModelClassification,
} from '@moderado/contracts';
import { ApprovalCoordinator, RawDecision } from './approval.js';
import { canonicalWorkspaceRoot, readConfig } from './profile.js';
import { SessionStore, StoredSession, conversationOf, createSession } from './sessions.js';

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
  /** Overrides the shared `~/.moderado` home; tests pass an isolated fixture. */
  moderadoHome?: string;
}

export interface RunOutcome {
  status: string;
  finalMessage: string | null;
  model: string;
  totalSteps: number;
  sessionId: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/** A discovered model paired with its cost classification, for the picker. */
export interface ModelOption {
  id: string;
  accessTier: string;
  toolSupport: string;
  isFree: boolean;
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
  private readonly sessions: SessionStore;
  private current: StoredSession | null = null;

  constructor(options: AgentHostOptions) {
    this.options = options;
    this.approvals = new ApprovalCoordinator({
      prompt: options.promptForApproval,
      timeoutMs: options.approvalTimeoutMs,
      nonInteractive: options.nonInteractive,
    });
    this.sessions = new SessionStore(options.moderadoHome);
  }

  /** The session the current turn belongs to, if one has started. */
  get session(): StoredSession | null {
    return this.current;
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
  async startRun(input: {
    task: string;
    planMode?: boolean;
    conversationHistory?: ChatMessage[];
    session?: StoredSession;
  }): Promise<RunOutcome> {
    if (this.running) throw new Error('A Moderado run is already in progress.');

    const controller = new AbortController();
    this.controller = controller;
    this.running = true;

    // Resume the supplied session, or the latest for this workspace, or start
    // a new one. Resuming keeps the conversation the CLI can also read.
    const session =
      input.session ??
      this.sessions.loadLatestSession(this.options.workspaceRoot) ??
      createSession(this.options.workspaceRoot, { mode: input.planMode ? 'Plan' : 'Execute' });
    this.current = session;

    try {
      const provider = new FakeProviderAdapter();
      const inventory = await provider.discoverModels(controller.signal);
      const policy = new PolicyManager({
        readOnly: input.planMode ?? false,
        nonInteractive: this.options.nonInteractive ?? false,
      });
      const history = input.conversationHistory ?? conversationOf(session.messages);

      const result = await new AgentLoop().run(input.task, {
        workspaceRoot: this.options.workspaceRoot,
        provider,
        tools: createDefaultToolRegistry(),
        approvalHandler: this,
        router: this.router,
        policy,
        signal: controller.signal,
        conversationHistory: history,
        modelInventory: inventory,
        eventListener: (event) => this.options.onEvent(event),
        routeOptions: {
          pinnedModelId: this.options.pinnedModelId,
          allowPaid: this.options.allowPaid ?? false,
          allowUnknown: this.options.allowUnknown ?? false,
          requireTools: true,
        },
      });

      // Persist the turn so the conversation survives a restart and stays
      // readable by the CLI. A failed save must not lose the turn's result.
      const usage = result.usage;
      let saved: StoredSession;
      try {
        saved = this.sessions.save({
          ...session,
          modelId: result.selectedModel.id,
          mode: input.planMode ? 'Plan' : session.mode,
          messages: conversationOf(result.messages),
          usage: usage
            ? SessionStore.applyUsage(session.usage, usage, true)
            : session.usage,
        });
        this.current = saved;
      } catch (error) {
        this.options.onEvent({
          type: 'error',
          code: 'session_save_failed',
          message: `The run finished but its session could not be saved: ${(error as Error).message}`,
          recoverable: true,
          timestamp: Date.now(),
        });
        saved = session;
      }

      return {
        status: result.status,
        finalMessage: result.finalMessage,
        model: result.selectedModel.id,
        totalSteps: result.totalSteps,
        sessionId: saved.id,
        usage: saved.usage,
      };
    } finally {
      this.running = false;
      this.controller = null;
    }
  }

  /**
   * Lists the discovered models with their cost classification, so the picker
   * can show paid and unknown-cost models behind their explicit opt-ins.
   */
  async discoverModels(): Promise<ModelOption[]> {
    const provider = new FakeProviderAdapter();
    const inventory = await provider.discoverModels();
    const state = readConfig(this.options.moderadoHome);
    const connectionId =
      state.kind === 'ok' ? (state.config.activeConnectionId as string | undefined) : undefined;
    const policy = freeModelPolicyFor(connectionId);

    return inventory.map((entry) => {
      const classification: ModelClassification = this.router.classifyModel(entry.id);
      return {
        id: entry.id,
        accessTier: classification.accessTier,
        toolSupport: classification.toolSupport,
        isFree: isFreeModelOption(entry, classification, policy),
      };
    });
  }

  /** Sessions recorded for this workspace, newest first. */
  listSessions(): ReturnType<SessionStore['listSessions']> {
    return this.sessions.listSessions(canonicalWorkspaceRoot(this.options.workspaceRoot));
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