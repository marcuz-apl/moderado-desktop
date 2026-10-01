import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ApplyPatchParams, ApplyPatchParamsSchema, IToolDefinition, ToolExecutionContext, ToolResult } from '@moderado/contracts';
import { generateDiffPreview } from '../diff.js';
import { resolveInJail } from '../jail.js';

export const ApplyPatchTool: IToolDefinition<ApplyPatchParams> = {
  name: 'apply_patch', description: 'Apply validated exact edits to multiple workspace files.', requiresApproval: true, parametersSchema: ApplyPatchParamsSchema,
  async preview(params, context) {
    return params.edits.map((edit) => {
      const original = fs.readFileSync(resolveInJail(context.workspaceRoot, edit.path), 'utf8');
      return generateDiffPreview(edit.path, original, edit.targetContent, edit.replacementContent).diffPreview;
    }).join('\n');
  },
  async execute(params: ApplyPatchParams, context: ToolExecutionContext): Promise<ToolResult> {
    const staged: { absolute: string; temp: string; original: Buffer; diff: string }[] = [];
    try {
      const paths = params.edits.map((edit) => resolveInJail(context.workspaceRoot, edit.path));
      if (new Set(paths).size !== paths.length) throw new Error('Patch edits must target unique files.');
      for (let index = 0; index < params.edits.length; index++) {
        const edit = params.edits[index];
        const absolute = paths[index];
        const original = fs.readFileSync(absolute);
        const result = generateDiffPreview(edit.path, original.toString('utf8'), edit.targetContent, edit.replacementContent);
        const temp = path.join(path.dirname(absolute), `.tmp.moderado.${crypto.randomUUID()}`);
        fs.writeFileSync(temp, result.newContent, 'utf8');
        staged.push({ absolute, temp, original, diff: result.diffPreview });
      }
      for (const item of staged) fs.renameSync(item.temp, item.absolute);
      const preview = staged.map((item) => item.diff).join('\n');
      return { toolName: 'apply_patch', status: 'success', output: preview, metadata: { diffPreview: preview } };
    } catch (err: any) {
      for (const item of staged) {
        try {
          if (fs.existsSync(item.temp)) fs.unlinkSync(item.temp);
          else if (fs.existsSync(item.absolute)) fs.writeFileSync(item.absolute, item.original);
        } catch { /* preserve the original error */ }
      }
      return { toolName: 'apply_patch', status: 'error', output: err.message };
    }
  },
};