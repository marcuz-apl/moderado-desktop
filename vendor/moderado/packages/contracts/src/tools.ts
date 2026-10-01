import { z } from 'zod';
import type { ProviderToolDeclaration } from './provider.js';

export const ToolExecutionStatusSchema = z.enum(['success', 'error', 'denied']);
export type ToolExecutionStatus = z.infer<typeof ToolExecutionStatusSchema>;

export const ToolResultSchema = z.object({
  toolName: z.string().min(1),
  status: ToolExecutionStatusSchema,
  output: z.string(),
  truncated: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

export interface ToolExecutionContext {
  workspaceRoot: string;
  abortSignal?: AbortSignal;
}

export interface IToolDefinition<TParams = unknown> {
  readonly name: string;
  readonly description: string;
  readonly requiresApproval: boolean;
  readonly parametersSchema: z.ZodType<TParams, any, any>;
  preview?(params: TParams, context: ToolExecutionContext): Promise<string | undefined>;
  execute(params: TParams, context: ToolExecutionContext): Promise<ToolResult>;
}

export interface IToolRegistry {
  register(tool: IToolDefinition<any>): void;
  get(name: string): IToolDefinition<any> | undefined;
  list(): IToolDefinition<any>[];
  getDeclarations(): ProviderToolDeclaration[];
}

export const McpServerConfigSchema = z.object({ executable: z.string().min(1), args: z.array(z.string()).max(32).default([]), enabled: z.boolean().default(true) });
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export const SourcePositionSchema = z.object({ path: z.string().min(1), line: z.number().int().positive(), column: z.number().int().positive() });
export type SourcePosition = z.infer<typeof SourcePositionSchema>;
export const SourceLocationSchema = SourcePositionSchema.extend({ endLine: z.number().int().positive().optional(), endColumn: z.number().int().positive().optional(), preview: z.string().max(500).optional() });
export type SourceLocation = z.infer<typeof SourceLocationSchema>;
export const GetDefinitionParamsSchema = SourcePositionSchema;
export type GetDefinitionParams = z.infer<typeof GetDefinitionParamsSchema>;
export const FindReferencesParamsSchema = SourcePositionSchema;
export type FindReferencesParams = z.infer<typeof FindReferencesParamsSchema>;
export const DiagnosticSeveritySchema = z.enum(['error', 'warning', 'info']);
export type DiagnosticSeverity = z.infer<typeof DiagnosticSeveritySchema>;
export const DiagnosticSchema = z.object({ severity: DiagnosticSeveritySchema, message: z.string().min(1), file: z.string().min(1).optional(), line: z.number().int().positive().optional(), column: z.number().int().positive().optional(), code: z.string().min(1).optional() });
export type Diagnostic = z.infer<typeof DiagnosticSchema>;
export const RunDiagnosticsParamsSchema = z.object({ script: z.enum(['typecheck', 'lint', 'test']) });
export type RunDiagnosticsParams = z.infer<typeof RunDiagnosticsParamsSchema>;
export const WebSearchParamsSchema = z.object({
  query: z.string().min(1).max(500).describe('Describe the ideal source page to find, for example "current weather conditions and today forecast in San Jose California".'),
  objective: z.string().min(1).max(1000).describe('The facts the answer must contain, for example the specific figures to report.').optional(),
  endpoint: z.string().min(1).describe('Advanced override for the configured search endpoint. Anything that is not an HTTPS or localhost URL is rejected, so omit this to use the configured search provider.').optional(),
  maxResults: z.number().int().min(1).max(10).describe('Number of search results to use as evidence.').default(5),
});
export type WebSearchParams = z.infer<typeof WebSearchParamsSchema>;
// --- Specific Parameter Schemas for the 7 Workspace Tools ---

export const ReadFileParamsSchema = z.object({
  path: z.string().min(1, 'File path cannot be empty'),
  offset: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(2000).default(500),
});
export type ReadFileParams = z.infer<typeof ReadFileParamsSchema>;

export const WriteFileParamsSchema = z.object({
  path: z.string().min(1, 'File path cannot be empty'),
  content: z.string(),
});
export type WriteFileParams = z.infer<typeof WriteFileParamsSchema>;

export const EditFileParamsSchema = z.object({
  path: z.string().min(1, 'File path cannot be empty'),
  targetContent: z.string().min(1, 'Target content must not be empty'),
  replacementContent: z.string(),
});
export type EditFileParams = z.infer<typeof EditFileParamsSchema>;

export const ApplyPatchParamsSchema = z.object({
  edits: z.array(EditFileParamsSchema).min(1).max(20),
});
export type ApplyPatchParams = z.infer<typeof ApplyPatchParamsSchema>;

export const ListFilesParamsSchema = z.object({
  subpath: z.string().default('.'),
  recursive: z.boolean().default(false),
  maxDepth: z.number().int().min(1).max(10).default(3),
  limit: z.number().int().min(1).max(500).default(200),
});
export type ListFilesParams = z.infer<typeof ListFilesParamsSchema>;

export const SearchFilesParamsSchema = z.object({
  query: z.string().min(1, 'Search query cannot be empty'),
  isRegex: z.boolean().default(false),
  caseSensitive: z.boolean().default(true),
  includes: z.array(z.string()).optional(),
  maxResults: z.number().int().min(1).max(100).default(50),
});
export type SearchFilesParams = z.infer<typeof SearchFilesParamsSchema>;

export const RunCommandParamsSchema = z.object({
  command: z.string().min(1, 'Command cannot be empty'),
  args: z.array(z.string()).default([]),
  timeoutSeconds: z.number().int().min(1).max(300).default(60),
});
export type RunCommandParams = z.infer<typeof RunCommandParamsSchema>;

export const GitDiffParamsSchema = z.object({
  staged: z.boolean().default(false),
  targetRef: z.string().regex(/^[a-zA-Z0-9_\-\.\/]+$/).optional(),
  filePaths: z.array(z.string()).optional(),
});
export type GitDiffParams = z.infer<typeof GitDiffParamsSchema>;
