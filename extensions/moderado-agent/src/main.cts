const { activate, deactivate } = require('./agent-core.js');

// CommonJS entry point. The extension host loads CommonJS, while the sources and
// the vendored agent packages are ESM, so esbuild bundles them into
// `extension-core.js` and this file exposes the host's expected shape.
module.exports = { activate, deactivate };