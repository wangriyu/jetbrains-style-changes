'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ChangelistStore, DEFAULT_LIST_ID, STORAGE_KEY } = require('../src/changelists');

const uri = value => ({ toString: () => value });
const change = (value, options = {}) => ({ uri: uri(value), status: 5, ...options });
const snapshot = (key, working = [], index = [], conflicts = []) => ({ key, working, index, conflicts });
const file = (repoKey, value) => ({ repoKey, uri: uri(value) });

function storage(initial) {
  const data = new Map(initial ? [[STORAGE_KEY, structuredClone(initial)]] : []);
  const writes = [];
  return {
    data, writes,
    get(key) { return data.get(key); },
    async update(key, value) {
      const copied = structuredClone(value);
      writes.push({ key, value: copied });
      data.set(key, copied);
    }
  };
}

test('default list exists without a write and returned snapshots cannot mutate storage', () => {
  const state = storage();
  const store = new ChangelistStore(state);
  assert.deepEqual(store.lists, [{ id: 'default', name: 'Default' }]);
  assert.equal(store.activeId, DEFAULT_LIST_ID);
  assert.equal(store.listFor('repo', 'file:///repo/clean'), DEFAULT_LIST_ID);
  const serialized = store.serialize();
  serialized.lists[0].name = 'Changed outside';
  serialized.files.arbitrary = 'bad';
  assert.equal(store.lists[0].name, 'Default');
  assert.deepEqual(store.serialize().files, {});
  assert.equal(state.writes.length, 0);
});

test('named lists, active list and cross-repository membership survive reload', async () => {
  const state = storage();
  const store = new ChangelistStore(state);
  const task = await store.create('  Checkout issue  ');
  assert.equal(task.name, 'Checkout issue');
  assert.equal(store.activeId, 'default');
  await store.setActive(task.id);
  assert.equal(store.sync([
    snapshot('repo-a', [change('file:///a/main.go')]),
    snapshot('repo-b', [change('file:///b/main.go')])
  ]), true);
  await store.flush();
  const reloaded = new ChangelistStore(state);
  assert.deepEqual(reloaded.serialize(), store.serialize());
  assert.equal(reloaded.listFor('repo-a', 'file:///a/main.go'), task.id);
  assert.equal(reloaded.listFor('repo-b', uri('file:///b/main.go')), task.id);
  await reloaded.rename(task.id, 'Checkout fix');
  assert.equal(new ChangelistStore(state).lists[1].name, 'Checkout fix');
});

test('rejects empty, control-character, duplicate and unknown list operations atomically', async () => {
  const state = storage();
  const store = new ChangelistStore(state);
  const task = await store.create('Feature');
  const baseline = store.serialize();
  for (const name of [undefined, null, '', '   ']) {
    await assert.rejects(store.create(name), /Enter a changelist name/);
  }
  for (const name of ['line\nbreak', 'carriage\rreturn', 'tab\tname', 'null\u0000name', 'line\u2028break']) {
    await assert.rejects(store.create(name), /control characters/);
  }
  for (const name of [' Feature ', 'FEATURE', 'Ｆｅａｔｕｒｅ', 'default']) {
    await assert.rejects(store.create(name), /already exists/);
  }
  await assert.rejects(store.create('x'.repeat(81)), /80 characters or fewer/);
  await assert.rejects(store.rename(task.id, 'Default'), /already exists/);
  await assert.rejects(store.rename('missing', 'Name'), /not found/);
  await assert.rejects(store.setActive('missing'), /not found/);
  await assert.rejects(store.remove('missing'), /not found/);
  await assert.rejects(store.remove('default'), /cannot be deleted/);
  assert.deepEqual(store.serialize(), baseline);
  assert.equal((await store.rename(task.id, 'Feature')).name, 'Feature');
  assert.equal(state.writes.length, 1);
});

test('repo key isolates identical URI strings and index and working share file membership', async () => {
  const state = storage();
  const store = new ChangelistStore(state);
  const task = await store.create('Task');
  store.sync([
    snapshot('repo-a', [change('file:///shared/main.go')], [change('file:///shared/main.go')]),
    snapshot('repo-b', [change('file:///shared/main.go')])
  ]);
  await store.move([file('repo-a', 'file:///shared/main.go')], task.id);
  assert.equal(store.listFor('repo-a', 'file:///shared/main.go'), task.id);
  assert.equal(store.listFor('repo-b', 'file:///shared/main.go'), 'default');
  assert.equal(Object.keys(store.serialize().files).length, 2);
  assert.equal(store.sync([
    snapshot('repo-a', [], [change('file:///shared/main.go')]),
    snapshot('repo-b', [change('file:///shared/main.go')])
  ]), false);
});

test('new changes follow active list while existing changes retain their membership', async () => {
  const store = new ChangelistStore(storage());
  store.sync([snapshot('repo', [change('file:///old')])]);
  const task = await store.create('New work');
  await store.setActive(task.id);
  store.sync([snapshot('repo', [change('file:///old'), change('file:///new')], [], [change('file:///conflict')])]);
  await store.flush();
  assert.equal(store.listFor('repo', 'file:///old'), 'default');
  assert.equal(store.listFor('repo', 'file:///new'), task.id);
  assert.equal(store.listFor('repo', 'file:///conflict'), task.id);
});

test('clean files are removed but empty lists and their active state are retained', async () => {
  const state = storage();
  const store = new ChangelistStore(state);
  const task = await store.create('Task');
  await store.setActive(task.id);
  store.sync([snapshot('repo', [change('file:///modified')])]);
  await store.flush();
  assert.equal(store.sync([]), true);
  await store.flush();
  assert.equal(store.lists.length, 2);
  assert.equal(store.activeId, task.id);
  assert.deepEqual(store.serialize().files, {});
  assert.equal(store.sync([]), false);
});

test('rename inherits original URI membership before clean source membership is removed', async () => {
  const store = new ChangelistStore(storage());
  const task = await store.create('Rename work');
  store.sync([snapshot('repo', [change('file:///old')])]);
  await store.move([file('repo', 'file:///old')], task.id);
  store.sync([snapshot('repo', [], [change('file:///new', { status: 3, originalUri: uri('file:///old') })])]);
  await store.flush();
  assert.equal(store.listFor('repo', 'file:///new'), task.id);
  assert.equal(Object.hasOwn(store.serialize().files, JSON.stringify(['repo', 'file:///old'])), false);
});

test('staged rename destination remains assigned when Git later switches to destination URI', async () => {
  const state = storage();
  const store = new ChangelistStore(state);
  const task = await store.create('Rename work');
  store.sync([snapshot('repo', [change('file:///old')])]);
  await store.move([file('repo', 'file:///old')], task.id);
  store.sync([snapshot('repo', [], [change('file:///old', { status: 3, renameUri: uri('file:///new') })])]);
  await store.flush();
  const reloaded = new ChangelistStore(state);
  reloaded.sync([snapshot('repo', [change('file:///new')])]);
  await reloaded.flush();
  assert.equal(reloaded.listFor('repo', 'file:///new'), task.id);
  assert.equal(Object.keys(reloaded.serialize().files).length, 1);
});

test('existing destination membership wins over an original URI alias', async () => {
  const store = new ChangelistStore(storage());
  const task = await store.create('Destination work');
  store.sync([snapshot('repo', [change('file:///old'), change('file:///new')])]);
  await store.move([file('repo', 'file:///new')], task.id);
  store.sync([snapshot('repo', [change('file:///new', { status: 10, originalUri: uri('file:///old') })])]);
  await store.flush();
  assert.equal(store.listFor('repo', 'file:///new'), task.id);
});

test('moving a staged renamed file updates destination membership before Git switches URI', async () => {
  const store = new ChangelistStore(storage());
  const task = await store.create('Rename work');
  store.sync([snapshot('repo', [], [change('file:///old', { status: 3, renameUri: uri('file:///new') })])]);
  await store.move([file('repo', 'file:///old')], task.id);
  assert.equal(store.listFor('repo', 'file:///old'), task.id);
  assert.equal(store.listFor('repo', 'file:///new'), task.id);
  store.sync([snapshot('repo', [change('file:///new')])]);
  await store.flush();
  assert.equal(store.listFor('repo', 'file:///new'), task.id);
});

test('deleting list moves its files to default and resets active only when needed', async () => {
  const state = storage();
  const store = new ChangelistStore(state);
  const task = await store.create('Task');
  const other = await store.create('Other');
  await store.setActive(task.id);
  store.sync([snapshot('repo', [change('file:///file')])]);
  await store.remove(other.id);
  assert.equal(store.activeId, task.id);
  await store.remove(task.id);
  assert.equal(store.activeId, 'default');
  assert.equal(store.listFor('repo', 'file:///file'), 'default');
  assert.deepEqual(new ChangelistStore(state).lists, [{ id: 'default', name: 'Default' }]);
});

test('moving files only writes workspace state and invalid batches do not move any files', async () => {
  const state = storage();
  const store = new ChangelistStore(state);
  const task = await store.create('Task');
  let gitCalls = 0;
  const selected = { ...file('repo', 'file:///file'), add() { gitCalls++; }, clean() { gitCalls++; } };
  await store.move([selected], task.id);
  const baseline = store.serialize();
  await assert.rejects(store.move([file('repo', 'file:///other'), {}], task.id), /valid files/);
  await assert.rejects(store.move([selected], 'missing'), /not found/);
  assert.deepEqual(store.serialize(), baseline);
  assert.equal(await store.move([selected], task.id), false);
  assert.equal(await store.move([], task.id), false);
  assert.equal(gitCalls, 0);
});

test('serialized writes remain ordered when a sync is followed immediately by an async change', async () => {
  const data = new Map();
  const writes = [];
  const state = {
    get: key => data.get(key),
    async update(key, value) {
      await new Promise(resolve => setTimeout(resolve, writes.length ? 1 : 10));
      writes.push(value);
      data.set(key, structuredClone(value));
    }
  };
  const store = new ChangelistStore(state);
  store.sync([snapshot('repo', [change('file:///file')])]);
  const task = await store.create('Task');
  await store.setActive(task.id);
  assert.equal(writes.length, 3);
  assert.deepEqual(new ChangelistStore(state).serialize(), store.serialize());
});

test('sync persistence failures are visible through flush and lastError and later writes recover', async () => {
  const state = storage();
  let fail = true;
  const update = state.update.bind(state);
  state.update = async (...args) => {
    if (fail) throw new Error('storage unavailable');
    return update(...args);
  };
  const store = new ChangelistStore(state);
  store.sync([snapshot('repo', [change('file:///file')])]);
  await assert.rejects(store.flush(), /storage unavailable/);
  assert.match(store.lastError.message, /storage unavailable/);
  fail = false;
  await store.create('Task');
  assert.equal(store.lastError, undefined);
  assert.deepEqual(new ChangelistStore(state).serialize(), store.serialize());
});

test('malformed stored metadata is repaired without retaining invalid memberships', () => {
  const state = storage({
    version: 1, activeId: 'missing',
    lists: [{ id: 'task', name: 'Task' }, { id: 'duplicate', name: 'TASK' }, { id: 'bad', name: '\n' }],
    files: { [JSON.stringify(['repo', 'file:///valid'])]: 'task', invalid: 'task', [JSON.stringify(['repo', 'file:///gone'])]: 'missing' }
  });
  const store = new ChangelistStore(state);
  assert.deepEqual(store.lists, [{ id: 'default', name: 'Default' }, { id: 'task', name: 'Task' }]);
  assert.equal(store.activeId, 'default');
  assert.deepEqual(store.serialize().files, { [JSON.stringify(['repo', 'file:///valid'])]: 'task' });
});

test('a partially initialized workspace preserves membership in repositories not yet ready', async () => {
  const state = storage();
  const first = new ChangelistStore(state);
  const task = await first.create('Task');
  await first.setActive(task.id);
  first.sync([
    snapshot('repo-a', [change('file:///a/file')]),
    snapshot('repo-b', [change('file:///b/file')])
  ]);
  await first.flush();
  const store = new ChangelistStore(state);
  assert.equal(store.sync([], new Set()), false);
  assert.equal(store.sync([snapshot('repo-a', [change('file:///a/file')])], new Set(['repo-a'])), false);
  assert.equal(store.listFor('repo-b', 'file:///b/file'), task.id);
  assert.equal(store.sync([], new Set(['repo-a'])), true);
  await store.flush();
  assert.equal(store.listFor('repo-a', 'file:///a/file'), 'default');
  assert.equal(new ChangelistStore(state).listFor('repo-b', 'file:///b/file'), task.id);
  assert.equal(store.sync([], new Set(['repo-b'])), true);
  await store.flush();
  assert.deepEqual(store.serialize().files, {});
});

test('copies never inherit their source membership while both rename statuses do', async () => {
  for (const status of [3, 4, 5, 10]) {
    const store = new ChangelistStore(storage());
    const task = await store.create('Source task');
    store.sync([snapshot('repo', [change('file:///old')])]);
    await store.move([file('repo', 'file:///old')], task.id);
    store.sync([snapshot('repo', [], [change('file:///new', { status, originalUri: uri('file:///old') })])]);
    await store.flush();
    assert.equal(store.listFor('repo', 'file:///new'), [3, 10].includes(status) ? task.id : 'default');
  }
});

test('name length limit accepts 80 Unicode characters and rejects longer names', async () => {
  const store = new ChangelistStore(storage());
  assert.equal((await store.create('字'.repeat(80))).name.length, 80);
  assert.equal([...(await store.create('😀'.repeat(80))).name].length, 80);
  await assert.rejects(store.create('字'.repeat(81)), /80 characters or fewer/);
});
