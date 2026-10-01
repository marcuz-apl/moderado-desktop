// Bundles the extension into a single CommonJS file for the VS Code extension
// host.
process.on('unhandledRejection', (error) => {
  console.error('UNHANDLED', error);
  process.exit(1);
});
//
// The host loads CommonJS, but the vendored Moderado packages are ESM, so they
// cannot be `require`d. esbuild inlines the whole dependency graph into one
// self-contained file, which also means the shipped package carries no
// node_modules and cannot accidentally reach a shared runtime.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(here, '..');
const repoRoot = path.resolve(extensionRoot, '..', '..');
const vendorRoot = path.join(repoRoot, 'vendor', 'moderado', 'packages');

// The ESM sources are bundled into a sibling chunk and the CommonJS entry
// re-exports them. Distinct names keep esbuild from resolving the require
// against its own generated `main.node_modules` helper directory.
const coreFile = path.join(extensionRoot, 'dist', 'agent-core.js');
const outFile = path.join(extensionRoot, 'dist', 'extension.js');

/** Fails loudly rather than bundling a half-built vendor tree. */
for (const name of ['contracts', 'core', 'providers', 'tools']) {
  const entry = path.join(vendorRoot, name, 'dist', 'index.js');
  if (!fs.existsSync(entry)) {
    throw new Error(`Vendored package '${name}' is not built. Run: cd vendor/moderado && npm run build`);
  }
}

const alias = Object.fromEntries(
  ['contracts', 'core', 'providers', 'tools'].map((name) => [
    `@moderado/${name}`,
    path.join(vendorRoot, name, 'dist', 'index.js'),
  ]),
);

// The ESM sources are bundled into `agent-core.js`; the CommonJS entry re-exports
// them. Bundling straight into `extension.js` would emit
// `0 && (module.exports = ...)`, leaving the host with an empty export object.
await build({
  entryPoints: [path.join(extensionRoot, 'src', 'extension.ts')],
  outfile: coreFile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  // The host provides these; bundling them would break activation.
  external: ['vscode'],
  alias,
  logLevel: 'info',
  mainFields: ['module', 'main'],
  conditions: ['import', 'require', 'node', 'default'],
  // The sources are ESM but the host loads CommonJS. esbuild emits ESM exports as
  // dead code in CJS output (`0 && (module.exports = ...)`), which leaves the host
  // with an empty export object and no `activate`. `globalName` captures the
  // entry namespace as a real object, which this footer then assigns so the
  // activation contract is satisfied.
  globalName: '__moderadoAgent',
  footer: {
    js: 'if (typeof __moderadoAgent !== "undefined") { module.exports = __moderadoAgent; }',
  },
});

// The CommonJS entry is tiny, so copy it verbatim rather than re-bundling.
fs.writeFileSync(outFile, fs.readFileSync(path.join(extensionRoot, 'src', 'main.cts'), 'utf8'));

// The entry point is CommonJS (`.cts`) on purpose. When esbuild bundles an ESM
// entry into CJS output it emits `0 && (module.exports = ...)`, so the extension
// host receives an empty export object and never finds `activate`. Verifying the
// shape here keeps that failure from reaching a real editor.
const bundled = fs.readFileSync(outFile, 'utf8');
if (!/activate/.test(bundled) || !/module\.exports/.test(bundled)) {
  throw new Error('Bundle entry does not expose activate; the extension host could not activate it.');
}
const core = fs.readFileSync(coreFile, 'utf8');
// esbuild emits `0 && (module.exports = ...)` when it cannot produce real CJS
// exports. The assignment must be unconditional and present.
if (!/^module\.exports\s*=/m.test(core) && !/^\s*module\.exports\s*=\s*__moderadoAgent/m.test(core)) {
  throw new Error('Bundled core has no reachable module.exports; the host would receive an empty export object.');
}

// Load the bundle the way the extension host does and assert the activation
// contract before shipping it. `vscode` only exists inside the host, so it is
// stubbed through the module loader rather than injected as a parameter.
const nodeRequire = createRequire(import.meta.url);
const vscodeStubPath = path.join(extensionRoot, 'dist', 'vscode-stub.cjs');
fs.writeFileSync(
  vscodeStubPath,
  `module.exports = {
  window: {
    createOutputChannel: () => ({ appendLine() {}, dispose() {}, show() {}, hide() {} }),
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined,
    showTextDocument: async () => undefined,
    createWebviewPanel: () => ({ webview: { onDidReceiveMessage() {}, postMessage() {} }, onDidDispose() {}, dispose() {} }),
    registerWebviewPanelSerializer: () => ({ dispose() {} }),
  },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined, getCommands: () => [] },
  workspace: { getConfiguration: () => ({ get: (_k, fallback) => fallback, update: async () => {} }), workspaceFolders: undefined },
  Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
  ViewColumn: { One: 1 },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
};\n`,
  'utf8',
);

const Module = nodeRequire('node:module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolveWithVscodeStub(request, ...rest) {
  if (request === 'vscode') return vscodeStubPath;
  return originalResolve.call(this, request, ...rest);
};

try {
  const loaded = nodeRequire(outFile);
  if (typeof loaded.activate !== 'function') {
    throw new Error('Bundle smoke load did not expose an activate() export.');
  }
  // Activation must not throw against the stub host.
  await loaded.activate({ subscriptions: [] });
} finally {
  Module._resolveFilename = originalResolve;
  fs.rmSync(vscodeStubPath, { force: true });
}

const totalBytes = fs.statSync(outFile).size + fs.statSync(coreFile).size;
console.log(`Bundled extension: ${(totalBytes / 1024).toFixed(0)} KiB`);