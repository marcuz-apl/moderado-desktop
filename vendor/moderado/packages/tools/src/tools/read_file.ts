import fs from 'node:fs';
import {
  IToolDefinition,
  ReadFileParams,
  ReadFileParamsSchema,
  ToolExecutionContext,
  ToolResult,
} from '@moderado/contracts';
import { resolveInJail } from '../jail.js';

export const ReadFileTool: IToolDefinition<ReadFileParams> = {
  name: 'read_file',
  description: 'Read the contents of a file within the workspace with line offsets and limits.',
  requiresApproval: false,
  parametersSchema: ReadFileParamsSchema,

  async execute(params: ReadFileParams, context: ToolExecutionContext): Promise<ToolResult> {
    const canonicalPath = resolveInJail(context.workspaceRoot, params.path);

    if (!fs.existsSync(canonicalPath)) {
      return {
        toolName: 'read_file',
        status: 'error',
        output: `Error: File '${params.path}' does not exist.`,
      };
    }

    const stat = fs.statSync(canonicalPath);
    if (stat.isDirectory()) {
      return {
        toolName: 'read_file',
        status: 'error',
        output: `Error: Path '${params.path}' is a directory, not a file. Use 'list_files' instead.`,
      };
    }

    // Binary check: read up to 512 bytes and check for null byte
    const fd = fs.openSync(canonicalPath, 'r');
    try {
      const buffer = Buffer.alloc(512);
      const bytesRead = fs.readSync(fd, buffer, 0, 512, 0);
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 0) {
          return {
            toolName: 'read_file',
            status: 'error',
            output: `Error: Cannot display '${params.path}': binary file detected.`,
          };
        }
      }
    } finally {
      fs.closeSync(fd);
    }

    const rawContent = fs.readFileSync(canonicalPath, 'utf8');
    const allLines = rawContent.split(/\r?\n/);
    const totalLines = allLines.length;

    const startIdx = Math.max(0, params.offset - 1);
    const endIdx = Math.min(totalLines, startIdx + params.limit);
    const selectedLines = allLines.slice(startIdx, endIdx);

    const formattedLines = selectedLines.map((line, idx) => {
      const lineNum = startIdx + idx + 1;
      return `${lineNum}: ${line}`;
    });

    const isTruncated = endIdx < totalLines;
    let output = formattedLines.join('\n');
    if (isTruncated) {
      output += `\n... [${totalLines - endIdx} more lines truncated. Use offset=${endIdx + 1} to read further]`;
    }

    return {
      toolName: 'read_file',
      status: 'success',
      output,
      truncated: isTruncated,
      metadata: {
        totalLines,
        displayedStart: startIdx + 1,
        displayedEnd: endIdx,
      },
    };
  },
};
