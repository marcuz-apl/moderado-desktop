import { IToolDefinition, McpServerConfig, ToolExecutionContext, ToolResult } from '@moderado/contracts';
import { z } from 'zod';
import { callMcpTool, listMcpTools } from './mcp.js';

export interface McpTool {
  name: string;
  description?: string;
}

export interface McpServerStatus {
  name: string;
  enabled: boolean;
  tools: McpTool[];
  error?: string;
}

export function createMcpTool(serverName:string, server:McpServerConfig, toolName:string):IToolDefinition<Record<string,unknown>> { if(!/^[a-z0-9_-]+$/i.test(serverName)||!/^[a-z0-9_-]+$/i.test(toolName)) throw new Error('MCP server and tool names must be alphanumeric, dash, or underscore.'); return {name:`mcp.${serverName}.${toolName}`,description:`Configured MCP tool ${toolName}.`,requiresApproval:true,parametersSchema:z.record(z.unknown()),async execute(params:Record<string,unknown>,_context:ToolExecutionContext):Promise<ToolResult>{try{return {toolName:`mcp.${serverName}.${toolName}`,status:'success',output:await callMcpTool(server,toolName,params)};}catch(err:any){return {toolName:`mcp.${serverName}.${toolName}`,status:'error',output:err.message};}}};}

export async function discoverMcpServers(servers: Record<string, McpServerConfig> = {}): Promise<McpServerStatus[]> {
  return Promise.all(Object.entries(servers).map(async ([name, server]) => {
    const enabled = server.enabled !== false;
    if (!enabled) return { name, enabled, tools: [] };
    try {
      return { name, enabled, tools: await listMcpTools(server) };
    } catch (error) {
      return { name, enabled, tools: [], error: error instanceof Error ? error.message : 'MCP discovery failed.' };
    }
  }));
}

export async function createMcpTools(servers: Record<string, McpServerConfig> | undefined): Promise<IToolDefinition<Record<string, unknown>>[]> {
  if (!servers) return [];
  const discovered = await discoverMcpServers(servers);
  return discovered.flatMap((server) => server.tools.map((tool) => createMcpTool(server.name, servers[server.name], tool.name)));
}
