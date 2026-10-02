import { AgentLoop, PolicyManager, Router } from '@moderado/core';
import {
  FakeProviderAdapter,
  NvidiaAdapter,
  OpenAICompatibleAdapter,
  findProviderPreset,
  freeModelPolicyFor,
  isFreeModelOption,
} from '@moderado/providers';
import { createDefaultToolRegistry, resolveInJail } from '@moderado/tools';
import {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  ChatMessage,
  IApprovalHandler,
  IProviderAdapter,
  ModelClassification,
} from '@moderado/contracts';
import { ApprovalCoordinator, RawDecision } from './approval.js';
import { ConfigState, canonicalWorkspaceRoot, readConfig } from './profile.js';
import { CredentialStore, MemoryCredentialStore, resolveCredential } from './credentials.js';
import { SessionStore, StoredSession, conversationOf, createSession, saveSessionChecked } from './sessions.js';

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
  /**
   * Where provider keys are read from. Production injects
   * `WindowsCredentialStore`; the default is in-memory so a test or a
   * non-Windows host never touches the real keychain.
   */
  credentialStore?: CredentialStore;
}

/**
 * Resolves the provider adapter for a run from the shared `~/.moderado` config.
 *
 * The key is resolved here and injected into the adapter. It is never written to
 * an editor setting, returned to a renderer, or placed in an event. The adapter
 * is a vendored class, not a model-directed object, so this keeps the "no
 * renderer holds provider secrets" boundary intact.
 */

/** A connection as stored in `config.json`, validated at this boundary. */
export interface ProviderConnection {
  id: string;
  displayName?: string;
  kind?: string;
  baseUrl?: string;
  /** Credential Manager target, never the key itself. */
  credentialReference?: string;
  /** Legacy plaintext key, still honoured by the CLI's resolution order. */
  apiKey?: string;
}

export interface ProviderResolution {
  adapter: IProviderAdapter;
  /** Set when the run fell back to the fake provider, for user-facing events. */
  reason?: string;
}

/** The provider environment variable the CLI would consult for this connection. */
function envVarFor(connectionId: string): string {
  return `MODERADO_${connectionId.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

function baseUrlFor(connection: ProviderConnection): string | undefined {
  const trimmed = connection.baseUrl?.trim();
  if (trimmed) return trimmed;
  // Fall back to the pinned preset's own endpoint for a known provider id.
  if (connection.kind === 'nvidia-nim') return undefined;
  return undefined;
}

/**
 * Builds the adapter for `state`'s active connection.
 *
 * Returns the fake adapter when no usable connection is configured, so the
 * editor still opens and the failure is visible as a reason rather than a
 * thrown error at run time.
 */
export async function resolveProvider(
  state: ConfigState,
  store: CredentialStore = new MemoryCredentialStore(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderResolution> {
  if (state.kind !== 'ok') {
    return { adapter: new FakeProviderAdapter(), reason: 'The shared profile could not be read.' };
  }

  const connections = (state.config.connections ?? {}) as Record<string, ProviderConnection>;
  const activeId = state.config.activeConnectionId;
  const connection =
    (typeof activeId === 'string' ? connections[activeId] : undefined) ??
    Object.values(connections).find((c) => c && typeof c === 'object');

  if (!connection?.id) {
    return {
      adapter: new FakeProviderAdapter(),
      reason: 'No provider connection is configured. Run "Moderado: Configure Provider Connection".',
    };
  }

  const apiKey = await resolveCredential(
    env[envVarFor(connection.id)],
    connection.credentialReference,
    connection.apiKey,
    store,
  );

  // A local runtime (Ollama, LM Studio) needs no key, so a missing key is only
  // an error when the preset actually requires one.
  const preset = findProviderPreset(connection.kind ?? 'openai-compatible');
  const requiresKey = preset ? preset.requiresApiKey : true;
  if (requiresKey && !apiKey) {
    return {
      adapter: new FakeProviderAdapter(),
      reason: `No API key resolved for connection '${connection.id}'.`,
    };
  }

  const baseUrl = baseUrlFor(connection);
  if (connection.kind === 'nvidia-nim') {
    return { adapter: new NvidiaAdapter({ apiKey, baseUrl }) };
  }
  return {
    adapter: new OpenAICompatibleAdapter({
      apiKey,
      baseUrl,
      providerId: connection.id,
      providerName: connection.displayName ?? connection.id,
    }),
  };
}

  /** The outcome of one bounded agent turn. */
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
  /**
   * Where provider keys come from. Overridable so tests never reach the real
   * Windows Credential Manager; production injects `WindowsCredentialStore`.
   */
  private readonly credentials: CredentialStore;
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
    this.credentials = options.credentialStore ?? new MemoryCredentialStore();
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
      // The provider is resolved from the shared profile. When no usable
      // connection exists it falls back to the fake adapter and says so, rather
      // than silently pretending a real run happened.
      const { adapter: provider, reason } = await resolveProvider(
        readConfig(this.options.moderadoHome),
        this.credentials,
      );
      if (reason) {
        this.options.onEvent({
          type: 'error',
          code: 'provider_unavailable',
          message: reason,
          recoverable: true,
          timestamp: Date.now(),
        });
      }
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
        // Checked save: if the CLI touched this session since it was read, the
        // write is refused rather than silently losing one side's conversation.
        const attempt = saveSessionChecked(
          this.sessions,
          {
            ...session,
            modelId: result.selectedModel.id,
            mode: input.planMode ? 'Plan' : session.mode,
            messages: conversationOf(result.messages),
            usage: usage ? SessionStore.applyUsage(session.usage, usage, true) : session.usage,
          },
          { knownUpdatedAt: session.updatedAt },
        );
        if (!attempt.saved) {
          this.options.onEvent({
            type: 'error',
            code: 'session_conflict',
            message: attempt.conflict.reason,
            recoverable: true,
            timestamp: Date.now(),
          });
          saved = attempt.conflict.existing ?? session;
          this.current = saved;
        } else {
          saved = attempt.session;
          this.current = saved;
        }
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
    const { adapter: provider } = await resolveProvider(
      readConfig(this.options.moderadoHome),
      this.credentials,
    );
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