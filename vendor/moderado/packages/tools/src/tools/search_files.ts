import fs from 'node:fs';
import path from 'node:path';
import {
  IToolDefinition,
  SearchFilesParams,
  SearchFilesParamsSchema,
  ToolExecutionContext,
  ToolResult,
} from '@moderado/contracts';
import { isProtectedPath, resolveInJail } from '../jail.js';

const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.turbo',
  '.next',
  '.nuxt',
  'coverage',
]);

export const SearchFilesTool: IToolDefinition<SearchFilesParams> = {
  name: 'search_files',
  description: 'grep alias: search workspace file contents with literal strings or regex patterns. Results use grep-style path:line:content output.',
  requiresApproval: false,
  parametersSchema: SearchFilesParamsSchema,

  async execute(params: SearchFilesParams, context: ToolExecutionContext): Promise<ToolResult> {
    const root = resolveInJail(context.workspaceRoot, '.');

    let matcher: RegExp;
    try {
      if (params.isRegex) {
        matcher = new RegExp(params.query, params.caseSensitive ? 'g' : 'gi');
      } else {
        const escaped = params.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        matcher = new RegExp(escaped, params.caseSensitive ? 'g' : 'gi');
      }
    } catch (err: any) {
      return {
        toolName: 'search_files',
        status: 'error',
        output: `Invalid search pattern: ${err.message}`,
      };
    }

    const matches: string[] = [];
    let hitLimit = false;

    function searchDir(currentDir: string) {
      if (hitLimit) return;

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (hitLimit) return;

        const fullPath = path.join(currentDir, entry.name);
        const relPath = path.relative(root, fullPath);

        if (isProtectedPath(relPath)) {
          continue;
        }

        if (entry.isDirectory()) {
          if (!DEFAULT_IGNORED_DIRS.has(entry.name)) {
            searchDir(fullPath);
          }
        } else if (entry.isFile()) {
          if (params.includes && params.includes.length > 0) {
            const matchesIncludes = params.includes.some((ext) => relPath.endsWith(ext) || relPath.includes(ext));
            if (!matchesIncludes) {
              continue;
            }
          }

          // Skip large files (> 2MB)
          try {
            const stat = fs.statSync(fullPath);
            if (stat.size > 2 * 1024 * 1024) {
              continue;
            }

            const content = fs.readFileSync(fullPath, 'utf8');
            // Check for binary
            if (content.includes('\0')) {
              continue;
            }

            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              matcher.lastIndex = 0;
              if (matcher.test(line)) {
                matches.push(`${relPath}:${i + 1}:${line.trim()}`);
                if (matches.length >= params.maxResults) {
                  hitLimit = true;
                  return;
                }
              }
            }
          } catch {
            // ignore read error on individual files
          }
        }
      }
    }

    searchDir(root);

    let output = matches.join('\n');
    if (hitLimit) {
      output += `\n... [Limit of ${params.maxResults} matches reached]`;
    } else if (matches.length === 0) {
      output = `No matches found for '${params.query}'.`;
    }

    return {
      toolName: 'search_files',
      status: 'success',
      output,
      truncated: hitLimit,
      metadata: {
        matchesCount: matches.length,
      },
    };
  },
};
