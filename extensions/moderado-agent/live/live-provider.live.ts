import { describe, expect, it } from 'vitest';
import { FakeProviderAdapter, fetchOpenRouterFreeModels } from '@moderado/providers';
import { resolveProvider } from '../src/host.js';
import { WindowsCredentialStore, credentialManagerAvailable } from '../src/credentials.js';
import { readConfig } from '../src/profile.js';

/**
 * Opt-in live provider check. See vitest.live.config.ts.
 *
 * This contacts a real provider and costs a small amount of money. It is never
 * part of the default suite and must never run in CI: it is skipped entirely
 * when any CI variable is set, and skipped unless MODERADO_LIVE=1.
 *
 * It reads the real `~/.moderado` profile and the real Windows Credential
 * Manager, so it exercises the production resolution path end to end. The API
 * key is never logged, asserted on, or written anywhere: only the adapter's
 * behaviour is observed.
 */
const optedIn = process.env.MODERADO_LIVE === '1';
const inCi =
  !!process.env.CI ||
  !!process.env.GITHUB_ACTIONS ||
  !!process.env.BUILDKITE ||
  !!process.env.TF_BUILD;

describe.skipIf(inCi)('live provider (opt-in)', () => {
  it.skipIf(!optedIn)('resolves a real adapter and gets a real streamed reply', async () => {
    expect(credentialManagerAvailable()).toBe(true);

    const state = readConfig(undefined);
    expect(state.kind).toBe('ok');

    const { adapter, reason } = await resolveProvider(state, new WindowsCredentialStore());
    if (adapter instanceof FakeProviderAdapter) {
      throw new Error(`Fell back to the fake provider: ${reason}`);
    }

    // Compare both discovery paths: the adapter's generic one, and OpenRouter's
    // dedicated catalog fetch. Reporting both makes a regression diagnosable.
    const generic = await adapter.discoverModels();
    const openrouter = await fetchOpenRouterFreeModels();
    console.log(
      `[live] adapter=${adapter.id} adapterModels=${generic.length} openrouterFreeModels=${openrouter.length}`,
    );

    // Prefer a free model: it matches the product's free-first policy, and an
    // arbitrary entry from the full catalog may not support chat at all.
    const free =
      openrouter.length > 0
        ? openrouter
        : generic.filter((m) => !m.pricing || m.pricing.prompt === '0');
    const source = free.length > 0 ? free : generic;
    expect(source.length).toBeGreaterThan(0);
    const modelId = source[0].id;
    console.log(`[live] using modelId=${modelId}`);

    // A cheap, deterministic prompt. No tool call and no file access, so this can
    // never mutate the workspace or trigger an approval.
    const stream = adapter.streamChat({
      modelId,
      messages: [{ role: 'user', content: 'Reply with exactly one word: ok' }],
      maxTokens: 16,
    });

    let reply = '';
    let chunkCount = 0;
    for await (const chunk of stream) {
      chunkCount++;
      // ChatCompletionChunkSchema names the text field `contentDelta`.
      const delta = (chunk as { contentDelta?: string }).contentDelta;
      if (delta) reply += delta;
    }

    // The reply itself is never printed; its presence is the evidence.
    expect(chunkCount).toBeGreaterThan(0);
    expect(reply.trim().length).toBeGreaterThan(0);
    console.log(`[live] PASS modelId=${modelId} chunks=${chunkCount} replyChars=${reply.trim().length}`);
  });
});
