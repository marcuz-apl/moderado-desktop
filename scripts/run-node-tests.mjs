// Run every tests/*.test.mjs through Node's test runner.
//
// `node --test tests/*.test.mjs` relies on the shell expanding the glob; cmd.exe
// on Windows does not, so npm test failed there. Listing the files here keeps
// the command portable.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = join(root, 'tests');
const files = readdirSync(directory)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => join(directory, name));

if (files.length === 0) {
  console.error('No tests/*.test.mjs files found');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
