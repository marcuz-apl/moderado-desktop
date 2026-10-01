import { spawn } from 'node:child_process';
import {
  GitDiffParams,
  GitDiffParamsSchema,
  IToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from '@moderado/contracts';
import { resolveInJail } from '../jail.js';

const MAX_DIFF_BYTES = 100 * 1024; // 100KB limit

export const GitDiffTool: IToolDefinition<GitDiffParams> = {
  name: 'git_diff',
  description: 'Inspect uncommitted git changes or diff against a git reference.',
  requiresApproval: false,
  parametersSchema: GitDiffParamsSchema,

  async execute(params: GitDiffParams, context: ToolExecutionContext): Promise<ToolResult> {
    const cwd = resolveInJail(context.workspaceRoot, '.');

    const args = ['diff', '--no-ext-diff', '--no-color', '--no-textconv'];
    if (params.staged) {
      args.push('--staged');
    }
    if (params.targetRef) {
      args.push(params.targetRef);
    }
    if (params.filePaths && params.filePaths.length > 0) {
      args.push('--');
      for (const fp of params.filePaths) {
        // Validate each path doesn't escape workspace
        resolveInJail(context.workspaceRoot, fp);
        args.push(fp);
      }
    }

    return new Promise((resolve) => {
      let outputBuffer = '';
      let isTruncated = false;

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn('git', args, {
          cwd,
          shell: false,
          windowsHide: true,
        });
      } catch (err: any) {
        return resolve({
          toolName: 'git_diff',
          status: 'error',
          output: `Failed to execute git diff: ${err.message}`,
        });
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        if (outputBuffer.length + chunk.length > MAX_DIFF_BYTES) {
          const allowed = Math.max(0, MAX_DIFF_BYTES - outputBuffer.length);
          outputBuffer += chunk.toString('utf8', 0, allowed);
          isTruncated = true;
        } else {
          outputBuffer += chunk.toString('utf8');
        }
      });

      let stderrBuffer = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBuffer += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        resolve({
          toolName: 'git_diff',
          status: 'error',
          output: `Failed to spawn git process: ${err.message}`,
        });
      });

      child.on('close', (code) => {
        if (code !== 0) {
          return resolve({
            toolName: 'git_diff',
            status: 'error',
            output: `git diff failed (exit code ${code}): ${stderrBuffer.trim() || 'Unknown error'}`,
          });
        }

        let output = outputBuffer.trim();
        if (isTruncated) {
          output += '\n... [git diff output truncated at 100KB]';
        }
        if (!output) {
          output = '(No git diff changes detected)';
        }

        return resolve({
          toolName: 'git_diff',
          status: 'success',
          output,
          truncated: isTruncated,
        });
      });
    });
  },
};
