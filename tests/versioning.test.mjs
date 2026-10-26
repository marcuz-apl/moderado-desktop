import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hooks = new URL('../.githooks/', import.meta.url);
const bumpScript = fileURLToPath(new URL('../scripts/bump-version.mjs', import.meta.url));
const today = new Date().toISOString().slice(2, 10).replaceAll('-', '');

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function repository(version) {
  const root = mkdtempSync(join(tmpdir(), 'moderado-version-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Version Test');
  git(root, 'config', 'user.email', 'version@example.test');
  git(root, 'config', 'core.hooksPath', '.githooks');
  cpSync(hooks, join(root, '.githooks'), { recursive: true });
  writeFileSync(join(root, 'VERSION'), `${version}\n`);
  return root;
}

function commit(root, message, content) {
  writeFileSync(join(root, 'change.txt'), content);
  git(root, 'add', 'VERSION', 'change.txt');
  git(root, 'commit', '-qm', message);
  return {
    version: readFileSync(join(root, 'VERSION'), 'utf8').trim(),
    subject: git(root, 'log', '-1', '--format=%s'),
    committedVersion: git(root, 'show', 'HEAD:VERSION'),
  };
}

function bump(root, kind) {
  const result = spawnSync(process.execPath, [bumpScript, kind], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `bump ${kind}: ${result.stderr}`);
  return readFileSync(join(root, 'VERSION'), 'utf8').trim();
}

test('commits advance the build counter and leave the patch alone', () => {
  const root = repository('v0.1.3+2610114');
  try {
    const first = commit(root, 'feat(sidebar): add project browser', 'one');
    assert.equal(first.version, `v0.1.3+${today}1`);
    assert.equal(first.committedVersion, first.version);
    assert.equal(first.subject, `${first.version} feat(sidebar): add project browser`);
    assert.equal(git(root, 'show', 'HEAD:change.txt'), 'one');

    assert.equal(commit(root, 'docs: explain browser', 'two').version, `v0.1.3+${today}2`);
    assert.equal(commit(root, 'fix: correct a typo', 'three').version, `v0.1.3+${today}3`);
    assert.equal(commit(root, 'feat: add settings', 'four').version, `v0.1.3+${today}4`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the bump script moves the patch and the hook keeps it', () => {
  const root = repository('v0.1.3+2610114');
  try {
    assert.equal(bump(root, 'patch'), 'v0.1.4+2610114');
    assert.equal(commit(root, 'feat: add settings', 'one').version, `v0.1.4+${today}1`);
    assert.equal(bump(root, 'minor'), `v0.2.0+${today}1`);
    assert.equal(commit(root, 'feat: rework', 'two').version, `v0.2.0+${today}2`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the bump script rolls over at nine and rejects a bad kind', () => {
  const patchRoot = repository('v0.1.9+2610114');
  try {
    assert.equal(bump(patchRoot, 'patch'), 'v0.2.0+2610114');
  } finally {
    rmSync(patchRoot, { recursive: true, force: true });
  }

  const minorRoot = repository('v0.9.9+2610114');
  try {
    assert.equal(bump(minorRoot, 'minor'), 'v1.0.0+2610114');
  } finally {
    rmSync(minorRoot, { recursive: true, force: true });
  }

  const majorRoot = repository('v0.1.3+2610114');
  try {
    assert.equal(bump(majorRoot, 'major'), 'v1.0.0+2610114');
    const result = spawnSync(process.execPath, [bumpScript, 'nope'], {
      cwd: majorRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
  } finally {
    rmSync(majorRoot, { recursive: true, force: true });
  }
});

test('daily counter advances and rejects exhaustion or an invalid date', () => {
  const root = repository(`v0.1.3+${today}9`);
  try {
    assert.equal(commit(root, 'feat: counter', 'one').version, `v0.1.3+${today}a`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  for (const version of [`v0.1.3+${today}z`, 'v0.1.3+2610001', 'v0.1.10+2610111']) {
    const invalid = repository(version);
    try {
      writeFileSync(join(invalid, 'change.txt'), 'one');
      git(invalid, 'add', 'VERSION', 'change.txt');
      const result = spawnSync('git', ['commit', '-qm', 'feat: invalid'], { cwd: invalid, encoding: 'utf8' });
      assert.notEqual(result.status, 0, version);
      assert.equal(readFileSync(join(invalid, 'VERSION'), 'utf8').trim(), version);
    } finally {
      rmSync(invalid, { recursive: true, force: true });
    }
  }
});

test('every manifest follows VERSION without build metadata', () => {
  const root = repository('v0.1.3+2610114');
  try {
    writeFileSync(join(root, 'package.json'), '{\n  "name": "app",\n  "version": "0.1.0",\n  "private": true\n}\n');
    mkdirSync(join(root, 'src-tauri'), { recursive: true });
    writeFileSync(join(root, 'src-tauri', 'tauri.conf.json'), '{\n  "productName": "App",\n  "version": "0.1.0"\n}\n');
    writeFileSync(join(root, 'src-tauri', 'Cargo.toml'), '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(
      join(root, 'src-tauri', 'Cargo.lock'),
      '[[package]]\nname = "app"\nversion = "0.1.0"\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\n',
    );
    writeFileSync(join(root, 'change.txt'), 'one');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'feat: manifests');

    const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
    assert.equal(version, `v0.1.3+${today}1`);
    assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '0.1.3');
    assert.equal(JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')).version, '0.1.3');
    assert.match(readFileSync(join(root, 'src-tauri', 'Cargo.toml'), 'utf8'), /^version = "0\.1\.3"$/m);

    const lock = readFileSync(join(root, 'src-tauri', 'Cargo.lock'), 'utf8');
    assert.match(lock, /name = "app"\nversion = "0\.1\.3"/);
    assert.match(lock, /name = "serde"\nversion = "1\.0\.0"/);

    // The hook stages what it rewrites, so the commit carries the new files.
    assert.equal(git(root, 'show', 'HEAD:VERSION').trim(), version);
    assert.equal(git(root, 'status', '--porcelain'), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a repository without manifests still commits', () => {
  const root = repository('v0.1.3+2610114');
  try {
    assert.equal(commit(root, 'feat: no manifests', 'one').version, `v0.1.3+${today}1`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
