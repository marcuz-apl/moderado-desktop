import {
  AuthenticationError,
  ChatCompletionChunk,
  IProviderAdapter,
  ModelInventoryEntry,
  ModelInventoryEntrySchema,
  ModelUnavailableError,
  ProviderChatOptions,
  ProviderError,
  RateLimitError,
} from '@moderado/contracts';
import { parseSseStream } from './sse_parser.js';

export interface NvidiaAdapterConfig {
  apiKey?: string;
  baseUrl?: string;
  /** Provider identity for OpenAI-compatible services using this transport. */
  providerId?: string;
  providerName?: string;
}

export class NvidiaAdapter implements IProviderAdapter {
  public readonly id: string;
  public readonly name: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private cachedInventory: ModelInventoryEntry[] | null = null;
  private cacheTimestamp = 0;
  private readonly cacheTtlMs = 15 * 60 * 1000;

  constructor(config: NvidiaAdapterConfig = {}) {
    this.id = config.providerId || 'nvidia';
    this.name = config.providerName || 'NVIDIA NIM';
    this.apiKey = config.apiKey || process.env.NVIDIA_API_KEY || '';
    this.baseUrl = (config.baseUrl || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '');
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Connection: 'keep-alive',
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  async discoverModels(signal?: AbortSignal, forceRefresh = false): Promise<ModelInventoryEntry[]> {
    if (!forceRefresh && this.cachedInventory && Date.now() - this.cacheTimestamp < this.cacheTtlMs) {
      return this.cachedInventory;
    }

    const url = `${this.baseUrl}/models`;
    let response: Response;

    try {
      response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders(),
        signal,
      });
    } catch (err: any) {
      if (signal?.aborted) {
        throw new Error('Discovery request was aborted');
      }
      throw new ProviderError(`Network error while contacting ${url}: ${err.message}`, 'ERR_NETWORK_ERROR');
    }

    if (!response.ok) {
      await this.handleHttpError(response, 'discoverModels');
    }

    let json: any;
    try {
      json = await response.json();
    } catch (err: any) {
      throw new ProviderError(`Failed to parse models response: ${err.message}`, 'ERR_MALFORMED_RESPONSE');
    }

    const dataArray = Array.isArray(json) ? json : json.data;
    if (!Array.isArray(dataArray)) {
      throw new ProviderError("Expected array in models response ('data' field)", 'ERR_MALFORMED_RESPONSE');
    }

    const results: ModelInventoryEntry[] = [];
    for (const item of dataArray) {
      const parsed = ModelInventoryEntrySchema.safeParse(item);
      if (parsed.success) {
        results.push(parsed.data);
      }
    }

    this.cachedInventory = results;
    this.cacheTimestamp = Date.now();
    return results;
  }

  async *streamChat(options: ProviderChatOptions): AsyncIterable<ChatCompletionChunk> {
    const url = `${this.baseUrl}/chat/completions`;

    // Map contracts ChatMessage to OpenAI/NIM wire payload
    const wireMessages = options.messages.map((msg) => {
      if (msg.role === 'assistant') {
        const out: Record<string, unknown> = {
          role: 'assistant',
          content: msg.content ?? '',
        };
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          out.tool_calls = msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          }));
        }
        return out;
      }

      if (msg.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: msg.toolCallId,
          name: msg.name,
          content: msg.content,
        };
      }

      return {
        role: msg.role,
        content: msg.content,
      };
    });

    const payload: Record<string, unknown> = {
      model: options.modelId,
      messages: wireMessages,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (options.tools && options.tools.length > 0) {
      payload.tools = options.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    if (options.temperature !== undefined) {
      payload.temperature = options.temperature;
    }
    if (options.maxTokens !== undefined) {
      payload.max_tokens = options.maxTokens;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          ...this.getHeaders(),
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(payload),
        signal: options.signal,
      });
    } catch (err: any) {
      if (options.signal?.aborted) {
        throw new Error('Chat request was aborted');
      }
      throw new ProviderError(`Network error while contacting ${url}: ${err.message}`, 'ERR_NETWORK_ERROR');
    }

    if (!response.ok) {
      await this.handleHttpError(response, 'streamChat');
    }

    if (!response.body) {
      throw new ProviderError('Provider response has empty body', 'ERR_EMPTY_BODY');
    }

    // Node.js Response.body is a ReadableStream<Uint8Array> which is an AsyncIterable in modern Node
    yield* parseSseStream(response.body as any);
  }

  private async handleHttpError(response: Response, action: string): Promise<never> {
    let errorText = '';
    try {
      errorText = await response.text();
    } catch {
      // ignore
    }

    if (response.status === 401 || response.status === 403) {
      throw new AuthenticationError(
        `${this.name} authentication failed (${response.status}) during ${action}: ${errorText || 'Check the provider API key'}`
      );
    }

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('Retry-After');
      let retryAfterSeconds: number | undefined;
      if (retryAfterHeader) {
        const parsed = parseInt(retryAfterHeader, 10);
        if (!isNaN(parsed)) {
          retryAfterSeconds = parsed;
        }
      }
      let detail = errorText;
      try {
        const parsed = JSON.parse(errorText);
        if (parsed?.error?.message) {
          detail = parsed.error.message;
        }
      } catch {
        // raw errorText
      }
      throw new RateLimitError(
        `${this.name} rate limit exceeded (429) during ${action}: ${detail}`,
        retryAfterSeconds
      );
    }

    if (
      response.status === 404 ||
      response.status === 410 ||
      response.status === 503 ||
      response.status === 500 ||
      response.status === 502 ||
      response.status === 504
    ) {
      throw new ModelUnavailableError(
        `${this.name} service or model unavailable (${response.status}) during ${action}: ${errorText}`,
        response.status
      );
    }

    throw new ProviderError(
      `${this.name} request failed with status ${response.status} during ${action}: ${errorText}`,
      'ERR_HTTP_ERROR',
      response.status
    );
  }
}
