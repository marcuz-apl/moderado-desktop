import { describe, expect, it, vi } from 'vitest';
import { ApprovalRequest } from '@moderado/contracts';
import { ApprovalCoordinator, hasCompletePreview } from '../src/approval.js';

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    requestId: 'req-1',
    toolName: 'write_file',
    actionSummary: 'Create notes.md',
    exactPayload: { targetFile: 'notes.md', contentPreview: 'hello' },
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('hasCompletePreview', () => {
  it('requires a target file and content for a write', () => {
    expect(hasCompletePreview(request())).toBe(true);
    expect(hasCompletePreview(request({ exactPayload: { contentPreview: 'x' } }))).toBe(false);
    expect(hasCompletePreview(request({ exactPayload: { targetFile: 'a.md' } }))).toBe(false);
  });

  it('requires a command array and cwd to run a command', () => {
    expect(
      hasCompletePreview(
        request({ toolName: 'run_command', exactPayload: { command: ['npm', 'test'], cwd: 'C:\\ws' } }),
      ),
    ).toBe(true);
    expect(hasCompletePreview(request({ toolName: 'run_command', exactPayload: { command: ['npm', 'test'] } }))).toBe(false);
    expect(hasCompletePreview(request({ toolName: 'run_command', exactPayload: { cwd: 'C:\\ws' } }))).toBe(false);
  });
});

describe('ApprovalCoordinator', () => {
  it('approves when a human approves the exact request', async () => {
    const coordinator = new ApprovalCoordinator({
      prompt: async (req) => ({ requestId: req.requestId, status: 'approved' }),
    });
    const decision = await coordinator.requestApproval(request());
    expect(decision.status).toBe('approved');
    expect(decision.requestId).toBe('req-1');
  });

  it('denies when the decision id does not match the request', async () => {
    const coordinator = new ApprovalCoordinator({
      prompt: async () => ({ requestId: 'some-other-request', status: 'approved' }),
    });
    const decision = await coordinator.requestApproval(request());
    expect(decision.status).toBe('denied');
    expect(decision.reason).toMatch(/did not match/i);
  });

  it('denies a malformed decision', async () => {
    const coordinator = new ApprovalCoordinator({
      prompt: async () => ({ requestId: 'req-1', status: 'maybe' }),
    });
    const decision = await coordinator.requestApproval(request());
    expect(decision.status).toBe('denied');
  });

  it('denies when the UI closes without a decision', async () => {
    const coordinator = new ApprovalCoordinator({ prompt: async () => undefined });
    const decision = await coordinator.requestApproval(request());
    expect(decision.status).toBe('denied');
    expect(decision.reason).toMatch(/closed/i);
  });

  it('denies on the host deadline', async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new ApprovalCoordinator({
        prompt: () => new Promise(() => {}),
        timeoutMs: 1_000,
      });
      const pending = coordinator.requestApproval(request());
      await vi.advanceTimersByTimeAsync(1_100);
      const decision = await pending;
      expect(decision.status).toBe('denied');
      expect(decision.reason).toMatch(/deadline/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('denies on cancellation', async () => {
    const controller = new AbortController();
    const coordinator = new ApprovalCoordinator({ prompt: () => new Promise(() => {}) });
    const pending = coordinator.requestApproval(request(), controller.signal);
    controller.abort();
    expect((await pending).status).toBe('denied');
  });

  it('denies everything in a non-interactive context', async () => {
    const prompt = vi.fn();
    const coordinator = new ApprovalCoordinator({ prompt, nonInteractive: true });
    const decision = await coordinator.requestApproval(request());
    expect(decision.status).toBe('denied');
    expect(prompt).not.toHaveBeenCalled();
  });

  it('denies a write that carries no complete preview', async () => {
    const coordinator = new ApprovalCoordinator({
      prompt: async (req) => ({ requestId: req.requestId, status: 'approved' }),
    });
    const decision = await coordinator.requestApproval(request({ exactPayload: { targetFile: 'a.md' } }));
    expect(decision.status).toBe('denied');
    expect(decision.reason).toMatch(/complete preview/i);
  });

  it('denies in-flight requests when the view is disposed', async () => {
    const coordinator = new ApprovalCoordinator({ prompt: () => new Promise(() => {}) });
    const pending = coordinator.requestApproval(request());
    expect(coordinator.pendingCount).toBe(1);
    coordinator.denyAll('ui_closed');
    expect((await pending).status).toBe('denied');
    expect(coordinator.pendingCount).toBe(0);
  });

  it('rejects a malformed approval request outright', async () => {
    const coordinator = new ApprovalCoordinator({ prompt: async () => ({ requestId: 'req-1', status: 'approved' }) });
    const decision = await coordinator.requestApproval({ requestId: '' } as ApprovalRequest);
    expect(decision.status).toBe('denied');
  });
});