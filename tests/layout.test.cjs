'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { restoreSourceControlLayout, migrateSourceControlLayout, MIGRATION_KEY } = require('../src/layout');

function fixture(options = {}) {
  const state = new Map(options.migrated ? [[MIGRATION_KEY, true]] : []);
  const calls = [];
  const vscode = {
    workspace: { workspaceFolders: options.empty ? [] : [{ uri: { fsPath: '/fixture' } }] },
    commands: {
      async getCommands(filterInternal) {
        assert.equal(filterInternal, true);
        return options.commands || ['workbench.scm.resetViewLocation', 'repolens.changes.resetViewLocation'];
      },
      async executeCommand(id, ...args) {
        calls.push({ id, args });
        if (options.fail === id) throw new Error('restore failed');
      }
    }
  };
  const context = { globalState: {
    get(key, fallback) { return state.get(key) ?? fallback; },
    async update(key, value) { state.set(key, value); }
  } };
  return { vscode, context, calls, state };
}

test('restores only the native Changes and All Changes views without changing repository selection', async () => {
  const f = fixture();
  assert.deepEqual(await restoreSourceControlLayout(f.vscode), ['workbench.scm', 'repolens.changes']);
  assert.deepEqual(f.calls, [
    { id: 'workbench.scm.resetViewLocation', args: [] },
    { id: 'repolens.changes.resetViewLocation', args: [] }
  ]);
});

test('missing single-view commands never fall back to resetting the entire workbench', async () => {
  const f = fixture({ commands: ['workbench.action.resetViewLocations', 'workbench.scm.resetViewLocation'] });
  await assert.rejects(restoreSourceControlLayout(f.vscode));
  assert.deepEqual(f.calls, []);
});

test('migration runs once per profile and records completion only after both views are restored', async () => {
  const f = fixture();
  assert.equal(await migrateSourceControlLayout(f.vscode, f.context), true);
  assert.equal(f.state.get(MIGRATION_KEY), true);
  assert.equal(await migrateSourceControlLayout(f.vscode, f.context), false);
  assert.equal(f.calls.length, 2);
});

test('an empty window leaves the layout and migration flag untouched', async () => {
  const f = fixture({ empty: true });
  assert.equal(await migrateSourceControlLayout(f.vscode, f.context), false);
  assert.equal(f.state.has(MIGRATION_KEY), false);
  assert.deepEqual(f.calls, []);
});

test('a failed restoration remains retryable', async () => {
  const f = fixture({ fail: 'repolens.changes.resetViewLocation' });
  await assert.rejects(migrateSourceControlLayout(f.vscode, f.context), /restore failed/);
  assert.equal(f.state.has(MIGRATION_KEY), false);
  assert.equal(f.calls.length, 2);
});
