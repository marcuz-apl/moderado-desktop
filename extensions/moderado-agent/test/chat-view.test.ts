import { describe, expect, it } from 'vitest';
import type { ApprovalRequest } from '@moderado/contracts';
import { chatHtml, escapeHtml, viewSnapshot, ChatViewState } from '../src/chat-view.js';

const preview = () => 'preview';

function state(over: Partial<ChatViewState> = {}): ChatViewState {
  return { transcript: [], running: false, pendingApproval: null, ...over };
}

describe('chat view', () => {
  it('renders a composer input so there is somewhere to type', () => {
    const html = chatHtml(state(), preview);
    expect(html).toContain('id="prompt"');
    expect(html).toContain('id="composer"');
    expect(html).toContain('id="send"');
  });

  it('keeps the input out of the document only once', () => {
    // The regression: the panel used to be re-rendered per streamed token by
    // reassigning webview.html, which rebuilt the document, discarded the
    // composer's contents, and stole focus. Updates must be a separate message.
    const html = chatHtml(state(), preview);
    const occurrences = html.split('id="prompt"').length - 1;
    expect(occurrences).toBe(1);
  });

  it('applies later state as an in-place update, not a new document', () => {
    const html = chatHtml(state(), preview);
    // The update path must mutate the existing DOM nodes only.
    expect(html).toContain("update.type !== 'update'");
    expect(html).toContain('transcript.innerHTML = update.rows');
    expect(html).toContain('input.disabled = update.running');
  });

  it('authorises scripts with a per-render nonce', () => {
    const html = chatHtml(state(), preview);
    const csp = /script-src 'nonce-([A-Za-z0-9]+)'/.exec(html);
    expect(csp).not.toBeNull();
    expect(csp?.[1]?.length).toBeGreaterThanOrEqual(16);
    // The script tag must carry the same nonce the policy advertises.
    expect(html).toContain(`<script nonce="${csp?.[1]}">`);
    // 'unsafe-inline' would let any injected inline script run.
    expect(html).not.toContain("script-src 'unsafe-inline'");
  });

  it('escapes untrusted transcript text', () => {
    const html = chatHtml(
      state({ transcript: [{ kind: 'assistant', label: 'x', text: '<img src=x onerror=alert(1)>' }] }),
      preview,
    );
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('produces a snapshot whose approval block is empty when nothing is pending', () => {
    const snap = viewSnapshot(state(), preview);
    expect(snap.approval).toBe('');
    expect(snap.pendingId).toBeNull();
    expect(snap.running).toBe(false);
  });

  it('carries the pending request id so only that request can be answered', () => {
    const pending = { requestId: 'req-1', actionSummary: 'write a file' } as unknown as ApprovalRequest;
    const snap = viewSnapshot(state({ pendingApproval: pending }), preview);
    expect(snap.pendingId).toBe('req-1');
    expect(snap.approval).toContain('Allow');
    expect(snap.approval).toContain('Deny');
  });

  it('escapes approval previews, which contain file paths and diffs', () => {
    const pending = { requestId: 'r', actionSummary: '<b>x</b>' } as unknown as ApprovalRequest;
    const snap = viewSnapshot(state({ pendingApproval: pending }), () => '<script>bad</script>');
    expect(snap.approval).not.toContain('<script>');
    expect(escapeHtml('<b>')).toBe('&lt;b&gt;');
  });
});