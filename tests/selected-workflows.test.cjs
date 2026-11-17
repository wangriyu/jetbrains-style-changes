'use strict';

const assert = require('node:assert/strict');
const { test, beforeEach } = require('node:test');
const { createWorkflows } = require('../src/workflows');
const { setLanguage } = require('../src/i18n');

beforeEach(() => setLanguage('zh-cn'));

const uri = fsPath => ({ scheme: 'file', fsPath, path: fsPath, toString() { return `file://${fsPath}`; } });
const change = (fsPath, status, extra = {}) => ({ uri: uri(fsPath), status, ...extra });
const repository = (root, state = {}) => ({
  rootUri: uri(root),
  state: {
    HEAD: { name: 'feature/work', commit: 'baseline', type: 0 },
    workingTreeChanges: [], indexChanges: [], untrackedChanges: [], mergeChanges: [], submodules: [],
    ...state,
  },
});

function fixture(options = {}) {
  const root = '/workspace/repo';
  const repo = repository(root, {
    workingTreeChanges: [change(`${root}/a.go`, 5)],
    indexChanges: [change(`${root}/a.go`, 0), change(`${root}/unselected.go`, 0)],
    untrackedChanges: [change(`${root}/new.go`, 7)],
  });
  const repositories = options.repositories || [repo];
  const calls = { prepare: [], commit: [], stash: [], native: [], inputs: [], warnings: [], picks: [], info: [], errors: [], refresh: 0, status: 0 };
  let selection = [];
  let available = true;
  const api = {
    git: { path: '/usr/bin/git' },
    get repositories() {
      return repositories.map(entry => ({
        rootUri: entry.rootUri, get state() { return entry.state; },
        async status() { calls.status++; if (options.onStatus) await options.onStatus(repositories, calls); },
        async add(...args) { calls.native.push(['add', ...args]); throw new Error('Unexpected native stage'); },
        async revert(...args) { calls.native.push(['revert', ...args]); throw new Error('Unexpected native unstage'); },
        async commit(...args) { calls.native.push(['commit', ...args]); throw new Error('Unexpected whole-index commit'); },
      }));
    },
  };
  const selectedGit = {
    async prepareSelection(arguments_) {
      calls.prepare.push(arguments_);
      if (options.prepareError) throw new Error(options.prepareError);
      if (options.onPrepare) await options.onPrepare(repositories, calls);
      return `selection-token-${calls.prepare.length}`;
    },
    async commitSelected(arguments_) {
      calls.commit.push(arguments_);
      if (options.writeError) throw new Error(options.writeError);
      return { commit: 'fixture-commit', files: arguments_.files };
    },
    async stashSelected(arguments_) {
      calls.stash.push(arguments_);
      if (options.writeError) throw new Error(options.writeError);
      return { stash: 'fixture-stash', files: arguments_.files };
    },
  };
  const vscode = {
    workspace: { textDocuments: options.documents || [] },
    window: {
      async showQuickPick(items, details) {
        calls.picks.push({ items, details });
        if (options.pick) return options.pick(items, repositories, calls);
        return options.cancel === 'pick' ? undefined : items[0];
      },
      async showInputBox(details) {
        calls.inputs.push(details);
        if (options.input) return options.input(repositories, calls);
        return options.cancel === 'input' ? undefined : options.message ?? 'test selected files';
      },
      async showWarningMessage(message, details, ...actions) {
        calls.warnings.push({ message, details, actions });
        if (options.confirm) return options.confirm({ repositories, calls, actions, dispose: () => { available = false; } });
        return options.cancel === 'confirm' ? undefined : actions[0];
      },
      async showInformationMessage(message) { calls.info.push(message); },
      async showErrorMessage(message) { calls.errors.push(message); },
    },
    commands: { async executeCommand(...args) { calls.native.push(args); throw new Error('Unexpected native command'); } },
  };
  const workflows = createWorkflows({
    vscode, selectedGit, getGit: () => available ? api : undefined,
    getSelectedNodes: () => selection,
    getNodeFiles: node => node?.type === 'file' ? [node] : node?.files || [],
    refresh: async () => { calls.refresh++; },
  });
  const node = (name = 'a.go', kind = 'working', entry = repositories[0]) => ({
    type: 'file', repoKey: entry.rootUri.toString(), kind,
    uri: uri(`${entry.rootUri.fsPath}/${name}`), change: { status: 18 },
  });
  return { workflows, calls, repositories, node, vscode, select: nodes => { selection = nodes; } };
}

const writes = calls => calls.commit.length + calls.stash.length + calls.native.length;
const sorted = values => [...values].sort();

test('empty selected commit and stash never mutate a repository', async () => {
  const f = fixture();
  await f.workflows.commitSelected();
  await f.workflows.stashSelected();
  assert.equal(writes(f.calls), 0);
  assert.equal(f.calls.prepare.length, 0);
  assert.equal(f.calls.inputs.length + f.calls.warnings.length, 0);
});

test('selected commit deduplicates working and index rows and forwards the confirmed preparation token', async () => {
  const f = fixture();
  f.select([f.node(), f.node('a.go', 'index'), f.node()]);
  await f.workflows.commitSelected();
  assert.equal(f.calls.prepare.length, 1);
  assert.equal(f.calls.commit.length, 1);
  assert.deepEqual(f.calls.commit[0].files, ['/workspace/repo/a.go']);
  assert.equal(f.calls.commit[0].root, '/workspace/repo');
  assert.equal(f.calls.commit[0].expected, 'selection-token-1');
  assert.equal(f.calls.commit[0].message, 'test selected files');
  assert.equal(f.calls.native.length, 0, 'Selected commit must not use the whole-index/native commit entry');
  assert.equal(f.calls.refresh, 1);
});

test('an index-row selection still commits the full current file with an explicit scope confirmation', async () => {
  const f = fixture();
  await f.workflows.commitSelected(f.node('a.go', 'index'));
  assert.equal(f.calls.commit.length, 1);
  assert.deepEqual(f.calls.commit[0].files, ['/workspace/repo/a.go']);
  const confirmation = f.calls.warnings.map(item => `${item.message}\n${item.details?.detail || ''}`).join('\n');
  assert.match(confirmation, /feature\/work/);
  assert.match(confirmation, /a\.go/);
  assert.match(confirmation, /完整|整文件|全部内容/);
  assert.match(confirmation, /未暂存/);
});

test('a group action uses only its explicit live descendant paths', async () => {
  const f = fixture();
  f.select([f.node('unselected.go', 'index')]);
  await f.workflows.stashSelected({ type: 'group', files: [f.node(), f.node('new.go')] });
  assert.equal(f.calls.stash.length, 1);
  assert.deepEqual(sorted(f.calls.stash[0].files), ['/workspace/repo/a.go', '/workspace/repo/new.go']);
  assert.equal(f.calls.stash[0].expected, 'selection-token-1');
  assert.equal(f.calls.native.length, 0);
});

test('selected commit and stash only pass selected paths, preserving unrelated staged scope', async () => {
  for (const method of ['commitSelected', 'stashSelected']) {
    const f = fixture();
    f.select([f.node()]);
    await f.workflows[method]();
    const action = method === 'commitSelected' ? f.calls.commit[0] : f.calls.stash[0];
    assert.deepEqual(action.files, ['/workspace/repo/a.go']);
    assert.equal(action.files.includes('/workspace/repo/unselected.go'), false);
    assert.equal(f.calls.native.length, 0);
  }
});

test('multi-repository selection requires a choice and operates on exactly the chosen repository', async () => {
  const other = repository('/workspace/other', { workingTreeChanges: [change('/workspace/other/b.go', 5)] });
  for (const method of ['commitSelected', 'stashSelected']) {
    const f = fixture({ pick(items) { return items.find(item => item.repoKey === other.rootUri.toString()); } });
    f.repositories.push(other);
    f.select([f.node(), f.node('b.go', 'working', other)]);
    await f.workflows[method]();
    assert.equal(f.calls.picks.length, 1);
    assert.equal(f.calls.picks[0].items.length, 2);
    const actions = method === 'commitSelected' ? f.calls.commit : f.calls.stash;
    assert.equal(actions.length, 1);
    assert.equal(actions[0].root, '/workspace/other');
    assert.deepEqual(actions[0].files, ['/workspace/other/b.go']);
    assert.equal(f.calls.native.length, 0);
  }
});

test('cancelling repository, message or confirmation performs no selected Git write', async () => {
  for (const method of ['commitSelected', 'stashSelected']) {
    for (const cancel of ['pick', 'input', 'confirm']) {
      const f = fixture({ cancel });
      if (cancel === 'pick') {
        const other = repository('/workspace/other', { workingTreeChanges: [change('/workspace/other/b.go', 5)] });
        f.repositories.push(other);
        f.select([f.node(), f.node('b.go', 'working', other)]);
      } else f.select([f.node()]);
      await f.workflows[method]();
      assert.equal(writes(f.calls), 0, `${method}: cancel ${cancel}`);
    }
  }
});

test('selected dirty documents must be saved explicitly before commit or stash', async () => {
  for (const method of ['commitSelected', 'stashSelected']) {
    let saves = 0;
    const f = fixture({ documents: [{ uri: uri('/workspace/repo/a.go'), isDirty: true, async save() { saves++; } }] });
    f.select([f.node()]);
    await f.workflows[method]();
    assert.equal(writes(f.calls), 0);
    assert.equal(f.calls.prepare.length, 0);
    assert.equal(saves, 0);
    assert.ok(f.calls.info.length + f.calls.errors.length > 0);
  }
});

test('an unrelated dirty editor is not saved or included in selected actions', async () => {
  let saves = 0;
  const f = fixture({ documents: [{ uri: uri('/workspace/repo/unselected.go'), isDirty: true, async save() { saves++; } }] });
  await f.workflows.commitSelected(f.node());
  assert.equal(f.calls.commit.length, 1);
  assert.equal(saves, 0);
  assert.deepEqual(f.calls.commit[0].files, ['/workspace/repo/a.go']);
});

test('conflict, rebase, stale file and wrong-kind selections never reach a mutation', async () => {
  for (const method of ['commitSelected', 'stashSelected']) {
    for (const condition of ['conflict', 'rebase', 'missing', 'stale-kind', 'submodule']) {
      const f = fixture();
      if (condition === 'conflict') f.repositories[0].state.mergeChanges.push(change('/workspace/repo/a.go', 16));
      if (condition === 'rebase') f.repositories[0].state.rebaseCommit = { hash: 'rebase' };
      if (condition === 'submodule') f.repositories[0].state.submodules = [{ path: 'a.go' }];
      await f.workflows[method](condition === 'missing' ? f.node('missing.go')
        : condition === 'stale-kind' ? f.node('new.go', 'index') : f.node());
      assert.equal(writes(f.calls), 0, `${method}: ${condition}`);
    }
  }
});

test('the whole selection validates before a repository is chosen or a write is prepared', async () => {
  const f = fixture();
  f.select([f.node(), f.node('missing.go')]);
  await f.workflows.commitSelected();
  assert.equal(writes(f.calls), 0);
  assert.equal(f.calls.prepare.length, 0);
});

test('nested repository paths cannot be acted on through a parent repository key', async () => {
  const f = fixture();
  const child = repository('/workspace/repo/child', { workingTreeChanges: [change('/workspace/repo/child/a.go', 5)] });
  f.repositories.push(child);
  await f.workflows.stashSelected({ ...f.node(), uri: uri('/workspace/repo/child/a.go') });
  assert.equal(writes(f.calls), 0);
  assert.equal(f.calls.prepare.length, 0);
});

test('a real rename passes both old and new paths to selected Git operations', async () => {
  for (const method of ['commitSelected', 'stashSelected']) {
    const repo = repository('/workspace/repo', {
      indexChanges: [change('/workspace/repo/new.go', 3, { originalUri: uri('/workspace/repo/old.go'), renameUri: uri('/workspace/repo/new.go') })],
    });
    const f = fixture({ repositories: [repo] });
    await f.workflows[method](f.node('new.go', 'index'));
    const actions = method === 'commitSelected' ? f.calls.commit : f.calls.stash;
    assert.equal(actions.length, 1);
    assert.deepEqual(sorted(actions[0].files), ['/workspace/repo/new.go', '/workspace/repo/old.go']);
  }
});

test('copying a file never includes the unselected original source path', async () => {
  const repo = repository('/workspace/repo', {
    indexChanges: [change('/workspace/repo/copied.go', 4, { originalUri: uri('/workspace/repo/source.go') })],
    workingTreeChanges: [change('/workspace/repo/source.go', 5)],
  });
  const f = fixture({ repositories: [repo] });
  await f.workflows.commitSelected(f.node('copied.go', 'index'));
  assert.equal(f.calls.commit.length, 1);
  assert.deepEqual(f.calls.commit[0].files, ['/workspace/repo/copied.go']);
});

test('rename paths outside the chosen repository are rejected before preparation', async () => {
  const repo = repository('/workspace/repo', {
    indexChanges: [change('/workspace/repo/new.go', 3, { originalUri: uri('/workspace/outside.go') })],
  });
  const f = fixture({ repositories: [repo] });
  await f.workflows.commitSelected(f.node('new.go', 'index'));
  assert.equal(writes(f.calls), 0);
  assert.equal(f.calls.prepare.length, 0);
});

test('a rename refreshed before prompting never forwards its stale original path', async () => {
  const repo = repository('/workspace/repo', {
    indexChanges: [change('/workspace/repo/new.go', 3, { originalUri: uri('/workspace/repo/old.go') })],
  });
  const f = fixture({ repositories: [repo], onStatus(repositories, calls) {
    if (calls.status === 1) repositories[0].state.indexChanges[0].originalUri = uri('/workspace/repo/current-old.go');
  } });
  await f.workflows.commitSelected(f.node('new.go', 'index'));
  if (f.calls.commit.length) {
    assert.deepEqual(sorted(f.calls.commit[0].files), ['/workspace/repo/current-old.go', '/workspace/repo/new.go']);
  }
  assert.equal(f.calls.native.length, 0);
});

test('confirmation-time repository removal, disposal and Git state changes cancel writes', async () => {
  for (const method of ['commitSelected', 'stashSelected']) {
    for (const race of ['removed', 'disposed', 'head', 'index', 'kind', 'conflict', 'rebase', 'dirty']) {
      const f = fixture({ confirm({ repositories, actions, dispose }) {
        if (race === 'removed') repositories.splice(0);
        else if (race === 'disposed') dispose();
        else if (race === 'head') repositories[0].state.HEAD.commit = 'new-head';
        else if (race === 'index') repositories[0].state.indexChanges.push(change('/workspace/repo/later.go', 1));
        else if (race === 'kind') repositories[0].state.workingTreeChanges = [];
        else if (race === 'conflict') repositories[0].state.mergeChanges.push(change('/workspace/repo/a.go', 16));
        else if (race === 'rebase') repositories[0].state.rebaseCommit = {};
        else if (race === 'dirty') f.vscode.workspace.textDocuments.push({ uri: uri('/workspace/repo/a.go'), isDirty: true });
        return actions[0];
      } });
      await f.workflows[method](f.node());
      assert.equal(writes(f.calls), 0, `${method}: ${race}`);
    }
  }
});

test('preparation errors and stale content tokens surface an error without fallback commands', async () => {
  const before = fixture({ prepareError: 'Selected content changed' });
  await before.workflows.commitSelected(before.node());
  assert.equal(writes(before.calls), 0);
  assert.equal(before.calls.errors.length, 1);
  for (const method of ['commitSelected', 'stashSelected']) {
    const f = fixture({ writeError: 'Selection token no longer matches' });
    await f.workflows[method](f.node());
    assert.equal(f.calls.native.length, 0);
    assert.equal(f.calls.commit.length + f.calls.stash.length, 1);
    assert.equal(f.calls.errors.length, 1);
    assert.equal(f.calls.refresh, 0);
  }
});

test('selected action prompts follow the English editor language', async () => {
  setLanguage('en');
  const f = fixture();
  await f.workflows.commitSelected(f.node('a.go', 'index'));
  const text = [...f.calls.inputs.map(item => `${item.title || ''} ${item.prompt || ''}`),
    ...f.calls.warnings.map(item => `${item.message} ${item.details?.detail || ''}`)].join('\n');
  assert.match(text, /commit/i);
  assert.match(text, /whole|entire|full|complete/i);
  assert.match(text, /unstaged/i);
  assert.doesNotMatch(text, /[\u3400-\u9fff]/);
});
