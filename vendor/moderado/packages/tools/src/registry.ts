import {
  IToolDefinition,
  IToolRegistry,
  ProviderToolDeclaration,
} from '@moderado/contracts';
import { ReadFileTool } from './tools/read_file.js';
import { WriteFileTool } from './tools/write_file.js';
import { EditFileTool } from './tools/edit_file.js';
import { ListFilesTool } from './tools/list_files.js';
import { SearchFilesTool } from './tools/search_files.js';
import { RunCommandTool } from './tools/run_command.js';
import { GitDiffTool } from './tools/git_diff.js';
import { ApplyPatchTool } from './tools/apply_patch.js';
import { RunDiagnosticsTool } from './tools/run_diagnostics.js';
import { FindReferencesTool, GetDefinitionTool } from './tools/language_intelligence.js';
import { WebSearchTool } from './tools/web_search.js';

export class ToolRegistry implements IToolRegistry {
  private readonly tools = new Map<string, IToolDefinition<any>>();

  register(tool: IToolDefinition<any>): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): IToolDefinition<any> | undefined {
    return this.tools.get(name);
  }

  list(): IToolDefinition<any>[] {
    return Array.from(this.tools.values());
  }

  getDeclarations(): ProviderToolDeclaration[] {
    return this.list().map((tool) => {
      // Generate basic JSON Schema representation from Zod schema
      return {
        name: tool.name,
        description: tool.description,
        parameters: zodToJsonSchema(tool.parametersSchema),
      };
    });
  }
}

/**
 * Minimalist JSON schema extractor from Zod schemas adhering to Ponytail Decision Ladder.
 */
function zodToJsonSchema(schema: any): Record<string, unknown> {
  const def = schema._def;
  if (!def) {
    return { type: 'object' };
  }

  if (def.typeName === 'ZodObject') {
    const shape = def.shape();
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, propSchema] of Object.entries(shape) as [string, any][]) {
      const propDef = propSchema._def;
      const isOptional =
        propDef.typeName === 'ZodOptional' ||
        propDef.typeName === 'ZodDefault';

      if (!isOptional) {
        required.push(key);
      }

      properties[key] = extractPropertySchema(propSchema);
    }

    return {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined,
    };
  }

  return { type: 'object' };
}

function extractPropertySchema(propSchema: any): Record<string, unknown> {
  let current = propSchema;
  let description: string | undefined;

  while (current._def?.innerType) {
    current = current._def.innerType;
  }
  description = current.description;

  const typeName = current._def?.typeName;
  let schema: Record<string, unknown> = { type: 'string' };

  switch (typeName) {
    case 'ZodString':
      schema = { type: 'string' };
      break;
    case 'ZodNumber':
      schema = { type: 'number' };
      break;
    case 'ZodBoolean':
      schema = { type: 'boolean' };
      break;
    case 'ZodArray':
      schema = {
        type: 'array',
        items: extractPropertySchema(current._def.type),
      };
      break;
    case 'ZodEnum':
      schema = {
        type: 'string',
        enum: current._def.values,
      };
      break;
    case 'ZodRecord':
      schema = {
        type: 'object',
      };
      break;
    default:
      schema = { type: 'string' };
      break;
  }

  if (description) {
    schema.description = description;
  }
  return schema;
}

export function createDefaultToolRegistry(extraTools: IToolDefinition<any>[] = []): IToolRegistry {
  const registry = new ToolRegistry();
  registry.register(ReadFileTool);
  registry.register(WriteFileTool);
  registry.register(EditFileTool);
  registry.register(ListFilesTool);
  registry.register(SearchFilesTool);
  registry.register(RunCommandTool);
  registry.register(GitDiffTool);
  registry.register(ApplyPatchTool);
  registry.register(RunDiagnosticsTool);
  registry.register(GetDefinitionTool);
  registry.register(FindReferencesTool);
  registry.register(WebSearchTool);
  for (const tool of extraTools) registry.register(tool);
  return registry;
}
