import fs from 'node:fs';
import path from 'node:path';
import {
  IToolDefinition,
  ListFilesParams,
  ListFilesParamsSchema,
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

export interface ListFilesOptions {
  recursive?: boolean;
  maxDepth?: number;
  limit?: number;
}

/**
 * Canonicalize a walk root so workspace-relative paths stay relative when the
 * supplied root is itself a symlinked path (for example macOS /var -> /private/var
 * or a Windows junctioned temp directory). Falls back to the supplied root when it
 * cannot be resolved, which keeps a missing root behaving as an empty listing.
 */
function canonicalRootOrSelf(workspaceRoot: string): string {
  try {
    return fs.realpathSync(workspaceRoot);
  } catch {
    return workspaceRoot;
  }
}

export async function listFiles(
  workspaceRoot: string,
  subpathOrQuery: string = '',
  options: ListFilesOptions = {}
): Promise<string[]> {
  const limit = options.limit ?? 50;
  const maxDepth = options.maxDepth ?? 5;
  const recursive = options.recursive ?? true;
  const query = subpathOrQuery.trim();

  const root = canonicalRootOrSelf(workspaceRoot);
  let startDir = root;
  let filterText = query;

  if (query) {
    try {
      const candidateDir = resolveInJail(workspaceRoot, query);
      if (fs.existsSync(candidateDir) && fs.statSync(candidateDir).isDirectory()) {
        startDir = candidateDir;
        filterText = '';
      }
    } catch {
      // Query is a filter substring, not an existing directory.
    }
  }

  const results: string[] = [];
  const normalizedQuery = filterText.toLowerCase().replace(/\\/g, '/');

  function walk(currentDir: string, currentDepth: number) {
    if (results.length >= limit || currentDepth > maxDepth) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= limit) return;

      const fullPath = path.join(currentDir, entry.name);
      const relFromRoot = path.relative(root, fullPath).replace(/\\/g, '/');

      if (isProtectedPath(relFromRoot)) continue;

      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED_DIRS.has(entry.name)) continue;
        if (recursive || currentDepth < maxDepth) {
          walk(fullPath, currentDepth + 1);
        }
      } else if (entry.isFile()) {
        if (!normalizedQuery || relFromRoot.toLowerCase().includes(normalizedQuery)) {
          results.push(relFromRoot);
        }
      }
    }
  }

  walk(startDir, 1);
  return results;
}

export const ListFilesTool: IToolDefinition<ListFilesParams> = {
  name: 'list_files',
  description: 'List files and directories in the workspace with recursive options.',
  requiresApproval: false,
  parametersSchema: ListFilesParamsSchema,

  async execute(params: ListFilesParams, context: ToolExecutionContext): Promise<ToolResult> {
    const canonicalDir = resolveInJail(context.workspaceRoot, params.subpath);
    const workspaceRoot = canonicalRootOrSelf(context.workspaceRoot);

    if (!fs.existsSync(canonicalDir)) {
      return {
        toolName: 'list_files',
        status: 'error',
        output: `Error: Directory '${params.subpath}' does not exist.`,
      };
    }

    const stat = fs.statSync(canonicalDir);
    if (!stat.isDirectory()) {
      return {
        toolName: 'list_files',
        status: 'error',
        output: `Error: '${params.subpath}' is a file, not a directory.`,
      };
    }

    const results: string[] = [];
    let hitLimit = false;

    function walk(currentDir: string, currentDepth: number) {
      if (hitLimit || currentDepth > params.maxDepth) {
        return;
      }

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch (err: any) {
        results.push(`[Permission denied: ${path.relative(workspaceRoot, currentDir)}]`);
        return;
      }

      for (const entry of entries) {
        if (results.length >= params.limit) {
          hitLimit = true;
          return;
        }

        const fullPath = path.join(currentDir, entry.name);
        const relFromRoot = path.relative(workspaceRoot, fullPath);

        if (isProtectedPath(relFromRoot)) {
          continue;
        }

        if (entry.isDirectory()) {
          if (DEFAULT_IGNORED_DIRS.has(entry.name)) {
            continue;
          }
          results.push(`${relFromRoot}/`);
          if (params.recursive) {
            walk(fullPath, currentDepth + 1);
          }
        } else {
          results.push(relFromRoot);
        }
      }
    }

    walk(canonicalDir, 1);

    let output = results.join('\n');
    if (hitLimit) {
      output += `\n... [Limit of ${params.limit} files reached]`;
    } else if (results.length === 0) {
      output = '(Empty directory)';
    }

    return {
      toolName: 'list_files',
      status: 'success',
      output,
      truncated: hitLimit,
      metadata: {
        totalCount: results.length,
      },
    };
  },
};
