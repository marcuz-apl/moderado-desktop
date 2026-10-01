import * as vscode from 'vscode';
import { AgentEvent, ApprovalRequest } from '@moderado/contracts';
import { AgentHost } from './host.js';
import { RawDecision } from './approval.js';

/**
 * Extension entry point.
 *
 * The renderer boundary is deliberately thin: the webview may post a prompt or
 * an approval answer and nothing else. It never receives provider credentials
 * and cannot grant its own tool permissions.
 */
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Moderado');
  context.subscriptions.push(output);

  const config = () => vscode.workspace.getConfiguration('moderado');
  const pendingApprovals = new Map<string, (raw: RawDecision | undefined) => void>();

  const host = new AgentHost({
    workspaceRoot: process.cwd(),
    nonInteractive: false,
    approvalTimeoutMs: config().get<number>('approvalTimeoutSeconds', 120) * 1000,
    allowPaid: config().get<boolean>('allowPaidModels', false),
    allowUnknown: config().get<boolean>('allowUnknownModels', false),
    onEvent: (event: AgentEvent) => {
      output.appendLine(`[${event.type}] ${JSON.stringify(event, redactKey)}`);
    },
    promptForApproval: (request, signal) => askHuman(request, signal),
  });

  context.subscriptions.push({ dispose: () => host.dispose() });

  /** Asks through a modal dialog so the decision is unambiguous and keyboard-reachable. */
  async function askHuman(request: ApprovalRequest, signal: AbortSignal): Promise<RawDecision | undefined> {
    const label = `Allow ${request.toolName}: ${request.actionSummary}`;
    const file = request.exactPayload.targetFile;
    const command = request.exactPayload.command;
    const detailParts = [
      file ? `Target: ${file}` : undefined,
      command?.length ? `Command: ${command.join(' ')}` : undefined,
      request.exactPayload.cwd ? `Working directory: ${request.exactPayload.cwd}` : undefined,
      request.exactPayload.diffPreview ? 'A diff preview is shown in the Moderado view.' : undefined,
    ].filter(Boolean) as string[];

    const choice = await Promise.race([
      vscode.window.showInformationMessage(label, { modal: true, detail: detailParts.join('\n') }, 'Allow', 'Deny'),
      new Promise<undefined>((resolve) => signal.addEventListener('abort', () => resolve(undefined), { once: true })),
    ]);

    // The view was closed or dismissed without choosing.
    if (choice !== 'Allow') return { requestId: request.requestId, status: 'denied', reason: 'Deny' };
    return { requestId: request.requestId, status: 'approved' };
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('moderado.openChat', async () => {
      const task = await vscode.window.showInputBox({ prompt: 'Ask Moderado' });
      if (!task) return;
      try {
        const result = await host.startRun({ task });
        output.appendLine(`Run ${result.status} on ${result.model} in ${result.totalSteps} steps.`);
        if (result.finalMessage) await vscode.window.showInformationMessage(result.finalMessage);
      } catch (error) {
        vscode.window.showErrorMessage(`Moderado run failed: ${(error as Error).message}`);
      }
    }),
    vscode.commands.registerCommand('moderado.cancelRun', () => {
      host.cancel();
      vscode.window.showInformationMessage('Moderado run cancelled.');
    }),
    vscode.commands.registerCommand('moderado.togglePlanMode', async () => {
      const enabled = await vscode.window.showQuickPick(['Plan mode: on', 'Plan mode: off'], { canPickMany: false });
      output.appendLine(`Selected ${enabled ?? 'nothing'}`);
    }),
    vscode.commands.registerCommand('moderado.selectModel', async () => {
      vscode.window.showInformationMessage('Model selection arrives with provider configuration.');
    }),
    vscode.commands.registerCommand('moderado.configureProvider', async () => {
      vscode.window.showInformationMessage('Provider configuration arrives with the profile work.');
    }),
  );

  // Approvals raised outside the dialog path (e.g. from a webview) resolve here.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('moderado.chat', {
      async deserializeWebviewPanel(panel) {
        panel.webview.onDidReceiveMessage(async (message) => {
          if (message?.type !== 'approvalDecision') return;
          const settle = pendingApprovals.get(message.requestId);
          if (!settle) return;
          pendingApprovals.delete(message.requestId);
          settle(message.decision);
        });
      },
    }),
  );

  /**
 * JSON replacer that drops credential-bearing keys before anything is logged or
 * sent to a renderer. Provider secrets must never leave the extension host.
 */
const SECRET_KEYS = new Set(['apiKey', 'credential', 'authorization', 'token', 'api_key']);

function redactKey(key: string, value: unknown): unknown {
  return SECRET_KEYS.has(key) ? '[redacted]' : value;
}
}

export function deactivate(): void {
  // Host disposal is registered as a subscription in activate().
}