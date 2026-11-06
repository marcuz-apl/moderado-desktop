// Serves the built frontend in-process and runs browser checks against it.
// No dev server is left behind: the HTTP server closes when the checks finish.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', 'dist');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.md': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const server = http.createServer((request, response) => {
  const urlPath = decodeURIComponent(request.url.split('?')[0]);
  let file = path.resolve(ROOT, `.${urlPath === '/' ? '/index.html' : urlPath}`);
  if (!file.startsWith(ROOT)) { response.writeHead(403).end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(ROOT, 'index.html');
  fs.readFile(file, (error, data) => {
    if (error) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    response.end(data);
  });
});

// Asynchronous so the parent event loop stays free to answer HTTP requests.
const run = (script) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(__dirname, script)], { stdio: 'inherit' });
  child.on('exit', (code) => resolve(code === 0));
});

server.listen(1420, async () => {
  // With no arguments every check runs, so CI covers the whole set without a
  // hand-maintained list drifting out of date.
  const scripts = process.argv.length > 2
    ? process.argv.slice(2)
    : fs.readdirSync(__dirname).filter((name) => /^check-.*\.mjs$/.test(name)).sort();
  let failed = 0;
  for (const script of scripts) {
    console.log(`\n=== ${script} ===`);
    if (!(await run(script))) { failed += 1; console.log(`FAILED ${script}`); }
  }
  console.log(`\n${scripts.length - failed}/${scripts.length} browser checks passed`);
  server.close(() => { process.exitCode = failed ? 1 : 0; });
});
