import {
  ChatCompletionChunk,
  IProviderAdapter,
  ModelInventoryEntry,
  ProviderChatOptions,
} from '@moderado/contracts';

export class FakeProviderAdapter implements IProviderAdapter {
  public readonly id = 'fake';
  public readonly name = 'Fake Provider (Testing)';

  public models: ModelInventoryEntry[] = [
    {
      id: 'mock/free-tool-model',
      object: 'model',
      created: 1700000000,
      owned_by: 'nvidia',
    },
    {
      id: 'mock/paid-tool-model',
      object: 'model',
      created: 1700000000,
      owned_by: 'nvidia',
    },
    {
      id: 'mock/text-only-model',
      object: 'model',
      created: 1700000000,
      owned_by: 'nvidia',
    },
  ];

  public recordedCalls: ProviderChatOptions[] = [];
  private responseQueue: (ChatCompletionChunk[] | Error)[] = [];

  queueResponse(chunks: ChatCompletionChunk[]): void {
    this.responseQueue.push(chunks);
  }

  queueTextResponse(text: string, finishReason: 'stop' | 'length' = 'stop'): void {
    this.responseQueue.push([
      { contentDelta: text },
      { finishReason },
    ]);
  }

  queueToolCallResponse(
    toolName: string,
    toolArgs: Record<string, unknown>,
    assistantText?: string,
    callId = `call_${Date.now()}`
  ): void {
    const chunks: ChatCompletionChunk[] = [];
    if (assistantText) {
      chunks.push({ contentDelta: assistantText });
    }
    chunks.push({
      toolCallChunks: [
        {
          index: 0,
          id: callId,
          name: toolName,
          argumentsDelta: JSON.stringify(toolArgs),
        },
      ],
      finishReason: 'tool_calls',
    });
    this.responseQueue.push(chunks);
  }

  queueError(error: Error): void {
    this.responseQueue.push(error);
  }

  clear(): void {
    this.recordedCalls = [];
    this.responseQueue = [];
  }

  async discoverModels(signal?: AbortSignal): Promise<ModelInventoryEntry[]> {
    if (signal?.aborted) {
      throw new Error('Aborted');
    }
    return [...this.models];
  }

  async *streamChat(options: ProviderChatOptions): AsyncIterable<ChatCompletionChunk> {
    this.recordedCalls.push(options);

    if (options.signal?.aborted) {
      throw new Error('Request was aborted');
    }

    const next = this.responseQueue.shift();
    if (!next) {
      // Default fallback response
      yield { contentDelta: 'Mock assistant response.' };
      yield { finishReason: 'stop' };
      return;
    }

    if (next instanceof Error) {
      throw next;
    }

    for (const chunk of next) {
      if (options.signal?.aborted) {
        throw new Error('Request was aborted');
      }
      yield chunk;
    }
  }
}
