import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('commit and push live in the Changes tab, gated on a remote', async () => {
  const [html, main, style] = await Promise.all([read('index.html'), read('src/renderer/main.ts'), read('src/renderer/style.css')]);
  const changes = html.slice(html.indexOf('data-right-view="changes"'), html.indexOf('data-right-view="checkpoints"'));
  assert.match(changes, /id="git-commit-message"/);
  assert.match(changes, /id="git-commit"[\s\S]*id="git-push"/);
  // Nothing to commit for, and no push without credentials, so both stay hidden
  // until the identity probe says otherwise.
  assert.match(changes, /id="git-actions" class="git-actions" hidden/);
  assert.match(main, /actions\.toggleAttribute\('hidden', !identity\.remote\)/);
  assert.match(main, /\$\<HTMLButtonElement\>\('git-push'\)\.disabled = identity\.credential !== 'ready'/);
  assert.match(style, /\.git-actions\{display:flex;flex-direction:column/);
});

test('git identity replaces the GitHub placeholder', async () => {
  const html = await read('index.html');
  assert.doesNotMatch(html, /id="profile-github"/, 'the placeholder is gone');
  assert.doesNotMatch(html, /Sign-in has not been configured for this build/);
  assert.match(html, /id="profile-git" hidden/);
  assert.match(html, /id="profile-git-name"/);
  assert.match(html, /id="profile-git-remote"/);
  assert.match(html, /id="profile-git-credential"/);
});

test('git write commands refuse a Work session', async () => {
  const lib = await read('src-tauri/src/lib.rs');
  // The guard is in one place and all three commands go through it.
  assert.match(lib, /fn code_workspace\(/);
  assert.match(lib, /Commit and push are available in Code sessions/);
  for (const command of ['git_identity', 'git_commit', 'git_push']) {
    const body = lib.slice(lib.indexOf(`fn ${command}(`), lib.indexOf(`fn ${command}(`) + 700);
    assert.match(body, /code_workspace\(&state/, `${command} must use the Code-only resolver`);
  }
});

test('git never waits on a credential prompt', async () => {
  const source = await read('src-tauri/src/source_control.rs');
  for (const variable of ['GIT_TERMINAL_PROMPT", "0"', 'GCM_INTERACTIVE", "never"', 'GIT_ASKPASS", ""']) {
    assert.ok(source.includes(variable), variable);
  }
  // git commit prints "nothing to commit" on stdout, so both streams are read.
  assert.match(source, /fn output_text\(/);
  assert.match(source, /explain_git_error\(&output_text\(&committed\)\)/);
});
