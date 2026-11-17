'use strict';

require('../src/i18n').setLanguage('zh-cn');

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { collectRepositories } = require('../src/changes');
const { buildTree } = require('../src/tree');

const fixtureRoot = path.join(path.parse(process.cwd()).root, 'repolens-tree-fixtures');

function uri(fsPath) {
  return { fsPath, path: fsPath.split(path.sep).join('/'), toString: () => `file:${fsPath}` };
}

function repository(name, branch = 'feature/example') {
  return {
    rootUri: uri(path.join(fixtureRoot, name)),
    state: { HEAD: { name: branch }, workingTreeChanges: [], indexChanges: [], mergeChanges: [], untrackedChanges: [] }
  };
}

function change(repo, name, status) {
  const resource = uri(path.join(repo.rootUri.fsPath, name));
  return { uri: resource, originalUri: resource, status };
}

function descendants(item) {
  return [item, ...item.children.flatMap(descendants)];
}

function category(tree, label) {
  return tree.roots.find(root => root.label === label);
}

function repoGroup(root, name) {
  return root.children.find(item => item.label === name);
}

function mixedFixture() {
  const alpha = repository('alpha', 'feature/Hot-Path');
  alpha.state.workingTreeChanges = [change(alpha, 'biz/service/one.go', 5), change(alpha, 'biz/service/two.go', 5), change(alpha, 'new.txt', 7)];
  alpha.state.indexChanges = [change(alpha, 'biz/service/one.go', 0)];
  alpha.state.untrackedChanges = [change(alpha, 'ignored.txt', 8)];
  alpha.state.mergeChanges = [change(alpha, 'conflict.go', 18)];
  const beta = repository('beta', 'release/stable');
  beta.state.indexChanges = [change(beta, 'staged.go', 1)];
  return collectRepositories([beta, alpha]);
}

test('creates GoLand-style sections in conflict, tracked, untracked order', () => {
  const tree = buildTree(mixedFixture());
  assert.deepEqual(tree.roots.map(root => root.label), ['合并冲突', '变更', '未跟踪']);
  assert.equal(tree.totalFiles, 6);
  assert.equal(tree.matchedFiles, 6);
  assert.equal(tree.files.length, 7, 'Stage/work rows remain distinct');
  assert.equal(tree.repositoryCount, 2);
  assert.equal(category(tree, '合并冲突').expandByDefault, true);
  assert.equal(category(tree, '变更').count, 3);
  assert.equal(category(tree, '未跟踪').count, 2);
});

test('creates stage subgroups only for repositories with both tracked stages', () => {
  const tree = buildTree(mixedFixture(), { mode: 'list' });
  const tracked = category(tree, '变更');
  const alpha = repoGroup(tracked, 'alpha');
  assert.deepEqual(alpha.children.map(item => item.type), ['stage', 'stage']);
  assert.deepEqual(alpha.children.map(item => item.label), ['工作区', '已暂存']);
  assert.equal(alpha.count, 2);
  const beta = repoGroup(tracked, 'beta');
  assert.equal(beta.children[0].type, 'file');
  assert.match(beta.description, /stable/);
  assert.match(beta.description, /已暂存/);
});

test('compacts single-chain relative directories without changing file scope', () => {
  const repo = repository('alpha');
  repo.state.workingTreeChanges = [change(repo, 'src/services/api/new.go', 5), change(repo, 'src/services/api/old.go', 5)];
  const tree = buildTree(collectRepositories([repo]));
  const group = tree.roots[0].children[0];
  assert.equal(group.children.length, 1);
  const folder = group.children[0];
  assert.equal(folder.type, 'folder');
  assert.equal(folder.label, 'src/services/api');
  assert.deepEqual(folder.children.map(item => item.label), ['new.go', 'old.go']);
  assert.equal(folder.count, 2);
  assert.deepEqual(new Set(folder.fileIds), new Set(tree.files.map(file => file.id)));
  assert.equal([...tree.nodeById.values()].filter(item => item.type === 'folder').length, 1);
});

test('list mode has only repository-relative parent descriptions and tree mode has no repeated path descriptions', () => {
  const repo = repository('alpha');
  repo.state.workingTreeChanges = [change(repo, 'src/main.go', 5), change(repo, 'README.md', 5)];
  const snapshots = collectRepositories([repo]);
  const list = buildTree(snapshots, { mode: 'list' });
  assert.equal(list.files.find(file => file.label === 'main.go').description, 'src');
  assert.equal(list.files.find(file => file.label === 'README.md').description, '');
  assert.ok(list.roots[0].children[0].children.every(item => item.type === 'file'));
  const tree = buildTree(snapshots, { mode: 'tree' });
  assert.ok(tree.files.every(file => file.description === ''));
  for (const item of [...list.nodeById.values(), ...tree.nodeById.values()]) {
    assert.ok(!item.description.includes(fixtureRoot));
    assert.equal(path.isAbsolute(item.description), false);
  }
});

test('search matches repository name, full branch, and relative path case-insensitively', () => {
  const snapshots = mixedFixture();
  const byName = buildTree(snapshots, { filterText: 'ALPHA' });
  assert.equal(byName.repositoryCount, 1);
  assert.equal(byName.matchedFiles, 5);
  const byBranch = buildTree(snapshots, { filterText: 'FEATURE/HOT' });
  assert.deepEqual(new Set(byBranch.files.map(file => file.id)), new Set(byName.files.map(file => file.id)));
  const byPath = buildTree(snapshots, { filterText: 'BIZ/SERVICE', collapseThreshold: 1 });
  assert.equal(byPath.matchedFiles, 2);
  assert.equal(byPath.files.length, 3);
  assert.ok([...byPath.nodeById.values()].filter(item => item.type !== 'file').every(item => item.expandByDefault));
  const windowsPath = buildTree(snapshots, { filterText: 'biz\\service' });
  assert.equal(windowsPath.matchedFiles, 2);
});

test('status filters select sections and keep total count independent of filtering', () => {
  const snapshots = mixedFixture();
  for (const [filterStatus, label, matched] of [['conflict', '合并冲突', 1], ['tracked', '变更', 3], ['untracked', '未跟踪', 2]]) {
    const tree = buildTree(snapshots, { filterStatus });
    assert.deepEqual(tree.roots.map(item => item.label), [label]);
    assert.equal(tree.matchedFiles, matched);
    assert.equal(tree.totalFiles, 6);
  }
  const noMatches = buildTree(snapshots, { filterText: 'absent-file-name' });
  assert.deepEqual(noMatches.roots, []);
  assert.equal(noMatches.nodeById.size, 0);
  assert.equal(noMatches.matchedFiles, 0);
  assert.equal(noMatches.repositoryCount, 0);
  assert.equal(noMatches.totalFiles, 6);
});

test('file IDs survive mode, branch, filtering, and untracked-to-tracked transitions', () => {
  const repo = repository('alpha');
  const item = change(repo, 'src/main.go', 7);
  repo.state.workingTreeChanges = [item];
  let snapshots = collectRepositories([repo]);
  const first = buildTree(snapshots).files[0];
  assert.equal(buildTree(snapshots, { mode: 'list' }).files[0].id, first.id);
  assert.equal(buildTree(snapshots, { filterText: 'main.go' }).files[0].id, first.id);
  repo.state.HEAD.name = 'feature/renamed';
  repo.state.workingTreeChanges = [{ ...item, status: 5 }];
  repo.state.indexChanges = [{ ...item, status: 0 }];
  snapshots = collectRepositories([repo]);
  const final = buildTree(snapshots);
  assert.equal(final.files.find(file => file.kind === 'working').id, first.id);
  assert.notEqual(final.files.find(file => file.kind === 'index').id, first.id);
  assert.equal(new Set(final.files.map(file => file.id)).size, 2);
});

test('all counts use repository and URI while stage/work rows remain independently selectable', () => {
  const parent = repository('parent');
  const nested = repository(path.join('parent', 'nested'));
  const item = change(nested, 'main.go', 5);
  parent.state.workingTreeChanges = [item];
  nested.state.workingTreeChanges = [item];
  nested.state.indexChanges = [{ ...item, status: 0 }];
  const tree = buildTree(collectRepositories([parent, nested]), { mode: 'list' });
  assert.equal(tree.totalFiles, 2);
  assert.equal(tree.matchedFiles, 2);
  assert.equal(tree.files.length, 3);
  assert.equal(tree.roots[0].count, 2);
  const group = repoGroup(tree.roots[0], 'nested');
  assert.equal(group.count, 1);
  assert.equal(group.fileIds.length, 2);
  assert.ok(group.fileIds.every(fileId => tree.nodeById.get(fileId).type === 'file'));
});

test('all category sections stay expanded while large repositories collapse and search opens matched ancestors', () => {
  const large = repository('large');
  large.state.workingTreeChanges = Array.from({ length: 20 }, (_, index) => change(large, `src/${index}.go`, 5));
  large.state.untrackedChanges = Array.from({ length: 20 }, (_, index) => change(large, `tmp/${index}.txt`, 7));
  const small = repository('small');
  small.state.workingTreeChanges = [change(small, 'one.go', 5)];
  const snapshots = collectRepositories([small, large]);
  const tree = buildTree(snapshots);
  assert.equal(repoGroup(category(tree, '变更'), 'large').expandByDefault, false);
  assert.equal(repoGroup(category(tree, '变更'), 'small').expandByDefault, true);
  assert.equal(category(tree, '未跟踪').expandByDefault, true);
  assert.equal(repoGroup(category(tree, '未跟踪'), 'large').expandByDefault, false);
  assert.ok(tree.roots.every(root => root.expandByDefault));
  const search = buildTree(snapshots, { filterText: 'LARGE' });
  assert.ok([...search.nodeById.values()].filter(item => item.type !== 'file').every(item => item.expandByDefault));
});

test('selection scopes contain only descendant file IDs and conflicts never expose a bulk scope', () => {
  const tree = buildTree(mixedFixture());
  for (const root of tree.roots) {
    for (const item of descendants(root)) {
      assert.equal(tree.nodeById.get(item.id), item);
      if (item.kind === 'conflict') {
        assert.deepEqual(item.fileIds, []);
      } else {
        const expected = descendants(item).filter(child => child.type === 'file').map(child => child.id);
        assert.deepEqual(new Set(item.fileIds), new Set(expected));
        assert.equal(new Set(item.fileIds).size, item.fileIds.length);
      }
    }
  }
});

test('tree construction preserves snapshots and original Change objects', () => {
  const snapshots = mixedFixture();
  const firstChange = snapshots[0].working[0];
  const before = JSON.stringify(snapshots);
  const result = buildTree(snapshots);
  assert.equal(JSON.stringify(snapshots), before);
  assert.equal(result.files.find(file => file.change === firstChange).change, firstChange);
});

test('empty snapshots return an empty data model', () => {
  const tree = buildTree([]);
  assert.deepEqual(tree.roots, []);
  assert.deepEqual(tree.files, []);
  assert.equal(tree.nodeById.size, 0);
  assert.equal(tree.totalFiles, 0);
  assert.equal(tree.matchedFiles, 0);
  assert.equal(tree.repositoryCount, 0);
});

const changelistOptions = (extra = {}) => ({
  grouping: 'changelist',
  changelists: [{ id: 'default', name: 'Default' }, { id: 'task', name: 'Checkout fix' }, { id: 'empty', name: 'Empty task' }],
  activeListId: 'task',
  ...extra
});

test('status remains the default grouping even when changelist definitions are available', () => {
  const options = changelistOptions();
  delete options.grouping;
  const tree = buildTree(mixedFixture(), options);
  assert.deepEqual(tree.roots.map(node => node.label), ['合并冲突', '变更', '未跟踪']);
  assert.ok(tree.roots.every(node => node.type === 'category'));
});

test('changelists keep conflicts first, retain empty lists and aggregate multiple repositories', () => {
  const tree = buildTree(mixedFixture(), changelistOptions({ listFor: () => 'task' }));
  assert.deepEqual(tree.roots.map(node => node.label), ['合并冲突', '默认变更', 'Checkout fix', 'Empty task']);
  const conflict = tree.roots[0];
  assert.equal(conflict.kind, 'conflict');
  assert.deepEqual(conflict.fileIds, []);
  const task = tree.roots.find(node => node.listId === 'task');
  assert.equal(task.type, 'changelist');
  assert.equal(task.active, true);
  assert.equal(task.count, 5);
  assert.equal(task.children.length, 2);
  assert.match(task.description, /当前/);
  assert.equal(tree.roots.find(node => node.listId === 'empty').count, 0);
  assert.ok(tree.roots.find(node => node.listId === 'empty').expandByDefault);
  assert.equal(tree.files.filter(file => file.kind === 'conflict').length, 1);
  assert.equal(tree.matchedFiles, 6);
  assert.equal(tree.totalFiles, 6);
});

test('each changelist has unique phase nodes when the same repository has mixed staged and working files', () => {
  const repo = repository('alpha');
  repo.state.workingTreeChanges = [change(repo, 'a.go', 5), change(repo, 'b.go', 5)];
  repo.state.indexChanges = [change(repo, 'a.go', 0), change(repo, 'b.go', 0)];
  const tree = buildTree(collectRepositories([repo]), changelistOptions({
    mode: 'list', listFor: (_key, resource) => resource.endsWith('/a.go') ? 'task' : 'default'
  }));
  const all = tree.roots.flatMap(descendants);
  assert.equal(new Set(all.map(node => node.id)).size, all.length, 'Tree item IDs must be unique across changelists');
  assert.equal(tree.nodeById.size, all.length);
  for (const [listId, label] of [['task', 'a.go'], ['default', 'b.go']]) {
    const list = tree.roots.find(node => node.listId === listId);
    assert.equal(list.count, 1);
    assert.equal(list.fileIds.length, 2);
    const group = list.children[0];
    assert.deepEqual(group.children.map(node => node.kind), ['working', 'index']);
    assert.deepEqual(group.children.flatMap(node => node.children.map(file => file.label)), [label, label]);
    for (const phase of group.children) assert.equal(tree.nodeById.get(phase.id), phase);
  }
});

test('status and path filters operate inside changelists without retaining empty task rows', () => {
  const snapshots = mixedFixture();
  const options = changelistOptions({ listFor: () => 'task' });
  const untracked = buildTree(snapshots, { ...options, filterStatus: 'untracked' });
  assert.deepEqual(untracked.roots.map(node => node.label), ['Checkout fix']);
  assert.equal(untracked.matchedFiles, 2);
  assert.ok(untracked.files.every(file => [7, 8].includes(file.change.status)));
  const conflict = buildTree(snapshots, { ...options, filterStatus: 'conflict' });
  assert.deepEqual(conflict.roots.map(node => node.label), ['合并冲突']);
  const path = buildTree(snapshots, { ...options, filterText: 'BIZ/SERVICE' });
  assert.deepEqual(path.roots.map(node => node.label), ['Checkout fix']);
  assert.equal(path.matchedFiles, 2);
  assert.equal(path.files.length, 3);
  assert.ok(path.roots.flatMap(descendants).filter(node => node.children.length).every(node => node.expandByDefault));
  assert.equal(path.totalFiles, 6);
});

test('file IDs and original changes survive switching between status and changelist grouping', () => {
  const snapshots = mixedFixture();
  const before = JSON.stringify(snapshots);
  const status = buildTree(snapshots);
  const lists = buildTree(snapshots, changelistOptions({ listFor: () => 'task' }));
  assert.deepEqual(new Set(lists.files.map(file => file.id)), new Set(status.files.map(file => file.id)));
  assert.deepEqual(lists.files.map(file => file.change).sort((a, b) => a.uri.toString().localeCompare(b.uri.toString())),
    status.files.map(file => file.change).sort((a, b) => a.uri.toString().localeCompare(b.uri.toString())));
  assert.equal(JSON.stringify(snapshots), before);
});
