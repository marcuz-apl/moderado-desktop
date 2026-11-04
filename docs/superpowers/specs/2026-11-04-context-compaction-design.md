# Context Compaction Design

## Intent

Long-running sessions eventually exceed the model's context window, and today the provider rejects the next request with a context-length error. Moderado Desktop must detect a near-full context before that request and compact the stored history automatically, so a session keeps working without the user starting over.

Compaction is transparent: the user sees a status line and a summary card in the transcript, and the session continues with the same model and tools.

## Scope

In scope:

- Detect a near-full context from exact provider usage and a conservative pre-turn estimate.
- Compact at a safe user-message boundary by summarizing older turns with the session model, keeping the most recent 4 user turns verbatim whenever summarization runs.
- Fall back to trimming oversized tool output when summarization fails or there is nothing old enough to summarize.
- Emit a `compacted` turn event and render the result in the transcript and the usage line.
- Offline tests for detection, boundary selection, digest budgeting, the summarizer round trip, trimming, and rendering.

Out of scope:

- Gateway changes. `/v1/models` on the gateway does not advertise `context_length` today, so the desktop uses its safe fallback window for gateway models until a separate gateway change exposes the field. The parser already accepts the field, so that gateway change needs no desktop change.
- Per-session context-window overrides, manual "compact now" controls, and summarizer model selection.
- Any change to the `sessions` schema. History stays a JSON array in `sessions.history_json`.

## Detection

Every provider call already reports exact usage; `runner.rs` forwards `usage.input_tokens` as `ModelUsage.context_tokens`.

The window comes from the model catalog:

| Source | Value |
| --- | --- |
| `/v1/models` entry `context_length` | Used when it is an integer in `1_024..=10_000_000` |
| Anything else (missing, zero, absurd) | `DEFAULT_CONTEXT_WINDOW = 32_768` |

`ModelInfo` gains `context_length: Option<u64>` (serialized `contextLength`); `parse_model_info` reads the field and discards values outside the accepted range.

`lib.rs` resolves the window before each turn and caches it in `AppState`:

```rust
model_windows: Mutex<HashMap<String, CachedWindow>>, // key: "{base_url}\u{1}{model}"
struct CachedWindow { tokens: u64, fetched_at: Instant }
```

The cache entry lives 10 minutes. A cache miss calls `provider::list_model_catalog` with the session key; a lookup failure or an unknown model resolves to the default and is not cached. A pure helper `provider::context_window_for(models, model)` performs the lookup so it is unit-testable.

The resolved window is passed into the run as `RunConfig.context_window: u64`, and copied into every emitted `ModelUsage` as `context_window: Option<u64>` so the UI can show the ratio.

A context is near full when:

```rust
pub fn should_compact(tokens: u64, window: u64) -> bool {
    tokens.saturating_mul(100) >= window.saturating_mul(COMPACT_PERCENT) // COMPACT_PERCENT = 80
}
```

The check runs at the top of every tool round, before the request is built:

```text
tokens = max(last_call_input_tokens, estimate_tokens(history, overhead_chars))
```

- `last_call_input_tokens` is the exact `usage.input_tokens` of the most recent successful call in this turn, reset to `None` after a compaction.
- `estimate_tokens` approximates `(serialized_history_chars + overhead_chars) / 3`; the divisor of 3 deliberately overestimates for code and JSON so compaction happens early rather than after a provider error. `overhead_chars` is the serialized system prompt plus tool definitions for this turn. Attachment references count as their small JSON form, not as expanded images; exact usage after the first call corrects that.

Compaction runs at most 3 times per turn. After a rewrite it persists, clears `last_call_input_tokens`, emits `AgentEvent::Compacted`, and proceeds with the next request. When it produces no change, the turn proceeds and any provider context error is surfaced as a turn error — never swallowed.

## Compaction algorithm

A user turn is one `user` message plus every following message up to the next `user` message. Keeping whole turns preserves `assistant.tool_calls` / `tool` pairing, because a `tool` message can never precede its `assistant` message inside a turn.

```text
user_indices = positions of role == "user" in history
if user_indices.len() >= 5:
    start = user_indices[user_indices.len() - 4]   # the first kept user turn
    region = history[0..start]
else:
    start = user_indices[user_indices.len() - 2]   # or 0 with fewer than 2 user turns
    region = history[0..start]
```

Two paths:

1. **Summarize** when at least one whole user turn can be removed (`user_indices.len() >= 5`).
   - Build a digest of `region` and call the session model with no tools.
   - On success, replace `history[0..start]` with one assistant message and persist.
   - On an empty summary, a provider error, or any transport failure, go to path 2.

2. **Trim** when summarization is unavailable or there is nothing old enough to summarize.
   - In `region` only, cap `tool` content at 800 chars, assistant content at 400 chars, and user content at 1_500 chars, appending `\n\n[trimmed]`.
   - Keep the trimmed messages in place and insert a short assistant notice at `start`, so the model knows earlier output was shortened.
   - If no message changed, report no compaction and continue.

The notice and the summary use the same recognizable marker:

```json
{"role": "assistant", "content": "## Context summary\n\n<summary or notice>"}
```

Empty history, a lone user message, or 1–2 user turns with small output therefore never trigger a provider call. When the very first message of a session is itself larger than the window, no older region exists to compact; the provider error is surfaced to the user.

### Summary request

```text
system: You compress conversation history for a coding assistant. Preserve decisions,
        user preferences, file paths, commands, errors, and unfinished work. Reply with
        under 300 words of Markdown bullets. Do not invent facts. Omit greetings and small talk.
user:   Earlier conversation:
        <digest>
tools:  none
```

Streamed text from the summarizer is discarded; it must not reach `AgentEvent::Text`. `max_tokens` is not part of the provider contract, so the length limit is an instruction only.

### Digest

The digest is built from stored messages, not from `attachments::expand_history`, so image payloads are never sent to the summarizer. Tool messages are labeled with the tool name looked up from the preceding `assistant.tool_calls` by `tool_call_id`.

Allocation, in this order:

1. The first user message in the region, capped at 4_000 chars. This carries the original task.
2. The remaining messages in order, each capped at: user 2_000, assistant 2_000, tool 800.
3. The loop stops when fewer than 200 chars of budget remain.

Char budget: `min(24_000, window * 2)`.

When messages are dropped for budget, append:

```text
[<n> earlier messages omitted to fit the summarizer budget.]
```

Each block is prefixed with `[user]`, `[assistant]`, or `[tool:<name>]`, and truncated text ends with `…`.

## Events and UI

Rust:

```rust
AgentEvent::Compacted { removed: usize, summarized: bool }
TurnEvent::Compacted { session_id: String, removed: usize, summarized: bool } // kind: "compacted"
```

`lib.rs` maps the agent event to the turn event the same way it maps the other four variants. `removed` counts messages the compaction eliminated (the summarized region) or shortened (trim path).

Renderer:

- `TurnEvent` gains `'compacted'` plus `removed?: number; summarized?: boolean`.
- On `compacted`, `setStatus` shows `Context compacted — earlier turns summarized.` or `Context compacted — earlier output trimmed.` No transcript bubble is added mid-turn; the existing `done` handler already calls `refreshSession(id, true)`, which re-renders from the persisted history.
- `historyToView` checks an assistant message whose trimmed content starts with `## Context summary` (case-insensitive heading) before the `splitTurnSummary` path, and renders one `{ role: 'Context summary', content: body }` message with the heading removed.
- `messageElement` renders `Context summary` as a muted card using existing surface and border tokens, styled in both light and dark themes by inheritance from the theme variables.
- `renderModelUsage` appends the window when `usage.contextWindow` is present: `Context: 24,103 / 32,768`. With no window it keeps `Context: —`.

The pure classification lives in a new `src/renderer/context-summary.ts`:

```ts
export function parseContextSummary(content: string): string | null; // body, or null
```

`main.ts` imports it, matching the `appearance.ts` / `models.ts` pattern that Node tests already exercise.

## Failure and persistence

- Compaction is persisted through the existing `persist` hook, which saves `history_json` for the session. A persist failure fails the turn with an existing-style error.
- A summarizer failure never loses history by itself: the fallback keeps every message and only shortens oversized content.
- Compaction never mutates messages after `start`; the recent 4 user turns and the current in-flight round are untouched.
- Cancelling a turn while the summarizer call runs simply drops the future; the next turn re-evaluates from stored history.

## Files

| File | Change |
| --- | --- |
| `src-tauri/src/agent/context.rs` | New: constants, `should_compact`, `estimate_tokens`, `plan`, `digest`, `summary_message`, `trim_region`; unit tests |
| `src-tauri/src/agent.rs` | `pub mod context;` |
| `src-tauri/src/agent/runner.rs` | `RunConfig.context_window`; per-round compaction hook; `AgentEvent::Compacted`; `ModelUsage.context_window`; mock-server tests |
| `src-tauri/src/provider.rs` | `ModelInfo.context_length`; `parse_model_info` reads `context_length`; `context_window_for`; parse tests |
| `src-tauri/src/lib.rs` | `AppState.model_windows` cache; per-turn window resolution; `TurnEvent::Compacted` mapping; `RunConfig` construction |
| `src/renderer/context-summary.ts` | New: `parseContextSummary` |
| `src/renderer/main.ts` | `TurnEvent` compaction kind; compacted status; `historyToView` card; usage line window |
| `src/renderer/style.css` | `.message.context-summary` card |
| `tests/context-summary.test.mjs` | New: parser tests |

## Tests (all offline)

Rust, `context.rs`:

1. `should_compact` is false below 80%, true at exactly 80% and above.
2. With 6 user turns, the plan keeps the last 4 and starts at the 3rd user message; no `tool` message sits in the removed region without its assistant.
3. With 4 user turns, `plan` returns no summarizable region and trimming touches only messages older than the last 2 user turns.
4. The digest always includes the first user message, applies the per-role caps, and appends the omission note when the budget truncates.
5. `summary_message` starts with the `## Context summary` marker; the trim notice does too.
6. Trimming caps tool, assistant, and user content; a message below its cap is unchanged.

Rust, `runner.rs` with the existing mock TCP provider:

7. A preloaded history whose estimate exceeds the threshold and a summarizer endpoint that returns a summary produce: a first request without tools, a second request containing exactly one summary message and the recent turns, one `Compacted { summarized: true }` event, and persisted history starting with the summary message.
8. A summarizer endpoint that returns HTTP 500 yields `Compacted { summarized: false }`, shortened tool output, and the turn still completes successfully.
9. A turn whose history is small makes one provider request and emits no `Compacted` event.
10. At most 3 compaction attempts happen in one turn.

Rust, `provider.rs`:

11. `context_length` is parsed into `ModelInfo` and serialized as `contextLength`; `0`, `-1`, and `20_000_000` are dropped.
12. `context_window_for` finds the model by id and returns the default for a missing model or an out-of-range value.

Node:

13. `parseContextSummary` strips the heading and returns the body; normal assistant text, a `## Turn summary` heading, and empty content return `null`; leading whitespace and mixed case still match.

## Verification

- `npm test` (cargo tests plus Node tests) offline.
- `npm run lint` (eslint, `tsc --noEmit`, clippy with `-D warnings`).
- `npm run build`, then the release exe rebuilt and its path reported, per the local-build rule.
