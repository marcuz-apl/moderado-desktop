import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const hooks = new URL('../.githooks/', import.meta.url);
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

test('every commit advances the patch, including feat commits', () => {
  const root = repository('v0.1.3+2610114');
  try {
    const first = commit(root, 'feat(sidebar): add project browser', 'one');
    assert.equal(first.version, `v0.1.4+${today}1`);
    assert.equal(first.committedVersion, first.version);
    assert.equal(first.subject, `${first.version} feat(sidebar): add project browser`);
    assert.equal(git(root, 'show', 'HEAD:change.txt'), 'one');

    const docs = commit(root, 'docs: explain browser', 'two');
    assert.equal(docs.version, `v0.1.5+${today}2`);

    const second = commit(root, 'feat: add settings', 'three');
    assert.equal(second.version, `v0.1.6+${today}3`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('daily counter advances and rejects exhaustion or an invalid date', () => {
  const root = repository(`v0.1.3+${today}9`);
  try {
    assert.equal(commit(root, 'feat: counter', 'one').version, `v0.1.4+${today}a`);
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

test('feat patch rollover carries into the minor digit', () => {
  const root = repository('v0.1.9+2610114');
  try {
    assert.equal(commit(root, 'feat: next patch', 'one').version, `v0.2.0+${today}1`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
