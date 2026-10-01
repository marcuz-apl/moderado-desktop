import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import {
  AgentEventListener,
  HostEventListener,
  ApprovalDecision,
  ApprovalRequest,
  AssistantMessage,
  ChatUsage,
  ChatMessage,
  DiscoveredModel,
  EmptyResponseError,
  IApprovalHandler,
  IProviderAdapter,
  IToolRegistry,
  ModelInventoryEntry,
  isRetryableProviderError,
  ProviderToolDeclaration,
  RateLimitError,
  ToolCall,
  ToolResult,
  UsageEvent,
} from '@moderado/contracts';
import { Router, RouteSelectionOptions } from './router.js';
import { PolicyManager } from './policy.js';
import { HostEventStream } from './host_event_stream.js';
import { SubagentDelegator } from './subagent.js';
import { ThinkTagStreamFilter } from './think_filter.js';

export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export interface AgentRunOptions {
  workspaceRoot: string;
  provider: IProviderAdapter;
  tools: IToolRegistry;
  approvalHandler: IApprovalHandler;
  router?: Router;
  policy?: PolicyManager;
  routeOptions?: RouteSelectionOptions;
  eventListener?: AgentEventListener;
  hostEventListener?: HostEventListener;
  signal?: AbortSignal;
  conversationHistory?: ChatMessage[];
  modelInventory?: ModelInventoryEntry[];
  onMutationApproved?: (toolName: string, parameters: unknown) => Promise<void> | void;
  onMutationCompleted?: (toolName: string, parameters: unknown, result: ToolResult) => Promise<void> | void;
  /** Internal boundary: child loops must not create further subagents. */
  allowSubagentDelegation?: boolean;
  /** Hard cap on generated output tokens to prevent runaway token spend. Defaults to DEFAULT_MAX_OUTPUT_TOKENS (4096). */
  maxOutputTokens?: number;
  /** Optional untrusted user skill context appended to the system prompt. */
  skillContext?: string;
  /** Validated skill bodies exposed only through the read-only load_skill tool. */
  skills?: readonly { name: string; body: string }[];
  retryDelaysMs?: number[];
}

export interface AgentRunResult {
  status: 'completed' | 'step_limit_reached' | 'cancelled' | 'failed';
  totalSteps: number;
  finalMessage: string | null;
  selectedModel: DiscoveredModel;
  messages: ChatMessage[];
  usage?: ChatUsage;
}

export const DEFAULT_SYSTEM_PROMPT = `CRITICAL DIRECTIVE — EXTREME BREVITY (DEFAULT MODE):
- Answer in 1 to 2 short sentences or under 35 words by default; provide more detail when the user asks for it.
- Keep thinking concise by default; do not elaborate unless the user asks for more detail.
- Zero conversational filler: Never output greetings, pleasantries, preambles ("Sure", "Here is", "Certainly", "I'd be happy to"), or sign-offs ("Hope this helps", "Let me know").
- Never restate, rephrase, or echo the user's question before answering. Start immediately with the direct answer.
- Zero markdown headers (no ## or ###), no bullet lists unless specifically requested, no conclusion sections.
- For code, commands, or file edits: Output ONLY the raw code or command block. Do NOT explain what it does or how it works.
- State only direct, factual answers. Do NOT provide unsolicited background, tips, or commentary.

You are Moderado, a lightweight, pragmatic, bloat-free AI coding agent.
You follow the Ponytail Decision Ladder: YAGNI, standard library first, zero unnecessary dependencies, and minimal code.
Use the provided workspace tools to inspect, read, search, modify, and test files within the workspace.

CORE OPERATIONAL RULES:
- If the user prompt is a greeting, question, explanation request, or conversational query, output regular markdown text directly without calling any tools.
- ONLY invoke tools when explicitly needed to inspect or modify the workspace as requested by the user.
- NEVER create, write, or overwrite any files (including documentation, project summaries, or boilerplate) unless the user explicitly commanded you to create or modify that file in their prompt.
- Do NOT create unsolicited files on your own initiative.
- Always inspect existing code (with list_files, read_file, search_files) before editing. Keep edits focused, clean, and test-driven.
- Do NOT invent tool names.
- For anything that changes over time (weather, news, scores, prices, schedules, releases), call the web_search tool immediately with a clear query. Never fetch this with run_command, and never ask the user to look it up themselves. Answer with the facts and values only, in the fewest readable lines, without listing sources or URLs.`;

export function buildSystemPrompt(modelId: string, workspaceRoot: string, skillContext?: string): string {
  return `${DEFAULT_SYSTEM_PROMPT}

SYSTEM RUNTIME CONTEXT:
- Active Model: ${modelId}
- Workspace Root: ${workspaceRoot}${skillContext ? `\n\n${skillContext}` : ''}`;
}

export function cleanConversationalFiller(text: string): string {
  if (!text) return text;
  let cleaned = text.trim();
  // Strip complete or unclosed thinking/reasoning blocks
  cleaned = cleaned.replace(/<\s*(?:think|thought|reasoning)(?:\s+[^>]*)?>[\s\S]*?<\/\s*(?:think|thought|reasoning)\s*>\s*/gi, '');
  cleaned = cleaned.replace(/<\s*(?:think|thought|reasoning)(?:\s+[^>]*)?>[\s\S]*$/gi, '');
  // Strip untagged thinking process blocks (either extract subsequent answer or clear if unclosed)
  if (/^(?:Here's\s+(?:a\s+|my\s+)?thinking\s+process|Thinking\s+process)/i.test(cleaned)) {
    const parts = cleaned.split(/\r?\n\r?\n/);
    const answerIndex = parts.findIndex((p, idx) => idx > 0 && !/^\s*(?:\d+\.|\*|-)/.test(p));
    cleaned = answerIndex !== -1 ? parts.slice(answerIndex).join('\n\n').trim() : '';
  }
  // Strip common multi-line leading filler
  cleaned = cleaned.replace(/^(?:Sure(?: thing)?[!,.]?|Certainly[!,.]?|Of course[!,.]?|Here is[^\n:]*[:.]?|Here's[^\n:]*[:.]?|I would be happy to[^\n:]*[:.]?|I'd be happy to[^\n:]*[:.]?|Great[!,.]?|Okay[!,.]?|Alright[!,.]?)\s*(?:\r?\n)+/i, '');
  // Strip single-line leading filler prefix like "Sure! Here is the answer: " or "Sure, ..."
  cleaned = cleaned.replace(/^(?:Sure(?: thing)?[!,.]?|Certainly[!,.]?|Of course[!,.]?|I'd be happy to help[!,.]?)\s+(?:Here (?:is|are)[^:\n]*:\s*)?/i, '');
  // Strip common trailing sign-offs
  cleaned = cleaned.replace(/(?:\r?\n)+(?:Hope this helps[^\n]*|Let me know if (?:you need|you have)[^\n]*|Feel free to ask[^\n]*)\.?\s*$/i, '');
  return cleaned.trim();
}

const PSEUDO_ANSWER_TOOLS = new Set([
  'answer_directly',
  'answer',
  'respond',
  'response',
  'chat',
  'message',
  'final_answer',
  'reply',
  'subagent',
]);

const SUBAGENT_DECLARATION: ProviderToolDeclaration = {
  name: 'subagent',
  description: 'Delegate one focused sub-task to a bounded child agent that follows the same workspace and approval policies.',
  parameters: {
    type: 'object',
    properties: {
      detail: { type: 'string' },
    },
    required: ['detail'],
  },
};

const LOAD_SKILL_DECLARATION: ProviderToolDeclaration = {
  name: 'load_skill',
  description: 'Load the instructions for one available coding skill when relevant to the task.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  },
};

const LoadSkillSchema = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/) });

const SubagentDetailSchema = z.object({
  detail: z.string().trim().min(1).max(2000),
});

export class AgentLoop {
  async run(task: string, options: AgentRunOptions): Promise<AgentRunResult> {
    const hostStream = options.hostEventListener ? new HostEventStream(options.hostEventListener) : undefined;
    const emit = (event: any): void => { options.eventListener?.(event); hostStream?.emit(event); };
    const policy = options.policy ?? new PolicyManager();
    const router = options.router ?? new Router();
    const signal = options.signal;
    let childUsage: UsageEvent | undefined;
    const delegator = new SubagentDelegator(
      options.workspaceRoot,
      options.tools,
      options.approvalHandler,
      (event) => {
        if (event.type !== 'usage') { emit(event); return; }
        childUsage = event;
        const usage = {
          promptTokens: taskUsage.promptTokens + event.usage.promptTokens,
          completionTokens: taskUsage.completionTokens + event.usage.completionTokens,
          totalTokens: taskUsage.totalTokens + event.usage.totalTokens,
        };
        const generationMs = taskGenerationMs + event.generationMs;
        emit({ ...event, usage, estimated: hasEstimatedUsage || event.estimated, generationMs,
          outputTokensPerSecond: generationMs > 0 ? usage.completionTokens / (generationMs / 1000) : 0 });
      },
      policy,
      options.onMutationApproved,
      options.onMutationCompleted,
    );
    let latestUsage: ChatUsage | undefined;
    const taskUsage: ChatUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let hasEstimatedUsage = false;
    let taskGenerationMs = 0;

    const cancelBeforeRouting = (): AgentRunResult => {
      emit({ type: 'cancellation', reason: 'Aborted by user', timestamp: Date.now() });
      return {
        status: 'cancelled',
        totalSteps: 0,
        finalMessage: null,
        selectedModel: {
          id: 'aborted',
          ownedBy: 'system',
          classification: {
            modelId: 'aborted',
            accessTier: 'unknown',
            toolSupport: 'unknown',
            source: 'heuristic',
          },
        },
        messages: options.conversationHistory ? [...options.conversationHistory] : [],
        usage: latestUsage,
      };
    };
    if (signal?.aborted) return cancelBeforeRouting();

    // 1. Model Discovery & Routing
    let inventory = options.modelInventory;
    if (!inventory || inventory.length === 0) {
      if (options.routeOptions?.pinnedModelId) {
        try {
          inventory = await options.provider.discoverModels(signal);
        } catch {
          if (signal?.aborted) return cancelBeforeRouting();
          // A pinned model can still be usable when its provider does not
          // expose a model catalogue. Continue without dynamic metadata.
          inventory = [{ id: options.routeOptions.pinnedModelId, object: 'model', owned_by: options.provider.id }];
        }
      } else {
        emit({
          type: 'progress',
          step: 0,
          maxSteps: policy.maxSteps,
          status: 'Discovering and selecting models...',
          timestamp: Date.now(),
        });
        try {
          inventory = await options.provider.discoverModels(signal);
        } catch (error) {
          if (signal?.aborted) return cancelBeforeRouting();
          throw error;
        }
      }
    }
    if (signal?.aborted) return cancelBeforeRouting();

    const { selectedModel: initialModel, rankedCandidates } = router.selectModel(
      inventory,
      options.routeOptions
    );

    let currentModel = initialModel;
    emit({
      type: 'model_change',
      newModelId: currentModel.id,
      reason: options.routeOptions?.pinnedModelId ? 'user_pinned' : 'initial_selection',
      accessClass: currentModel.classification.accessTier,
      timestamp: Date.now(),
    });

    // 2. Initialize Conversation Context
    const systemPromptMessage: ChatMessage = {
      role: 'system',
      content: buildSystemPrompt(currentModel.id, options.workspaceRoot, options.skillContext),
    };

    let baseHistory = options.conversationHistory ? [...options.conversationHistory] : [];
    // Ensure system prompt is at the head and updated with current runtime context
    if (baseHistory.length > 0 && baseHistory[0].role === 'system') {
      baseHistory[0] = systemPromptMessage;
    } else {
      baseHistory = [systemPromptMessage, ...baseHistory];
    }

    // Layer 4: Truncate oversized tool outputs from older turns in history to prevent token ballooning
    const messages: ChatMessage[] = [
      ...baseHistory.map((msg, idx) => {
        if (msg.role === 'tool' && idx < baseHistory.length - 1 && typeof msg.content === 'string' && msg.content.length > 1500) {
          return {
            ...msg,
            content: msg.content.slice(0, 1500) + '\n... [earlier tool output truncated for token efficiency]',
          };
        }
        return msg;
      }),
      { role: 'user', content: task },
    ];

    let step = 0;
    let finalAssistantText: string | null = null;
    let attempt = 0;
    const retryDelays = z.array(z.number().int().nonnegative().max(10000)).max(3).parse(options.retryDelaysMs ?? [250, 750]);
    const cancelled = (): AgentRunResult => {
      emit({ type: 'cancellation', reason: 'Aborted by user', timestamp: Date.now() });
      return { status: 'cancelled', totalSteps: step, finalMessage: finalAssistantText, selectedModel: currentModel, messages, usage: latestUsage };
    };

    while (policy.isStepWithinLimit(step)) {
      if (signal?.aborted) {
        emit({ type: 'cancellation', reason: 'Aborted by user', timestamp: Date.now() });
        return {
          status: 'cancelled',
          totalSteps: step,
          finalMessage: finalAssistantText,
          selectedModel: currentModel,
          messages,
          usage: latestUsage,
        };
      }

      step++;
      emit({
        type: 'progress',
        step,
        maxSteps: policy.maxSteps,
        status: `Step ${step}/${policy.maxSteps}: Inferring next action with ${currentModel.id}...`,
        timestamp: Date.now(),
      });

      // 3. Inference with Streaming
      let assistantText = '';
      const toolCallDeltas: Map<number, { id?: string; name?: string; args: string }> = new Map();
      const estimatedInput = Math.ceil(JSON.stringify(messages).length / 4);
      let outputCharacters = 0;
      let requestUsage: ChatUsage | undefined;
      let generationStart: number | undefined;
      let generationLastAt: number | undefined;
      const publishUsage = (final: boolean): void => {
        const now = Date.now();
        const generationEnd = final ? generationLastAt : now;
        const generationMs = taskGenerationMs + (generationStart === undefined || generationEnd === undefined ? 0 : Math.max(0, generationEnd - generationStart));
        const completionTokens = Math.ceil(outputCharacters / 4);
        const current = requestUsage ?? { promptTokens: estimatedInput, completionTokens, totalTokens: estimatedInput + completionTokens };
        const usage = {
          promptTokens: taskUsage.promptTokens + current.promptTokens,
          completionTokens: taskUsage.completionTokens + current.completionTokens,
          totalTokens: taskUsage.totalTokens + current.totalTokens,
        };
        const estimated = hasEstimatedUsage || requestUsage === undefined;
        emit({ type: 'usage', usage, estimated, generationMs,
          outputTokensPerSecond: generationMs > 0 ? usage.completionTokens / (generationMs / 1000) : 0,
          final, timestamp: now });
        if (final) {
          Object.assign(taskUsage, usage);
          taskGenerationMs = generationMs;
          hasEstimatedUsage = estimated;
          latestUsage = estimated ? undefined : { ...usage };
        }
      };

      try {
        const stream = options.provider.streamChat({
          modelId: currentModel.id,
          messages,
          tools:
            currentModel.classification.toolSupport === 'unsupported'
              ? undefined
              : [
                  ...options.tools.getDeclarations(),
                  ...(options.skills?.length ? [LOAD_SKILL_DECLARATION] : []),
                  ...(options.allowSubagentDelegation === false ? [] : [SUBAGENT_DECLARATION]),
                ],
          maxTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          signal,
        });

        const thinkFilter = new ThinkTagStreamFilter();
        for await (const chunk of stream) {
          if (signal?.aborted) {
            publishUsage(true);
            emit({ type: 'cancellation', reason: 'Aborted by user', timestamp: Date.now() });
            return {
              status: 'cancelled',
              totalSteps: step,
              finalMessage: finalAssistantText,
              selectedModel: currentModel,
              messages,
              usage: latestUsage,
            };
          }

          const toolCharacters = (chunk.toolCallChunks ?? []).reduce((count, delta) => count + (delta.argumentsDelta?.length ?? 0) + (delta.name?.length ?? 0), 0);
          const generatedCharacters = (chunk.contentDelta?.length ?? 0) + (chunk.reasoningDelta?.length ?? 0) + toolCharacters;
          if (generatedCharacters > 0) {
            generationLastAt = Date.now();
            generationStart ??= generationLastAt;
            outputCharacters += generatedCharacters;
          }

          if (chunk.reasoningDelta) {
            emit({
              type: 'reasoning_delta',
              delta: chunk.reasoningDelta,
              timestamp: Date.now(),
            });
          }

          if (chunk.contentDelta) {
            const filtered = thinkFilter.process(chunk.contentDelta);
            for (const item of filtered) {
              if (item.type === 'reasoning') {
                emit({
                  type: 'reasoning_delta',
                  delta: item.delta,
                  timestamp: Date.now(),
                });
              } else {
                assistantText += item.delta;
                emit({
                  type: 'assistant_delta',
                  delta: item.delta,
                  timestamp: Date.now(),
                });
              }
            }
          }

          if (chunk.usage) {
            requestUsage = chunk.usage;
          }

          if (chunk.toolCallChunks) {
            for (const delta of chunk.toolCallChunks) {
              const current = toolCallDeltas.get(delta.index) ?? { args: '' };
              if (delta.id) current.id = delta.id;
              if (delta.name) current.name = delta.name;
              if (delta.argumentsDelta) current.args += delta.argumentsDelta;
              toolCallDeltas.set(delta.index, current);
            }
          }
          if (generatedCharacters > 0 || chunk.usage) publishUsage(false);
        }

        if (signal?.aborted) { publishUsage(true); return cancelled(); }
        for (const item of thinkFilter.flush()) {
          if (item.type === 'reasoning') {
            emit({
              type: 'reasoning_delta',
              delta: item.delta,
              timestamp: Date.now(),
            });
          } else {
            assistantText += item.delta;
            emit({
              type: 'assistant_delta',
              delta: item.delta,
              timestamp: Date.now(),
            });
          }
        }
      } catch (err: any) {
        publishUsage(true);
        if (signal?.aborted) return cancelled();
        // Handle transient errors & failover cascades in AUTO mode
        // Do not replay text that the user has already seen.
        const isTransient = isRetryableProviderError(err) && assistantText.length === 0;
        const isAutoMode = !options.routeOptions?.pinnedModelId;

        if (isTransient && attempt < retryDelays.length) {
          const delay = retryDelays[attempt++];
          emit({ type: 'progress', step, maxSteps: policy.maxSteps, status: `Retrying ${currentModel.id} in ${delay}ms...`, timestamp: Date.now() });
          try { if (delay > 0) await sleep(delay, undefined, { signal }); }
          catch (error) { if (!signal?.aborted) throw error; }
          if (signal?.aborted) return cancelled();
          step--;
          continue;
        }

        if (isTransient && isAutoMode) {
          const fallback = router.getNextFallback(rankedCandidates, currentModel.id);
          if (fallback) {
            emit({
              type: 'model_change',
              previousModelId: currentModel.id,
              newModelId: fallback.id,
              reason: err instanceof RateLimitError ? 'fallback_rate_limit' : 'fallback_unavailable',
              accessClass: fallback.classification.accessTier,
              timestamp: Date.now(),
            });
            currentModel = fallback;
            attempt = 0;
            step--; // Retry current step without consuming step limit
            continue;
          }
        }

        emit({
          type: 'error',
          code: err.code ?? 'ERR_INFERENCE_FAILED',
          message: err.message,
          recoverable: false,
          timestamp: Date.now(),
        });
        return {
          status: 'failed',
          totalSteps: step,
          finalMessage: cleanConversationalFiller(assistantText) || finalAssistantText,
          selectedModel: currentModel,
          messages,
          usage: latestUsage,
        };
      }
      publishUsage(true);
      attempt = 0;

      finalAssistantText = cleanConversationalFiller(assistantText) || null;

      // 4. Assemble Completed Tool Calls
      const completedToolCalls: ToolCall[] = [];
      for (const [, delta] of Array.from(toolCallDeltas.entries()).sort(([a], [b]) => a - b)) {
        if (delta.name) {
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = delta.args ? JSON.parse(delta.args) : {};
          } catch {
            parsedArgs = { _raw: delta.args };
          }
          completedToolCalls.push({
            id: delta.id ?? `call_${crypto.randomUUID()}`,
            name: delta.name,
            arguments: parsedArgs,
          });
        }
      }

      if (!assistantText.trim() && completedToolCalls.length === 0) {
        const emptyResponse = new EmptyResponseError(
          `${options.provider.name} returned no assistant content or tool calls for ${currentModel.id}.`
        );
        const isAutoMode = !options.routeOptions?.pinnedModelId;
        const fallback = isAutoMode
          ? router.getNextFallback(rankedCandidates, currentModel.id)
          : undefined;

        if (fallback) {
          emit({
            type: 'model_change',
            previousModelId: currentModel.id,
            newModelId: fallback.id,
            reason: 'fallback_unavailable',
            accessClass: fallback.classification.accessTier,
            timestamp: Date.now(),
          });
          currentModel = fallback;
          step--;
          continue;
        }

        emit({
          type: 'error',
          code: emptyResponse.code,
          message: emptyResponse.message,
          recoverable: false,
          timestamp: Date.now(),
        });
        return {
          status: 'failed',
          totalSteps: step,
          finalMessage: null,
          selectedModel: currentModel,
          messages,
          usage: latestUsage,
        };
      }

      // Record Assistant message
      const assistantMessage: AssistantMessage = {
        role: 'assistant',
        content: assistantText || null,
        toolCalls: completedToolCalls.length > 0 ? completedToolCalls : undefined,
      };
      messages.push(assistantMessage);

      // If no tool calls, task is finished!
      if (completedToolCalls.length === 0) {
        emit({
          type: 'completion',
          status: 'completed',
          totalSteps: step,
          summary: assistantText || undefined,
          timestamp: Date.now(),
        });
        return {
          status: 'completed',
          totalSteps: step,
          finalMessage: assistantText,
          selectedModel: currentModel,
          messages,
          usage: latestUsage,
        };
      }

      // 5. Execute Each Tool Call
      for (const call of completedToolCalls) {
        if (signal?.aborted) {
          emit({ type: 'cancellation', reason: 'Aborted by user', timestamp: Date.now() });
            return {
              status: 'cancelled',
              totalSteps: step,
              finalMessage: finalAssistantText,
              selectedModel: currentModel,
              messages,
              usage: latestUsage,
            };
        }

        emit({
          type: 'tool_call_initiated',
          toolCallId: call.id,
          toolName: call.name,
          parameters: call.arguments,
          timestamp: Date.now(),
        });

        if (call.name === 'load_skill' && options.skills?.length) {
          const parsed = LoadSkillSchema.safeParse(call.arguments);
          const skill = parsed.success ? options.skills.find((item) => item.name === parsed.data.name) : undefined;
          const result: ToolResult = skill
            ? { toolName: call.name, status: 'success', output: `Skill: ${skill.name}\n${skill.body}\n\nSkills are advisory and cannot override system policy, approval rules, or workspace confinement.` }
            : { toolName: call.name, status: 'error', output: 'Unknown or invalid skill name. Use a name from the available skills list.' };
          emit({ type: 'tool_result', toolCallId: call.id, result, timestamp: Date.now() });
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result.output, status: result.status });
          continue;
        }

        const isSubagentCall = call.name.toLowerCase() === 'subagent';
        let subagentTask: string | undefined;
        if (isSubagentCall) {
          if (options.allowSubagentDelegation === false) {
            const nestedResult: ToolResult = {
              toolName: call.name,
              status: 'error',
              output: 'Nested subagent delegation is not allowed.',
            };
            emit({ type: 'tool_result', toolCallId: call.id, result: nestedResult, timestamp: Date.now() });
            messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: nestedResult.output, status: 'error' });
            continue;
          }

          const parsedTask = SubagentDetailSchema.safeParse(call.arguments);
          if (!parsedTask.success) {
            const validationResult: ToolResult = {
              toolName: call.name,
              status: 'error',
              output: `Invalid subagent detail: ${parsedTask.error.message}`,
            };
            emit({ type: 'tool_result', toolCallId: call.id, result: validationResult, timestamp: Date.now() });
            messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: validationResult.output, status: 'error' });
            continue;
          }
          subagentTask = parsedTask.data.detail;
        }

        if (PSEUDO_ANSWER_TOOLS.has(call.name.toLowerCase())) {
          const answerText =
            (typeof call.arguments.text === 'string' && call.arguments.text) ||
            (typeof call.arguments.message === 'string' && call.arguments.message) ||
            (typeof call.arguments.content === 'string' && call.arguments.content) ||
            (typeof call.arguments.response === 'string' && call.arguments.response) ||
            (typeof call.arguments.answer === 'string' && call.arguments.answer) ||
            (typeof call.arguments._raw === 'string' && call.arguments._raw) ||
            subagentTask ||
            JSON.stringify(call.arguments);

          // Subagent tool: delegate to a bounded child agent loop
          if (isSubagentCall && subagentTask) {
            const task = subagentTask;
            emit({ type: 'progress', step: -1, status: `Delegating sub-task: ${task.slice(0, 80)}...`, timestamp: Date.now() });
            childUsage = undefined;
            const subagentResult = await delegator.delegate(task, options.provider, { maxSteps: 5, signal });
            if (childUsage) {
              // Child snapshots are cumulative: add only the last snapshot once.
              const snapshot = childUsage as UsageEvent;
              taskUsage.promptTokens += snapshot.usage.promptTokens;
              taskUsage.completionTokens += snapshot.usage.completionTokens;
              taskUsage.totalTokens += snapshot.usage.totalTokens;
              taskGenerationMs += snapshot.generationMs;
              hasEstimatedUsage ||= snapshot.estimated;
              latestUsage = hasEstimatedUsage ? undefined : { ...taskUsage };
            }
            const subResultText = subagentResult.finalMessage ?? subagentResult.status;
            emit({
              type: 'assistant_delta',
              delta: `\n**Subagent result:**\n${subResultText}`,
              timestamp: Date.now(),
            });
            assistantText = (assistantText ? assistantText + '\n' : '') + `\n**Subagent result:**\n${subResultText}`;
            finalAssistantText = assistantText;
            emit({ type: 'tool_result', toolCallId: call.id, result: { toolName: call.name, status: 'success', output: subResultText }, timestamp: Date.now() });
            messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: subResultText, status: 'success' });
            continue;
          }

          emit({
            type: 'assistant_delta',
            delta: (assistantText ? '\n' : '') + answerText,
            timestamp: Date.now(),
          });
          assistantText = (assistantText ? assistantText + '\n' : '') + answerText;
          finalAssistantText = assistantText;

          const handledResult: ToolResult = {
            toolName: call.name,
            status: 'success',
            output: 'Response delivered.',
          };
          emit({ type: 'tool_result', toolCallId: call.id, result: handledResult, timestamp: Date.now() });
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: handledResult.output,
            status: 'success',
          });
          continue;
        }

        const tool = options.tools.get(call.name);
        if (!tool) {
          const notFoundResult: ToolResult = {
            toolName: call.name,
            status: 'error',
            output: `Unknown tool: '${call.name}'.`,
          };
          emit({ type: 'tool_result', toolCallId: call.id, result: notFoundResult, timestamp: Date.now() });
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: notFoundResult.output,
            status: 'error',
          });
          continue;
        }

        // Validate parameter schema
        const parseResult = tool.parametersSchema.safeParse(call.arguments);
        if (!parseResult.success) {
          const validationResult: ToolResult = {
            toolName: call.name,
            status: 'error',
            output: `Invalid arguments for tool '${call.name}': ${parseResult.error.message}`,
          };
          emit({ type: 'tool_result', toolCallId: call.id, result: validationResult, timestamp: Date.now() });
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: validationResult.output,
            status: 'error',
          });
          continue;
        }

        // Intercept unsolicited README/documentation write operations before approval gate
        if (call.name === 'write_file' || call.name === 'edit_file') {
          const rawPath = String((call.arguments as any)?.path ?? '').trim();
          const normPath = rawPath.toLowerCase().replace(/\\/g, '/');
          const isReadmeTarget = normPath === 'readme.md' || normPath.endsWith('/readme.md');
          const taskLower = task.toLowerCase();

          if (isReadmeTarget && !taskLower.includes('readme')) {
            const rejectedResult: ToolResult = {
              toolName: call.name,
              status: 'error',
              output: `Unsolicited file modification rejected: Do not create or edit README.md unless explicitly commanded by the user's prompt. Please answer the user directly or address their actual request.`,
            };
            emit({ type: 'tool_result', toolCallId: call.id, result: rejectedResult, timestamp: Date.now() });
            messages.push({
              role: 'tool',
              toolCallId: call.id,
              name: call.name,
              content: rejectedResult.output,
              status: 'error',
            });
            continue;
          }
        }

        // Check policy constraints (read-only, non-interactive)
        const policyCheck = policy.validateToolAction(call.name, tool.requiresApproval);
        if (!policyCheck.allowed) {
          const deniedResult: ToolResult = {
            toolName: call.name,
            status: 'denied',
            output: policyCheck.reason ?? 'Denied by security policy.',
          };
          emit({ type: 'tool_result', toolCallId: call.id, result: deniedResult, timestamp: Date.now() });
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: deniedResult.output,
            status: 'denied',
          });
          continue;
        }

        // Approval Boundary
        if (tool.requiresApproval) {
          const requestId = `req_${crypto.randomUUID()}`;
          let diffPreview: string | undefined;
          try { diffPreview = await tool.preview?.(parseResult.data, { workspaceRoot: options.workspaceRoot, abortSignal: signal }); } catch { /* execution returns the actionable validation error */ }
          const requestPayload: ApprovalRequest = {
            requestId,
            toolName: call.name,
            actionSummary: `Execute ${call.name} with ${JSON.stringify(call.arguments)}`,
            exactPayload: {
              targetFile: (call.arguments as any).path,
              diffPreview,
              command: (call.arguments as any).command
                ? [(call.arguments as any).command, ...((call.arguments as any).args ?? [])]
                : undefined,
              cwd: options.workspaceRoot,
            },
            timestamp: Date.now(),
          };

          emit({ type: 'approval_request', request: requestPayload, timestamp: Date.now() });

          let decision: ApprovalDecision;
          try {
            decision = await options.approvalHandler.requestApproval(requestPayload, signal);
          } catch (err: any) {
            decision = { requestId, status: 'aborted', reason: err.message };
          }

          emit({
            type: 'approval_resolved',
            requestId,
            status: decision.status,
            reason: decision.reason,
            timestamp: Date.now(),
          });

          if (decision.status !== 'approved') {
            const userDeniedResult: ToolResult = {
              toolName: call.name,
              status: 'denied',
              output: `Action '${call.name}' was denied by the user: ${decision.reason ?? 'Approval denied'}`,
            };
            emit({ type: 'tool_result', toolCallId: call.id, result: userDeniedResult, timestamp: Date.now() });
            messages.push({
              role: 'tool',
              toolCallId: call.id,
              name: call.name,
              content: userDeniedResult.output,
              status: 'denied',
            });
            continue;
          }
        }

        // Capture a recovery point only after the human approved this mutation.
        if (tool.requiresApproval && options.onMutationApproved) {
          try {
            await options.onMutationApproved(call.name, parseResult.data);
          } catch (err: any) {
            const checkpointResult: ToolResult = { toolName: call.name, status: 'error', output: `Unable to prepare recovery checkpoint: ${err.message}` };
            emit({ type: 'tool_result', toolCallId: call.id, result: checkpointResult, timestamp: Date.now() });
            messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: checkpointResult.output, status: 'error' });
            continue;
          }
        }

        // Execute tool inside workspace
        let result: ToolResult;
        try {
          result = await tool.execute(parseResult.data, {
            workspaceRoot: options.workspaceRoot,
            abortSignal: signal,
          });
        } catch (err: any) {
          result = {
            toolName: call.name,
            status: 'error',
            output: `Tool execution failed: ${err.message}`,
          };
        }

        if (tool.requiresApproval && result.status === 'success' && options.onMutationCompleted) {
          try {
            await options.onMutationCompleted(call.name, parseResult.data, result);
          } catch (err: any) {
            result = { ...result, status: 'error', output: `${result.output}\nRecovery checkpoint could not be finalized: ${err.message}` };
          }
        }

        if (call.name === 'run_diagnostics' && result.status === 'success') {
          const diagnostics = (result.metadata?.diagnostics as unknown[]) ?? [];
          const exitCode = result.metadata?.exitCode;
          if (typeof exitCode === 'number') emit({ type: 'diagnostic_result', toolCallId: call.id, diagnostics: diagnostics as any, exitCode, timestamp: Date.now() });
        }
        emit({ type: 'tool_result', toolCallId: call.id, result, timestamp: Date.now() });
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: result.output,
          status: result.status,
        });
      }

      // If all executed tools in this turn were pseudo-answering tools, task is complete!
      const hasRealTool = completedToolCalls.some(
        (c) => !PSEUDO_ANSWER_TOOLS.has(c.name.toLowerCase())
      );
      if (!hasRealTool) {
        emit({
          type: 'completion',
          status: 'completed',
          totalSteps: step,
          summary: assistantText || undefined,
          timestamp: Date.now(),
        });
        return {
          status: 'completed',
          totalSteps: step,
          finalMessage: assistantText,
          selectedModel: currentModel,
          messages,
          usage: latestUsage,
        };
      }
    }

    // Max steps reached
    emit({
      type: 'completion',
      status: 'step_limit_reached',
      totalSteps: step,
      summary: `Reached maximum step limit (${policy.maxSteps}).`,
      timestamp: Date.now(),
    });

    return {
      status: 'step_limit_reached',
      totalSteps: step,
      finalMessage: finalAssistantText,
      selectedModel: currentModel,
      messages,
      usage: latestUsage,
    };
  }
}
