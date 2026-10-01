import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  EditFileParams,
  EditFileParamsSchema,
  IToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from '@moderado/contracts';
import { resolveInJail } from '../jail.js';
import { generateDiffPreview } from '../diff.js';

export const EditFileTool: IToolDefinition<EditFileParams> = {
  name: 'edit_file',
  description: 'Replace an exact, unique target code snippet in a file with new content.',
  requiresApproval: true,
  parametersSchema: EditFileParamsSchema,
  async preview(params, context) {
    const file = resolveInJail(context.workspaceRoot, params.path);
    return generateDiffPreview(params.path, fs.readFileSync(file, 'utf8'), params.targetContent, params.replacementContent).diffPreview;
  },

  async execute(params: EditFileParams, context: ToolExecutionContext): Promise<ToolResult> {
    const canonicalPath = resolveInJail(context.workspaceRoot, params.path);

    if (!fs.existsSync(canonicalPath)) {
      return {
        toolName: 'edit_file',
        status: 'error',
        output: `Error: File '${params.path}' does not exist.`,
      };
    }

    const originalContent = fs.readFileSync(canonicalPath, 'utf8');

    let replacementResult;
    try {
      replacementResult = generateDiffPreview(
        params.path,
        originalContent,
        params.targetContent,
        params.replacementContent
      );
    } catch (err: any) {
      return {
        toolName: 'edit_file',
        status: 'error',
        output: err.message,
      };
    }

    const parentDir = path.dirname(canonicalPath);
    const tmpFilename = `.tmp.moderado.${crypto.randomUUID()}`;
    const tmpPath = path.join(parentDir, tmpFilename);

    try {
      fs.writeFileSync(tmpPath, replacementResult.newContent, 'utf8');
      fs.renameSync(tmpPath, canonicalPath);
    } catch (err: any) {
      if (fs.existsSync(tmpPath)) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // ignore
        }
      }
      return {
        toolName: 'edit_file',
        status: 'error',
        output: `Failed to save edits to '${params.path}': ${err.message}`,
      };
    }

    return {
      toolName: 'edit_file',
      status: 'success',
      output: `Successfully edited '${params.path}' at line ${replacementResult.matchedLine}:\n\n${replacementResult.diffPreview}`,
      metadata: {
        path: params.path,
        diffPreview: replacementResult.diffPreview,
        matchedLine: replacementResult.matchedLine,
      },
    };
  },
};
