// Commit wrapper for the version policy: a feat: subject increments the patch
// digit, everything else only advances the +YYMMDDn build counter.
//
// Git does not expose the commit message to the pre-commit hook (which is the
// only hook that can still change the staged tree), so this wrapper exports the
// bump kind as MODERADO_BUMP_KIND and pre-commit applies it. A direct
// `git commit -m "feat: ..."` is rejected by .githooks/commit-msg unless the
// patch was bumped by hand first.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const separator = args.indexOf('--');
const words = separator === -1 ? args : args.slice(0, separator);
const gitArgs = separator === -1 ? [] : args.slice(separator + 1);
const message = words.join(' ').trim();

if (!message) {
  console.error('usage: npm run commit -- "<type>: <subject>" [-- <git args>...]');
  process.exit(2);
}

const isFeat = /^feat(\([^)]*\))?:/.test(message);
let kind = isFeat ? 'patch' : 'build';

if (isFeat) {
  // Respect a manual `npm run version:patch`: never bump the same commit twice.
  const semver = (value) => value.trim().split(/[+-]/)[0];
  const current = semver(readFileSync('VERSION', 'utf8'));
  const shown = spawnSync('git', ['show', 'HEAD:VERSION'], { encoding: 'utf8' });
  const previous = shown.status === 0 ? semver(shown.stdout) : '';
  if (previous && current !== previous) kind = 'build';
}

const result = spawnSync(
  'git',
  ['commit', '-m', message, ...gitArgs],
  { stdio: 'inherit', env: { ...process.env, MODERADO_BUMP_KIND: kind } },
);
process.exit(result.status ?? 1);
