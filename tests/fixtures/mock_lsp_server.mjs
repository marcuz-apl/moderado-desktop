// Minimal LSP server for offline tests. Framing: Content-Length + JSON body.
import { stdin, stdout } from 'node:process';

let buffer = Buffer.alloc(0);

function send(message) {
  const body = JSON.stringify(message);
  stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function handle(message) {
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        capabilities: { textDocumentSync: 1 },
        serverInfo: { name: 'mock-lsp', version: '1.0.0' },
      },
    });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'textDocument/didOpen') {
    send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: message.params.textDocument.uri,
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            severity: 1,
            message: 'mock error',
          },
        ],
      },
    });
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, result: null });
  }
}

stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const header = buffer.subarray(0, headerEnd).toString();
    const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1] ?? 0);
    if (buffer.length < headerEnd + 4 + length) break;
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString();
    buffer = buffer.subarray(headerEnd + 4 + length);
    try {
      handle(JSON.parse(body));
    } catch {
      // ignore malformed input
    }
  }
});
