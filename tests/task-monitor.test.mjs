import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  artifactsFromActivity,
  artifactsFromTool,
  backgroundRows,
  checkpointUpdates,
  elapsedLabel,
  mergeUpdates,
  shortText,
  toolTitle,
  updatesFromActivity,
} from '../src/renderer/task-monitor.ts';

const activity = (toolName, content, extra = {}) => ({
  role: 'Activity', toolName, content, toolId: `${toolName}-1`, createdAt: 1_000, ...extra,
});

test('tool titles stay human and short text is one line', () => {
  assert.equal(toolTitle('write_file'), 'Created a file');
  assert.equal(toolTitle('execute_command'), 'Ran a command');
  assert.equal(toolTitle(undefined), 'Tool activity');
  assert.equal(shortText('one\n two   three'), 'one');
  assert.equal(shortText('x'.repeat(20), 10), 'xxxxxxxxx…');
});

test('updates keep tool failures and hide read payloads', () => {
  const updates = updatesFromActivity([
    activity('read_file', '# source code that must not leak into the feed', { createdAt: 1_000 }),
    activity('write_file', 'Wrote src/main.ts', { createdAt: 2_000 }),
    activity('execute_command', JSON.stringify({ exitCode: 0, changedFiles: [] }), { createdAt: 3_000 }),
    activity('search_files', 'Error: no match', { createdAt: 4_000 }),
  ], 5_000);
  assert.deepEqual(updates.map((item) => item.label), [
    'Searched files', 'Ran a command', 'Created a file', 'Read a file',
  ]);
  assert.equal(updates.find((item) => item.label === 'Searched files')?.kind, 'error');
  assert.equal(updates.find((item) => item.label === 'Read a file')?.detail, '');
  assert.equal(updates.find((item) => item.label === 'Created a file')?.detail, 'Wrote src/main.ts');
  assert.equal(updates.find((item) => item.label === 'Ran a command')?.detail, 'Exit 0');
});

test('checkpoints merge newest first and ids are deduplicated', () => {
  const checkpoints = checkpointUpdates([
    { id: 'b', path: 'src/b.ts', createdAt: 20 },
    { id: 'a', path: 'src/a.ts', createdAt: 10 },
  ]);
  assert.deepEqual(checkpoints.map((item) => item.detail), ['src/b.ts', 'src/a.ts']);
  const merged = mergeUpdates([
    updatesFromActivity([activity('write_file', 'Wrote x.ts')], 1_000),
    checkpoints,
    checkpoints,
  ]);
  assert.equal(merged.filter((item) => item.id === 'checkpoint:b').length, 1);
  assert.equal(merged[0]?.id, 'checkpoint:b');
  assert.equal(mergeUpdates([[checkpoints[0]]], 0).length, 0);
});

test('artifacts come from write, edit, and command results only', () => {
  assert.deepEqual(artifactsFromTool('write_file', 'Wrote src/a.ts', 10), [
    { path: 'src/a.ts', action: 'created', at: 10 },
  ]);
  assert.deepEqual(artifactsFromTool('edit_file', 'Edited src/a.ts with user-edited content', 20), [
    { path: 'src/a.ts', action: 'updated', at: 20 },
  ]);
  assert.deepEqual(artifactsFromTool('execute_command', JSON.stringify({ exitCode: 0, changedFiles: ['out/a.js', 'out/b.js'] }), 30), [
    { path: 'out/a.js', action: 'changed', at: 30 },
    { path: 'out/b.js', action: 'changed', at: 30 },
  ]);
  assert.deepEqual(artifactsFromTool('read_file', 'Wrote nothing', 40), []);
  assert.deepEqual(artifactsFromTool('write_file', 'Error: denied', 40), []);
  assert.deepEqual(artifactsFromTool('execute_command', 'not json', 40), []);
});

test('the latest action wins for a path and the list is newest first', () => {
  const artifacts = artifactsFromActivity([
    activity('write_file', 'Wrote src/a.ts', { createdAt: 10 }),
    activity('edit_file', 'Edited src/a.ts', { createdAt: 20 }),
    activity('write_file', 'Wrote src/b.ts', { createdAt: 15 }),
  ], 99);
  assert.deepEqual(artifacts, [
    { path: 'src/a.ts', action: 'updated', at: 20 },
    { path: 'src/b.ts', action: 'created', at: 15 },
  ]);
});

test('background rows combine the active turn and schedules without duplicates', () => {
  const run = { label: 'Scheduled: nightly', startedAt: 1_000, scheduled: true, scheduleId: 's1' };
  const schedules = [
    { id: 's1', prompt: 'nightly', inFlight: true, enabled: true, nextRunAt: 2_000, intervalSeconds: 60, lastError: null },
    { id: 's2', prompt: 'weekly', inFlight: false, enabled: true, nextRunAt: 121, intervalSeconds: 300, lastError: null },
    { id: 's3', prompt: 'paused', inFlight: false, enabled: false, nextRunAt: 0, intervalSeconds: null, lastError: 'boom' },
  ];
  const rows = backgroundRows(run, schedules, 61_000);
  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.state, 'running');
  assert.equal(rows[0]?.label, 'Scheduled: nightly');
  assert.ok(rows[0]?.detail.includes('1m'));
  assert.equal(rows[1]?.label, 'Scheduled: weekly');
  assert.equal(rows[1]?.detail, 'Next in 1m');
  assert.equal(rows[2]?.detail, 'Paused: boom');
  assert.deepEqual(backgroundRows(undefined, [], 0), []);
});

test('elapsed labels stay readable', () => {
  assert.equal(elapsedLabel(1_000, 1_000), '0s');
  assert.equal(elapsedLabel(1_000, 61_000), '1m');
  assert.equal(elapsedLabel(1_000, 3_661_000), '1h 1m');
});
