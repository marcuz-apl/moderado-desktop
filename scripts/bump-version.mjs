// Bump the semver part of VERSION before a commit. The pre-commit hook then
// advances the build counter, so the final identifier keeps this semver.
// Patch is the only digit that moves automatically, from 0 to 99. Minor and
// major change only when requested explicitly; mirrors .githooks/versionlib.sh.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const kind = process.argv[2];
if (!['major', 'minor', 'patch'].includes(kind)) {
  console.error('usage: node scripts/bump-version.mjs <major|minor|patch>');
  process.exit(2);
}

// Relative to the repository root, which is where npm runs this script.
const versionFile = join(process.cwd(), 'VERSION');
const current = readFileSync(versionFile, 'utf8').trim();
const match = /^v(\d+)\.(\d)\.(\d{1,2})([+-][0-9]{6}[1-9a-z])$/.exec(current);
if (!match) {
  console.error(`malformed identifier '${current}' in VERSION`);
  process.exit(1);
}

let major = Number(match[1]);
let minor = Number(match[2]);
let patch = Number(match[3]);

if (kind === 'major') {
  major += 1;
  minor = 0;
  patch = 0;
} else if (kind === 'minor') {
  if (minor === 9) {
    major += 1;
    minor = 0;
  } else {
    minor += 1;
  }
  patch = 0;
} else {
  if (patch >= 99) {
    console.error(
      `v${major}.${minor}.${patch}: the patch digit is capped at 99. ` +
        "Ask for a minor bump explicitly with 'npm run version:minor'.",
    );
    process.exit(1);
  }
  patch += 1;
}

const next = `v${major}.${minor}.${patch}${match[4]}`;
writeFileSync(versionFile, `${next}\n`);
console.log(next);
