import { AuthenticationError, ChatCompletionChunk, ChatUsageSchema, MalformedResponseError, ModelUnavailableError, ProviderError, RateLimitError, ToolCallChunk } from '@moderado/contracts';

export function classifyInjectedStreamError(raw: unknown): ProviderError {
  const error = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
  const code = error.code ?? error.status ?? error.type;
  const status = typeof code === 'number' ? code : typeof code === 'string' && /^\d{3}$/.test(code) ? Number(code) : undefined;
  const message = typeof error.message === 'string' ? error.message : typeof raw === 'string' ? raw : 'Provider reported a stream error';
  if (status === 401 || status === 403) return new AuthenticationError(message, status);
  if (status === 429 || /rate\s*limit|too many requests/i.test(message)) return new RateLimitError(message);
  if ((status !== undefined && status >= 500) || /overload|capacity|unavailable|temporar|busy|try again/i.test(message)) return new ModelUnavailableError(message, status ?? 503);
  if (/api[\s_-]?key|unauthor|forbidden|authentication/i.test(message)) return new AuthenticationError(message);
  return new ProviderError(message, 'ERR_STREAM_ERROR', status);
}

export async function* parseSseStream(
  byteStream: AsyncIterable<Uint8Array>
): AsyncIterable<ChatCompletionChunk> {
  const decoder = new TextDecoder('utf8');
  let buffer = '';

  for await (const chunk of byteStream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    // Keep incomplete last line in buffer
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) {
        // Empty line or SSE comment (heartbeat)
        continue;
      }

      if (trimmed.startsWith('data:')) {
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') {
          return;
        }

        let parsed: any;
        try {
          parsed = JSON.parse(dataStr);
        } catch {
          throw new MalformedResponseError('Provider sent an unparseable SSE data line');
        }

        if (parsed && typeof parsed === 'object' && parsed.error) {
          throw classifyInjectedStreamError(parsed.error);
        }

        const choice = parsed.choices?.[0];
        const delta = choice?.delta;
        const finishReason = choice?.finish_reason ?? null;

          const toolCallChunks: ToolCallChunk[] = [];
          if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              toolCallChunks.push({
                index: tc.index ?? 0,
                id: tc.id,
                name: tc.function?.name,
                argumentsDelta: tc.function?.arguments,
              });
            }
          }

          const completionChunk: ChatCompletionChunk = {};
          const reasoning = delta?.reasoning_content ?? delta?.thought;
          if (reasoning) {
            completionChunk.reasoningDelta = reasoning;
          }
          if (delta?.content && !reasoning) {
            completionChunk.contentDelta = delta.content;
          }
          if (toolCallChunks.length > 0) {
            completionChunk.toolCallChunks = toolCallChunks;
          }
          if (finishReason !== undefined) {
            completionChunk.finishReason = finishReason;
          }
          if (parsed.usage !== undefined && parsed.usage !== null) {
            const usage = ChatUsageSchema.safeParse({
              promptTokens: parsed.usage.prompt_tokens,
              completionTokens: parsed.usage.completion_tokens,
              totalTokens: parsed.usage.total_tokens === undefined
                ? parsed.usage.prompt_tokens + parsed.usage.completion_tokens
                : parsed.usage.total_tokens,
            });
            if (!usage.success) {
              throw new ProviderError('Invalid provider token usage: expected nonnegative integer prompt, completion, and total token counts', 'ERR_MALFORMED_RESPONSE');
            }
            completionChunk.usage = usage.data;
          }

          if (
            completionChunk.contentDelta !== undefined ||
            completionChunk.reasoningDelta !== undefined ||
            completionChunk.toolCallChunks !== undefined ||
            completionChunk.finishReason !== undefined ||
            completionChunk.usage !== undefined
          ) {
            yield completionChunk;
          }
      }
    }
  }
}
