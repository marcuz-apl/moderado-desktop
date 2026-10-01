import { spawn } from 'node:child_process';
import { McpServerConfig } from '@moderado/contracts';
import { getSanitizedEnv } from './tools/run_command.js';

interface McpTool { name: string; description?: string; }
function request(server: McpServerConfig, method: string, params?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(server.executable, server.args, { env: getSanitizedEnv(), shell: false, windowsHide: true });
    let buffer = ''; let settled = false; let nextId = 1;
    const finish = (value: unknown | Error): void => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); value instanceof Error ? reject(value) : resolve(value); };
    const send = (name: string, value?: unknown): number => { const id = nextId++; const body = JSON.stringify({ jsonrpc: '2.0', id, method: name, params: value }); child.stdin?.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); return id; };
    const timer = setTimeout(() => finish(new Error('MCP server timed out.')), 10_000);
    child.on('error', () => finish(new Error(`Unable to start configured MCP server '${server.executable}'.`)));
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString(); if (buffer.length > 1_048_576) return finish(new Error('MCP response exceeded 1 MB.'));
      while (true) { const at = buffer.indexOf('\r\n\r\n'); if (at < 0) return; const match = buffer.slice(0, at).match(/Content-Length:\s*(\d+)/i); if (!match) return finish(new Error('Malformed MCP response.')); const end = at + 4 + Number(match[1]); if (buffer.length < end) return; const text = buffer.slice(at + 4, end); buffer = buffer.slice(end); try { const message = JSON.parse(text); if (message.id === 1) { send(method, params); } else if (message.id === 2) { if (message.error) finish(new Error(String(message.error.message ?? 'MCP request failed.'))); else finish(message.result); } } catch { return finish(new Error('Malformed MCP JSON response.')); } }
    });
    send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'moderado', version: '0.2.0' } });
  });
}
export async function listMcpTools(server: McpServerConfig): Promise<McpTool[]> { const result = await request(server, 'tools/list') as { tools?: unknown }; if (!Array.isArray(result.tools)) throw new Error('Malformed MCP tools/list response.'); return result.tools.filter((tool): tool is McpTool => !!tool && typeof tool === 'object' && /^[a-zA-Z0-9_-]+$/.test((tool as McpTool).name)); }
export async function callMcpTool(server: McpServerConfig, name: string, args: Record<string, unknown>): Promise<string> { const result = await request(server, 'tools/call', { name, arguments: args }) as { content?: unknown }; if (!Array.isArray(result.content)) throw new Error('Malformed MCP tools/call response.'); return result.content.map((part: any) => typeof part?.text === 'string' ? part.text : '').join('\n').slice(0, 65_536) || 'MCP tool completed without text output.'; }