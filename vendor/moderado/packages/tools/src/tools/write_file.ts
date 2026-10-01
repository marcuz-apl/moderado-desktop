import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  IToolDefinition,
  ToolExecutionContext,
  ToolResult,
  WriteFileParams,
  WriteFileParamsSchema,
} from '@moderado/contracts';
import { resolveInJail } from '../jail.js';

export const WriteFileTool: IToolDefinition<WriteFileParams> = {
  name: 'write_file',
  description: 'Create a new file or completely replace an existing file atomically.',
  requiresApproval: true,
  parametersSchema: WriteFileParamsSchema,

  async execute(params: WriteFileParams, context: ToolExecutionContext): Promise<ToolResult> {
    const canonicalPath = resolveInJail(context.workspaceRoot, params.path);
    const parentDir = path.dirname(canonicalPath);

    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    const tmpFilename = `.tmp.moderado.${crypto.randomUUID()}`;
    const tmpPath = path.join(parentDir, tmpFilename);

    try {
      fs.writeFileSync(tmpPath, params.content, 'utf8');
      fs.renameSync(tmpPath, canonicalPath);
    } catch (err: any) {
      if (fs.existsSync(tmpPath)) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // ignore cleanup failure
        }
      }
      return {
        toolName: 'write_file',
        status: 'error',
        output: `Failed to write file '${params.path}': ${err.message}`,
      };
    }

    const lineCount = params.content.split(/\r?\n/).length;
    const byteLength = Buffer.byteLength(params.content, 'utf8');

    return {
      toolName: 'write_file',
      status: 'success',
      output: `Successfully wrote ${lineCount} lines (${byteLength} bytes) to '${params.path}'.`,
      metadata: {
        path: params.path,
        byteLength,
        lineCount,
      },
    };
  },
};
