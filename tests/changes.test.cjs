'use strict';

require('../src/i18n').setLanguage('zh-cn');

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { collectRepositories, diffCommand, compactBranch, statusLabel } = require('../src/changes');

const fixtureRoot = path.join(path.parse(process.cwd()).root, 'repolens-fixtures');

class Uri {
  constructor({ scheme = 'file', path: uriPath, fsPath, query = '' }) {
    this.scheme = scheme;
    this.path = uriPath;
    this.fsPath = fsPath || uriPath;
    this.query = query;
  }
  with(changes) { return new Uri({ ...this, ...changes }); }
  toString() { return `${this.scheme}:${this.path}?${this.query}`; }
  static file(fsPath) {
    return new Uri({ path: fsPath.split(path.sep).join('/'), fsPath });
  }
}

const vscode = { Uri: { from: components => new Uri(components) } };
const gitAPI = {
  toGitUri: (uri, ref) => uri.with({ scheme: 'git', query: JSON.stringify({ path: uri.fsPath, ref }) })
};

function repository(name, branch = 'feature/example') {
  return {
    rootUri: Uri.file(path.join(fixtureRoot, name)),
    state: {
      HEAD: { name: branch },
      workingTreeChanges: [], untrackedChanges: [], indexChanges: [], mergeChanges: [], submodules: []
    }
  };
}

function change(repo, name, status, originalName = name) {
  return {
    uri: Uri.file(path.join(repo.rootUri.fsPath, name)),
    originalUri: Uri.file(path.join(repo.rootUri.fsPath, originalName)),
    status
  };
}

function ref(uri) { return JSON.parse(uri.query).ref; }

test('collects sorted dirty repositories, keeps stage/work entries, and counts each file once', () => {
  const admin = repository('admin', 'feature/conflict-demo');
  const shared = change(admin, 'shared.go', 5);
  const untracked = change(admin, 'new.go', 7);
  const conflict = change(admin, 'conflict.go', 18);
  admin.state.mergeInProgress = true;
  admin.state.workingTreeChanges = [shared, untracked, change(admin, 'conflict.go', 5), shared];
  admin.state.untrackedChanges = [untracked, change(admin, 'fresh.go', 7)];
  admin.state.indexChanges = [change(admin, 'shared.go', 0), change(admin, 'staged.go', 1), change(admin, 'conflict.go', 0)];
  admin.state.mergeChanges = [conflict, change(admin, 'both.go', 16), conflict];
  const zulu = repository('zulu');
  zulu.state.workingTreeChanges = [change(zulu, 'main.go', 5)];
  const originalWorking = [...admin.state.workingTreeChanges];

  const rows = collectRepositories([zulu, repository('empty'), admin]);
  assert.deepEqual(rows.map(row => row.name), ['admin', 'zulu']);
  assert.equal(rows[0].key, admin.rootUri.toString());
  assert.equal(rows[0].rootUri, admin.rootUri);
  assert.equal(rows[0].branch, 'feature/conflict-demo');
  assert.equal(rows[0].mergeInProgress, true);
  assert.equal(rows[0].count, 6);
  assert.deepEqual(rows[0].working.map(item => item.status), [5, 7, 7]);
  assert.deepEqual(rows[0].index.map(item => item.status), [0, 1]);
  assert.deepEqual(rows[0].conflicts.map(item => item.status), [18, 16]);
  assert.equal(rows[0].working[0], shared);
  assert.equal(rows[0].conflicts[0], conflict);
  assert.deepEqual(admin.state.workingTreeChanges, originalWorking, 'Collection must not mutate Git state');
});

test('recognizes all conflict statuses even when they arrive in ordinary arrays', () => {
  const repo = repository('conflicts');
  repo.state.workingTreeChanges = [12, 13, 14, 15].map(status => change(repo, `${status}.go`, status));
  repo.state.indexChanges = [16, 17, 18].map(status => change(repo, `${status}.go`, status));
  const [row] = collectRepositories([repo]);
  assert.equal(row.count, 7);
  assert.equal(row.conflicts.length, 7);
  assert.equal(row.working.length, 0);
  assert.equal(row.index.length, 0);
});

test('detached and unborn branches have useful names and equal repository names sort by root', () => {
  const detached = repository(path.join('b', 'same'));
  detached.state.HEAD = { commit: '1234567890abcdef' };
  detached.state.workingTreeChanges = [change(detached, 'a.go', 5)];
  const unborn = repository(path.join('a', 'same'));
  unborn.state.HEAD = undefined;
  unborn.state.untrackedChanges = [change(unborn, 'new.go', 7)];
  const rows = collectRepositories([detached, unborn]);
  assert.equal(rows[0].key, unborn.rootUri.toString());
  assert.equal(rows[0].branch, '未检出分支');
  assert.equal(rows[1].branch, '12345678');
  assert.deepEqual(collectRepositories([]), []);
});

const cases = [
  ['working modification compares index/HEAD with current file', 5, 'working', '~', 'file'],
  ['working new file compares empty content with current file', 7, 'working', 'empty', 'file'],
  ['working deletion compares index/HEAD with empty content', 6, 'working', '~', 'empty'],
  ['staged modification compares HEAD with index', 0, 'index', 'HEAD', ''],
  ['staged rename compares old HEAD path with new index path', 3, 'index', 'HEAD', ''],
  ['staged addition compares empty content with index', 1, 'index', 'empty', ''],
  ['staged copy compares empty content with index', 4, 'index', 'empty', ''],
  ['staged deletion compares HEAD with empty content', 2, 'index', 'HEAD', 'empty'],
  ['merge conflict delegates to native Git', 18, 'conflict', 'native', 'native']
];

for (const [name, status, kind, left, right] of cases) {
  test(name, () => {
    const repo = repository('admin');
    const item = change(repo, 'current.go', status, status === 3 ? 'old.go' : 'current.go');
    const command = diffCommand(vscode, gitAPI, repo, item, kind);
    assert.ok(command.title);
    if (left === 'native') {
      assert.equal(command.command, 'git.openChange');
      assert.deepEqual(command.arguments, [item.uri]);
      return;
    }
    assert.equal(command.command, 'vscode.diff');
    const [original, modified, title] = command.arguments;
    assert.match(title, /current\.go/);
    if (left === 'empty') {
      assert.equal(original.scheme, 'repolens-empty');
      assert.equal(original.path, item.uri.path);
    } else {
      assert.equal(original.scheme, 'git');
      assert.equal(ref(original), left);
    }
    if (right === 'file') assert.equal(modified, item.uri);
    else if (right === 'empty') assert.equal(modified.scheme, 'repolens-empty');
    else {
      assert.equal(modified.scheme, 'git');
      assert.equal(ref(modified), right);
      assert.equal(JSON.parse(modified.query).path, item.uri.fsPath);
    }
    if (status === 3) assert.equal(JSON.parse(original.query).path, item.originalUri.fsPath);
  });
}

test('the default diff kind is working and never aliases a staged comparison', () => {
  const repo = repository('admin');
  const uri = change(repo, 'shared.go', 5);
  const working = diffCommand(vscode, gitAPI, repo, uri);
  const index = diffCommand(vscode, gitAPI, repo, { ...uri, status: 0 }, 'index');
  assert.equal(ref(working.arguments[0]), '~');
  assert.equal(working.arguments[1], uri.uri);
  assert.equal(ref(index.arguments[0]), 'HEAD');
  assert.equal(ref(index.arguments[1]), '');
});

test('new staged files do not require a HEAD commit', () => {
  const repo = repository('unborn');
  repo.state.HEAD = undefined;
  const api = { toGitUri: (uri, revision) => {
    assert.notEqual(revision, 'HEAD');
    return gitAPI.toGitUri(uri, revision);
  } };
  const result = diffCommand(vscode, api, repo, change(repo, 'first.go', 1), 'index');
  assert.equal(result.arguments[0].scheme, 'repolens-empty');
  assert.equal(ref(result.arguments[1]), '');
});

test('intent-to-add and ignored files use an empty working baseline', () => {
  const repo = repository('admin');
  for (const status of [8, 9]) {
    const item = change(repo, 'new.go', status);
    const result = diffCommand(vscode, gitAPI, repo, item);
    assert.equal(result.arguments[0].scheme, 'repolens-empty');
    assert.equal(result.arguments[1], item.uri);
  }
});

test('working intent-to-rename and type changes retain the native HEAD original path', () => {
  const repo = repository('admin');
  for (const status of [10, 11]) {
    const item = change(repo, 'new.go', status, 'old.go');
    const result = diffCommand(vscode, gitAPI, repo, item);
    assert.equal(ref(result.arguments[0]), 'HEAD');
    assert.equal(JSON.parse(result.arguments[0].query).path, item.originalUri.fsPath);
    assert.equal(result.arguments[1], item.uri);
  }
});

test('working modifications use a matching staged rename destination without changing their baseline', () => {
  const repo = repository('admin');
  const item = change(repo, 'old.go', 5);
  const renamed = Uri.file(path.join(repo.rootUri.fsPath, 'renamed.go'));
  repo.state.indexChanges = [{ ...change(repo, 'old.go', 3), renameUri: renamed }];
  const result = diffCommand(vscode, gitAPI, repo, item);
  assert.equal(ref(result.arguments[0]), '~');
  assert.equal(JSON.parse(result.arguments[0].query).path, item.uri.fsPath);
  assert.equal(result.arguments[1], renamed);
});

test('new working files use a matching staged rename destination with an empty baseline', () => {
  const repo = repository('admin');
  const item = change(repo, 'old.go', 7);
  const renamed = Uri.file(path.join(repo.rootUri.fsPath, 'renamed.go'));
  repo.state.indexChanges = [{ ...change(repo, 'old.go', 3), renameUri: renamed }];
  const result = diffCommand(vscode, gitAPI, repo, item);
  assert.equal(result.arguments[0].scheme, 'repolens-empty');
  assert.equal(result.arguments[1], renamed);
});

test('unrelated staged renames do not redirect a file and deletion keeps its empty right side', () => {
  const repo = repository('admin');
  const item = change(repo, 'main.go', 5);
  const renamed = Uri.file(path.join(repo.rootUri.fsPath, 'renamed.go'));
  repo.state.indexChanges = [{ ...change(repo, 'other.go', 3), renameUri: renamed }];
  assert.equal(diffCommand(vscode, gitAPI, repo, item).arguments[1], item.uri);
  repo.state.indexChanges = [{ ...change(repo, 'main.go', 3), renameUri: renamed }];
  assert.equal(diffCommand(vscode, gitAPI, repo, { ...item, status: 6 }).arguments[1].scheme, 'repolens-empty');
});

test('true submodules delegate working and index changes to native Git', () => {
  const repo = repository('admin');
  repo.state.submodules = [{ path: path.join('vendor', 'module') }];
  const item = change(repo, path.join('vendor', 'module'), 5);
  const api = { toGitUri: () => { throw new Error('Submodule directories must not be read as ordinary blobs'); } };
  for (const kind of ['working', 'index']) {
    const result = diffCommand(vscode, api, repo, item, kind);
    assert.equal(result.command, 'git.openChange');
    assert.deepEqual(result.arguments, [item.uri]);
  }
});

test('all conflict statuses and unsupported states keep a native fallback', () => {
  const repo = repository('admin');
  for (const status of [12, 13, 14, 15, 16, 17, 18, 99]) {
    const item = change(repo, 'file.go', status);
    const command = diffCommand(vscode, gitAPI, repo, item);
    assert.equal(command.command, 'git.openChange');
    assert.equal(command.arguments[0], item.uri);
  }
});

test('branch display removes conventional prefixes and bounds long labels', () => {
  assert.equal(compactBranch('feature/example'), 'example');
  assert.equal(compactBranch('feat/example'), 'example');
  assert.equal(compactBranch('bugfix/example'), 'example');
  assert.equal(compactBranch('hotfix/example'), 'example');
  assert.equal(compactBranch('release/2026'), 'release/2026');
  const long = 'x'.repeat(30);
  assert.equal(compactBranch(long), `${long.slice(0, 21)}…`);
  assert.equal(compactBranch(), '未检出分支');
});

test('status labels distinguish staged state and all conflict categories', () => {
  assert.equal(statusLabel(0), '已暂存修改');
  assert.equal(statusLabel(5), '修改');
  assert.equal(statusLabel(7), '未跟踪');
  assert.match(statusLabel(16), /AA/);
  assert.match(statusLabel(18), /UU/);
  const conflictLabels = new Set(Array.from({ length: 7 }, (_, index) => statusLabel(index + 12)));
  assert.equal(conflictLabels.size, 7);
  assert.equal(statusLabel(99), '未知状态');
});
