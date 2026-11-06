import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('connections enable write-ahead logging so a reader never blocks a writer', async () => {
  const source = await read('src-tauri/src/db.rs');
  // Every store opens its own connection and the scheduler polls while the
  // window writes, so the journal mode decides whether contention is visible.
  assert.match(source, /PRAGMA journal_mode=WAL/);
  assert.match(source, /eq_ignore_ascii_case\("wal"\)/);
});

test('the checkpoint rail is bounded but every checkpoint can still be restored', async () => {
  const source = await read('src-tauri/src/sessions.rs');
  assert.match(source, /CHECKPOINT_LIST_LIMIT: i64 = 100/);
  assert.match(source, /ORDER BY created_at DESC,id DESC LIMIT \?2/);
  const lookup = source.slice(source.indexOf('pub fn get_checkpoint'));
  assert.match(lookup, /WHERE session_id=\?1 AND id=\?2/);
  // Searching the truncated list would make older checkpoints unrestorable.
  assert.doesNotMatch(lookup.slice(0, 900), /list_checkpoints/);
});

test('a finished turn does not write its history twice', async () => {
  const source = await read('src-tauri/src/lib.rs');
  const completion = source.slice(
    source.indexOf('let result = tokio::select!'),
    source.indexOf('async fn run_due_schedule'),
  );
  const beforeMatch = completion.slice(0, completion.indexOf('match result'));
  // The turn's own callback already persisted the final history.
  assert.doesNotMatch(beforeMatch, /save_state/, 'the turn must not save before matching its outcome');
  assert.match(completion, /Some\(Ok\(\(\)\)\) => \{/);
  // The error and cancel paths still save what the turn held.
  assert.equal(completion.match(/save_state\(&session_id, &settings, &messages\)/g)?.length, 2);
});
