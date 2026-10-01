import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentEvent, ApprovalRequest } from '@moderado/contracts';
import { resolveInJail } from '@moderado/tools';
import { AgentHost, previewFor } from '../src/host.js';

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'moderado-m2-'));
}

function collector() {
  const events: AgentEvent[] = [];
  return { events, onEvent: (event: AgentEvent) => events.push(event) };
}

describe('previewFor', () => {
  it('canonicalizes the target path inside the workspace jail', () => {
    const root = workspace();
    const preview = previewFor('write_file', { path: 'notes.md', content: 'hi' }, root) as Record<string, unknown>;
    expect(String(preview.targetFile).toLowerCase()).toContain('notes.md');
    expect(preview.contentPreview).toBe('hi');
  });

  it('rejects a path that escapes the workspace', () => {
    const root = workspace();
    expect(() => previewFor('write_file', { path: '..\\..\\evil.txt', content: 'x' }, root)).toThrow();
  });

  it('includes the command array and cwd for run_command', () => {
    const root = workspace();
    const preview = previewFor('run_command', { command: ['npm', 'test'] }, root) as Record<string, unknown>;
    expect(preview.command).toEqual(['npm', 'test']);
    expect(preview.cwd).toBe(root);
  });
});

describe('workspace jail', () => {
  it('refuses a traversal out of the workspace', () => {
    const root = workspace();
describe('AgentHost approvals', () => {
  it('never writes a file when the human denies', async () => {
    const root = workspace();
    const target = join(root, 'denied.md');
    const host = new AgentHost({
      workspaceRoot: root,
      onEvent: () => {},
      promptForApproval: async (request: ApprovalRequest) => ({ requestId: request.requestId, status: 'denied' }),
    });

    const decision = await host.requestApproval({
      requestId: 'r-deny',
      toolName: 'write_file',
      actionSummary: 'Create denied.md',
      exactPayload: { targetFile: target, contentPreview: 'should not be written' },
      timestamp: Date.now(),
    });

    expect(decision.status).toBe('denied');
    expect(existsSync(target)).toBe(false);
  });

  it('does not write when no decision arrives before the deadline', async () => {
    const root = workspace();
    const host = new AgentHost({
      workspaceRoot: root,
      onEvent: () => {},
      approvalTimeoutMs: 20,
      promptForApproval: () => new Promise(() => {}),
    });

    const decision = await host.requestApproval({
      requestId: 'r-timeout',
      toolName: 'write_file',
      actionSummary: 'Create slow.md',
      exactPayload: { targetFile: join(root, 'slow.md'), contentPreview: 'x' },
      timestamp: Date.now(),
    });

    expect(decision.status).toBe('denied');
    expect(existsSync(join(root, 'slow.md'))).toBe(false);
  });

  it('denies when the decision id does not match', async () => {
    const host = new AgentHost({
      workspaceRoot: workspace(),
      onEvent: () => {},
      promptForApproval: async () => ({ requestId: 'someone-elses-request', status: 'approved' }),
    });

    const decision = await host.requestApproval({
      requestId: 'r-mismatch',
      toolName: 'write_file',
      actionSummary: 'Create x.md',
      exactPayload: { targetFile: join(workspace(), 'x.md'), contentPreview: 'x' },
      timestamp: Date.now(),
    });

    expect(decision.status).toBe('denied');
  });

  it('denies everything in a non-interactive host', async () => {
    const host = new AgentHost({
      workspaceRoot: workspace(),
      onEvent: () => {},
      nonInteractive: true,
      promptForApproval: async () => ({ requestId: 'r', status: 'approved' }),
    });

    const decision = await host.requestApproval({
      requestId: 'r-noninteractive',
      toolName: 'run_command',
      actionSummary: 'npm test',
      exactPayload: { command: ['npm', 'test'], cwd: 'C:\\ws' },
      timestamp: Date.now(),
    });

    expect(decision.status).toBe('denied');
  });

  it('cancels and denies in-flight approvals', async () => {
    const host = new AgentHost({
      workspaceRoot: workspace(),
      onEvent: () => {},
      promptForApproval: () => new Promise(() => {}),
    });

    const pending = host.requestApproval({
      requestId: 'r-cancel',
      toolName: 'run_command',
      actionSummary: 'npm test',
      exactPayload: { command: ['npm', 'test'], cwd: 'C:\\ws' },
      timestamp: Date.now(),
    });

    host.cancel('User cancelled.');
    expect((await pending).status).toBe('denied');
  });
});

describe('AgentHost run', () => {
  it('completes a bounded turn against the vendored core with a fake provider', async () => {
    const { events, onEvent } = collector();
    const host = new AgentHost({ workspaceRoot: workspace(), onEvent, promptForApproval: async () => undefined });

    const result = await host.startRun({ task: 'Say hello.' });

    expect(['completed', 'step_limit_reached']).toContain(result.status);
    expect(result.model).toBeTruthy();
    expect(events.some((event) => event.type === 'completion')).toBe(true);
  }, 20_000);

  it('routes free-first by default and does not select a paid model', async () => {
    const host = new AgentHost({
      workspaceRoot: workspace(),
      onEvent: () => {},
      promptForApproval: async () => undefined,
    });
    const result = await host.startRun({ task: 'Inspect the workspace.' });
    expect(result.model).not.toBe('mock/paid-tool-model');
    expect(result.model).toBe('mock/free-tool-model');
  }, 20_000);
});
    expect(() => resolveInJail(root, '..\\..\\Windows\\System32\\drivers\\etc\\hosts')).toThrow();
  });

  it('still allows reading a file inside the workspace', () => {
    const root = workspace();
    const secret = join(root, 'secret.txt');
    writeFileSync(secret, 'top-secret');
    expect(readFileSync(resolveInJail(root, 'secret.txt'), 'utf8')).toBe('top-secret');
  });
});