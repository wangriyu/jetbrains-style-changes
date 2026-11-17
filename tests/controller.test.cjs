'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test, beforeEach } = require('node:test');
const { RepoLensController } = require('../src/controller');
const { setLanguage } = require('../src/i18n');
const { STORAGE_KEY } = require('../src/changelists');

beforeEach(() => setLanguage('zh-cn'));

class Emitter {
  constructor() {
    this.listeners = new Set();
    this.event = (callback, thisArg, disposables) => {
      const entry = { callback, thisArg };
      this.listeners.add(entry);
      const disposable = { dispose: () => this.listeners.delete(entry) };
      if (Array.isArray(disposables)) disposables.push(disposable);
      return disposable;
    };
  }
  fire(value) { for (const entry of [...this.listeners]) entry.callback.call(entry.thisArg, value); }
  dispose() { this.listeners.clear(); }
  get size() { return this.listeners.size; }
}

function uri(filePath) {
  return {
    scheme: 'file', path: filePath, fsPath: filePath, query: '', fragment: '',
    toString() { return `${this.scheme}://${this.path}${this.query ? `?${this.query}` : ''}`; },
    with(values) { return { ...this, ...values }; }
  };
}

function repository(root, entries = {}) {
  const stateEvents = new Emitter();
  return {
    rootUri: uri(root), stateEvents,
    state: {
      HEAD: { name: 'feature/work', commit: 'abcdef1234', type: 0 },
      mergeChanges: [], workingTreeChanges: [], indexChanges: [], untrackedChanges: [], submodules: [],
      ...entries,
      onDidChange: stateEvents.event,
    },
  };
}

const change = (filePath, status) => ({ uri: uri(filePath), originalUri: uri(filePath), status });
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(predicate, message) {
  const deadline = Date.now() + 1200;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(5);
  }
  assert.fail(message || 'Controller did not reach the expected state');
}

function fixture(t, options = {}) {
  const changes = options.repositories || [repository('/workspace/repo', {
    workingTreeChanges: [change('/workspace/repo/biz/server.go', 5)],
    indexChanges: [change('/workspace/repo/config/staged.json', 0)],
    untrackedChanges: [change('/workspace/repo/scripts/new.py', 7)],
    mergeChanges: [change('/workspace/repo/util/conflict.go', 16)],
  }), repository('/workspace/clean')];
  const registry = new Map(changes.map(repo => [repo.rootUri.fsPath, repo]));
  for (const repo of options.discoverable || []) registry.set(repo.rootUri.fsPath, repo);
  const opened = new Emitter();
  const closed = new Emitter();
  const apiState = new Emitter();
  const foldersChanged = new Emitter();
  const configurationChanged = new Emitter();
  const fileEvents = { change: new Emitter(), create: new Emitter(), delete: new Emitter() };
  const commands = new Map();
  const workspaceStore = new Map(Object.entries(options.workspaceState || {}));
  const configuration = new Map(Object.entries(options.configuration || {}));
  const calls = { commands: [], writes: [], workspaceState: [], trees: [], output: [], warnings: [], errors: [], repositoryReads: 0, open: [], status: [], reveals: [], quickPicks: [], inputs: [] };
  const wrap = repo => ({
    rootUri: repo.rootUri,
    get state() { return repo.state; },
    async status() { calls.status.push(repo.rootUri.fsPath); },
    async add() { throw new Error('Controller tests must not stage real or fixture files'); },
    async revert() { throw new Error('Controller tests must not unstage files'); },
    async clean() { throw new Error('Controller tests must not discard files'); },
  });
  const api = {
    state: options.gitState || 'initialized',
    get repositories() { calls.repositoryReads++; return changes.map(wrap); },
    onDidOpenRepository: opened.event,
    onDidCloseRepository: closed.event,
    onDidChangeState: apiState.event,
    toGitUri(value, ref) { return value.with({ scheme: 'git', query: JSON.stringify({ path: value.fsPath, ref }) }); },
    async openRepository(value) {
      const root = typeof value === 'string' ? value : value.fsPath;
      calls.open.push(root);
      const repo = registry.get(root);
      if (!repo) return null;
      if (!changes.some(current => current.rootUri.toString() === repo.rootUri.toString())) {
        changes.push(repo);
        opened.fire(wrap(repo));
        if (options.onOpen) options.onOpen(repo, { calls, opened });
      }
      return wrap(repo);
    },
  };
  const stateEvent = () => ({
    expanded: new Emitter(), collapsed: new Emitter(), checks: new Emitter(),
    selected: new Emitter(), visibility: new Emitter(),
  });
  const vscode = {
    EventEmitter: Emitter,
    TreeItem: class TreeItem { constructor(label, collapsibleState = 0) { this.label = label; this.collapsibleState = collapsibleState; } },
    ThemeIcon: class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } },
    ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
    MarkdownString: class MarkdownString { constructor(value = '') { this.value = value; } appendText(value) { this.value += value; return this; } appendMarkdown(value) { this.value += value; return this; } },
    DataTransferItem: class DataTransferItem { constructor(value) { this.value = value; } async asString() { return String(this.value); } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { Window: 10, Notification: 15, SourceControl: 1 },
    RelativePattern: class RelativePattern { constructor(base, pattern) { this.baseUri = base; this.pattern = pattern; } },
    Uri: { file: uri, from: values => ({ ...uri(values.path || ''), ...values }), parse: value => uri(value.replace(/^file:\/\//, '')), joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    workspace: {
      workspaceFolders: options.workspaceFolders === undefined
        ? [{ uri: uri('/workspace'), name: 'workspace', index: 0 }] : options.workspaceFolders,
      onDidChangeWorkspaceFolders: foldersChanged.event,
      onDidChangeConfiguration: configurationChanged.event,
      getConfiguration(section) {
        return {
          get(key, fallback) { return configuration.has(`${section}.${key}`) ? configuration.get(`${section}.${key}`) : fallback; },
          async update(key, value, target) { calls.writes.push({ section, key, value, target }); configuration.set(`${section}.${key}`, value); },
          inspect(key) { return { key, workspaceValue: configuration.get(`${section}.${key}`) }; },
        };
      },
      registerTextDocumentContentProvider() { return { dispose() {} }; },
      createFileSystemWatcher() {
        return { onDidChange: fileEvents.change.event, onDidCreate: fileEvents.create.event,
          onDidDelete: fileEvents.delete.event, dispose() {} };
      },
    },
    window: {
      createTreeView(id, treeOptions) {
        const events = stateEvent();
        const view = {
          id, options: treeOptions, events, selection: [], visible: true, message: undefined, description: undefined,
          onDidExpandElement: events.expanded.event, onDidCollapseElement: events.collapsed.event,
          onDidChangeCheckboxState: events.checks.event, onDidChangeSelection: events.selected.event,
          onDidChangeVisibility: events.visibility.event,
          async reveal(element, revealOptions) {
            this.revealed = { element, options: revealOptions };
            calls.reveals.push(this.revealed);
            if (options.onReveal) await options.onReveal(element, revealOptions, this);
            const expand = (node, depth) => {
              if (!node.children.length || depth <= 0) return;
              events.expanded.fire({ element: node });
              for (const child of node.children) expand(child, depth - 1);
            };
            if (revealOptions?.expand) expand(element, revealOptions.expand);
          },
          dispose() { this.disposed = true; for (const event of Object.values(events)) event.dispose(); },
        };
        calls.trees.push(view);
        return view;
      },
      createOutputChannel() { return { appendLine(value) { calls.output.push(value); }, append(value) { calls.output.push(value); }, clear() {}, show() {}, dispose() {} }; },
      createStatusBarItem() { return { show() {}, hide() {}, dispose() {} }; },
      async showInformationMessage() {},
      async showWarningMessage(message) { calls.warnings.push(message); },
      async showErrorMessage(message) { calls.errors.push(message); },
      async showInputBox(inputOptions) { calls.inputs.push(inputOptions); return options.inputValue; },
      async showQuickPick(items, pickOptions) { calls.quickPicks.push({ items, options: pickOptions }); return options.quickPickChoice; },
      async withProgress(_options, task) { return task({ report() {} }, { isCancellationRequested: false }); },
    },
    commands: {
      async getCommands() { return options.availableCommands || ['workbench.scm.resetViewLocation', 'repolens.changes.resetViewLocation']; },
      registerCommand(id, callback) { commands.set(id, callback); return { dispose() { commands.delete(id); } }; },
      async executeCommand(id, ...args) {
        calls.commands.push({ id, args });
        if (id === 'git.openRepository') return api.openRepository(args[0]);
        if (commands.has(id)) return commands.get(id)(...args);
        return undefined;
      },
    },
  };
  const context = {
    subscriptions: [], extensionUri: uri('/extension'),
    ...(options.extensionVersion ? { extension: { packageJSON: { version: options.extensionVersion } } } : {}),
    workspaceState: {
      get(key, fallback) { return workspaceStore.has(key) ? workspaceStore.get(key) : fallback; },
      async update(key, value) { workspaceStore.set(key, value); calls.workspaceState.push({ key, value }); },
    },
    globalState: { get(_key, fallback) { return fallback; }, async update() {} },
  };
  const discover = options.discover || (async () => []);
  const controller = new RepoLensController(vscode, context, api, { discover });
  t.after(() => controller.dispose());
  const result = { controller, vscode, context, api, calls, commands, changes, registry,
    opened, closed, apiState, fileEvents, configurationChanged, foldersChanged, workspaceStore,
    get view() { return calls.trees[0]; },
    async start() { await controller.start(); return result; },
  };
  return result;
}

async function nodes(controller) {
  const result = [];
  const visit = async parent => {
    for (const node of await controller.getChildren(parent)) {
      result.push(node);
      await visit(node);
    }
  };
  await visit(undefined);
  return result;
}

const files = async controller => (await nodes(controller)).filter(node => node.type === 'file');
const message = view => typeof view.message === 'string' ? view.message : view.message?.value || '';

test('an empty window registers the view without writing workspace configuration', async t => {
  const f = await fixture(t, { workspaceFolders: [], repositories: [] }).start();
  assert.equal(f.calls.trees.length, 1);
  assert.equal(f.calls.writes.length, 0);
  assert.equal(f.calls.commands.some(call => /setSelectionMode|setSortKey|setListViewMode/.test(call.id)), false);
  assert.deepEqual(await f.controller.getChildren(), []);
});

test('the default view contains only dirty repos in conflict, tracked and untracked sections', async t => {
  const f = await fixture(t).start();
  const roots = await f.controller.getChildren();
  assert.deepEqual(roots.map(node => node.label), ['合并冲突', '变更', '未跟踪']);
  const all = await nodes(f.controller);
  assert.equal(all.some(node => node.type === 'repo' && node.repoKey === 'file:///workspace/clean'), false);
  assert.equal((await files(f.controller)).length, 4);
  assert.equal(f.view.options.manageCheckboxStateManually, true);
});

test('Git state events refresh independent untracked entries without filesystem events', async t => {
  const repo = repository('/workspace/repo');
  const f = await fixture(t, { repositories: [repo] }).start();
  assert.deepEqual(await files(f.controller), []);
  repo.state.untrackedChanges.push(change('/workspace/repo/new.txt', 7));
  repo.stateEvents.fire();
  await waitFor(async () => (await files(f.controller)).length === 1, 'Git state event did not expose the new file');
  const [file] = await files(f.controller);
  assert.equal(file.kind, 'working');
  assert.equal(file.uri.fsPath, '/workspace/repo/new.txt');
});

test('identical Git metadata does not emit repeated tree refreshes', async t => {
  const f = await fixture(t).start();
  const provider = f.view.options.treeDataProvider;
  assert.equal(typeof provider.onDidChangeTreeData, 'function');
  let updates = 0;
  const subscription = provider.onDidChangeTreeData(() => updates++);
  t.after(() => subscription.dispose());
  f.controller.refreshFromGit();
  f.controller.refreshFromGit();
  assert.equal(updates, 0);
  f.changes[0].state.HEAD.name = 'feature/other';
  f.controller.refreshFromGit();
  assert.equal(updates, 1);
});

test('checking a parent selects its eligible files while conflicts remain unselectable', async t => {
  const f = await fixture(t).start();
  const roots = await f.controller.getChildren();
  const tracked = roots.find(node => node.label === '变更');
  const conflict = roots.find(node => node.label === '合并冲突');
  const expected = (await files(f.controller)).filter(node => node.kind !== 'conflict' && tracked.fileIds.includes(node.id));
  f.controller.changeChecks({ items: [[tracked, f.vscode.TreeItemCheckboxState.Checked]] });
  assert.deepEqual(f.controller.selectedNodes().map(node => node.id).sort(), expected.map(node => node.id).sort());
  f.controller.changeChecks({ items: [[conflict, f.vscode.TreeItemCheckboxState.Checked]] });
  assert.equal(f.controller.selectedNodes().some(node => node.kind === 'conflict'), false);
  for (const node of (await nodes(f.controller)).filter(node => node.kind === 'conflict')) {
    assert.equal(f.controller.getTreeItem(node).checkboxState, undefined);
  }
  f.controller.changeChecks({ items: [[tracked, f.vscode.TreeItemCheckboxState.Unchecked]] });
  assert.deepEqual(f.controller.selectedNodes(), []);
});

test('switching layout preserves stable file IDs and the selected file', async t => {
  const f = await fixture(t).start();
  const before = await files(f.controller);
  const selected = before.find(node => node.kind === 'working');
  f.controller.changeChecks({ items: [[selected, f.vscode.TreeItemCheckboxState.Checked]] });
  const beforeIds = before.map(node => f.controller.getTreeItem(node).id).sort();
  await f.controller.setLayout('list');
  const after = await files(f.controller);
  assert.deepEqual(after.map(node => f.controller.getTreeItem(node).id).sort(), beforeIds);
  assert.deepEqual(f.controller.selectedNodes().map(node => node.id), [selected.id]);
  assert.ok(f.calls.workspaceState.length > 0, 'Layout choice should be persisted for this workspace');
});

test('filtering clears hidden checkbox selections and shows only matching files', async t => {
  const f = await fixture(t).start();
  const before = await files(f.controller);
  const selected = before.find(node => node.kind === 'working');
  f.controller.changeChecks({ items: [[selected, f.vscode.TreeItemCheckboxState.Checked]] });
  f.controller.applyFilter('server');
  assert.deepEqual(f.controller.selectedNodes(), []);
  assert.deepEqual((await files(f.controller)).map(node => node.uri.fsPath), ['/workspace/repo/biz/server.go']);
  f.controller.applyFilter('', 'untracked');
  assert.deepEqual((await files(f.controller)).map(node => node.uri.fsPath), ['/workspace/repo/scripts/new.py']);
});

test('Git open and state listeners are attached before asynchronous discovery initializes repos', async t => {
  const discovered = repository('/workspace/discovered');
  let f;
  f = fixture(t, {
    repositories: [], discoverable: [discovered],
    async discover() {
      assert.ok(f.opened.size > 0, 'Repo open listener must precede filesystem discovery');
      return ['/workspace/discovered'];
    },
    onOpen(repo) {
      assert.ok(repo.stateEvents.size > 0, 'New repository state listener must be attached synchronously');
      repo.state.untrackedChanges.push(change('/workspace/discovered/new.go', 7));
      repo.stateEvents.fire();
    },
  });
  await f.start();
  await waitFor(async () => (await files(f.controller)).length === 1);
  assert.equal((await files(f.controller))[0].repoKey, discovered.rootUri.toString());
});

test('disposing detaches events and cancels pending state work', async t => {
  const f = await fixture(t).start();
  f.controller.dispose();
  const reads = f.calls.repositoryReads;
  const commands = f.calls.commands.length;
  for (const repo of f.changes) repo.stateEvents.fire();
  f.opened.fire(repository('/workspace/late'));
  f.closed.fire(f.changes[0]);
  f.api.state = 'uninitialized';
  f.apiState.fire('uninitialized');
  await delay(250);
  assert.equal(f.calls.repositoryReads, reads);
  assert.equal(f.calls.commands.length, commands);
  assert.equal(f.commands.size, 0);
});

test('disposing during discovery prevents a waiting manual refresh from reading or refreshing repos', async t => {
  let finishDiscovery;
  const discovery = new Promise(resolve => { finishDiscovery = resolve; });
  const f = fixture(t, { discover: () => discovery });
  const starting = f.start();
  const refreshing = f.controller.refresh();
  f.controller.dispose();
  const reads = f.calls.repositoryReads;
  const commands = f.calls.commands.length;
  finishDiscovery([]);
  await Promise.all([starting, refreshing]);
  assert.equal(f.calls.repositoryReads, reads, 'Manual refresh must stop after the pending discovery resolves');
  assert.equal(f.calls.status.length, 0, 'Disposed controllers must not start repo.status calls');
  assert.equal(f.calls.commands.length, commands);
});

test('disposing while a discard confirmation is open prevents the confirmed mutation', async t => {
  const f = await fixture(t).start();
  const [file] = (await files(f.controller)).filter(node => node.kind === 'working' && node.change.status === 5);
  let answer;
  let confirmationLabel;
  f.vscode.window.showWarningMessage = async (_message, _details, action) => {
    confirmationLabel = action;
    return new Promise(resolve => { answer = resolve; });
  };
  const command = f.commands.get('repolens.discard');
  assert.equal(typeof command, 'function');
  const pending = command(file);
  assert.equal(typeof answer, 'function');
  f.controller.dispose();
  const reads = f.calls.repositoryReads;
  answer(confirmationLabel);
  await pending;
  assert.equal(f.calls.repositoryReads, reads, 'Disposed action dependencies must not re-read Git');
  assert.deepEqual(f.calls.errors, [], 'No clean/revert mutation may be invoked after disposal');
});

test('Git initialization is shown explicitly until the native API is initialized', async t => {
  const f = await fixture(t, { repositories: [], gitState: 'uninitialized' }).start();
  assert.match(message(f.view), /初始化|扫描|加载/);
  f.api.state = 'initialized';
  f.apiState.fire('initialized');
  await waitFor(() => !/初始化|扫描|加载/.test(message(f.view)), 'Initialized Git still displays the loading empty state');
  assert.equal(f.calls.writes.length, 0);
});

function deepRepository() {
  const paths = ['root/side.txt'];
  let parent = 'root';
  for (const folder of ['one', 'two', 'three', 'four', 'five', 'six', 'seven']) {
    parent += `/${folder}`;
    paths.push(`${parent}/side.txt`);
  }
  paths.push(`${parent}/end.txt`);
  return repository('/workspace/deep', {
    workingTreeChanges: paths.map(relative => change(`/workspace/deep/${relative}`, 5))
  });
}

test('expand all traverses deep branches in bounded public reveal calls and preserves selection', async t => {
  const f = await fixture(t, { repositories: [deepRepository()] }).start();
  const branches = (await nodes(f.controller)).filter(node => node.children.length);
  const [selected] = await files(f.controller);
  f.controller.changeChecks({ items: [[selected, f.vscode.TreeItemCheckboxState.Checked]] });
  f.view.selection = [selected];
  for (const branch of branches) f.controller.expansion[branch.id] = false;
  const reads = f.calls.repositoryReads;
  const result = await f.commands.get('repolens.expandAll')();
  assert.deepEqual(result, { expanded: branches.length });
  assert.ok(f.calls.reveals.length > 1, 'A tree deeper than three levels must use multiple frontiers');
  assert.ok(f.calls.reveals.length < (await files(f.controller)).length, 'Expansion should reveal branches rather than every file');
  for (const call of f.calls.reveals) {
    assert.notEqual(call.element.type, 'file');
    assert.deepEqual(call.options, { expand: 3, select: false, focus: false });
  }
  for (const branch of branches) {
    assert.equal(f.controller.expansion[branch.id], true, branch.label);
    assert.equal(f.controller.getTreeItem(branch).collapsibleState, f.vscode.TreeItemCollapsibleState.Expanded);
  }
  const persisted = f.calls.workspaceState.filter(call => call.key === 'repolens.expansion');
  assert.equal(persisted.length, 1, 'Native expand events should be saved in one batch');
  assert.deepEqual(f.controller.selectedNodes().map(node => node.id), [selected.id]);
  assert.deepEqual(f.view.selection, [selected]);
  assert.equal(f.calls.repositoryReads, reads, 'Expansion must not read or mutate Git');
  assert.deepEqual(f.calls.writes, []);
});

test('filtered expand all expands only matching ancestors without replacing saved workspace collapse state', async t => {
  const f = await fixture(t, { repositories: [deepRepository()] }).start();
  const before = (await nodes(f.controller)).filter(node => node.children.length);
  for (const node of before) f.controller.expansion[node.id] = false;
  const workspaceExpansion = { ...f.controller.expansion };
  f.controller.applyFilter('end.txt');
  const visibleBranches = (await nodes(f.controller)).filter(node => node.children.length);
  const result = await f.controller.expandAll();
  assert.deepEqual(result, { expanded: visibleBranches.length });
  assert.equal((await files(f.controller)).length, 1);
  assert.deepEqual(f.controller.expansion, workspaceExpansion);
  for (const node of visibleBranches) assert.equal(f.controller.searchExpansion[node.id], true);
  for (const call of f.calls.reveals) assert.equal(f.controller.model.nodeById.get(call.element.id), call.element);
  assert.equal(f.calls.workspaceState.filter(call => call.key === 'repolens.expansion').length, 0);
});

test('disposing during an awaited reveal cancels all remaining expansion work', async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { repositories: [deepRepository()], onReveal: () => waiting }).start();
  const expanding = f.controller.expandAll();
  assert.equal(f.calls.reveals.length, 1);
  f.controller.dispose();
  release();
  assert.deepEqual(await expanding, { expanded: 0, cancelled: true });
  assert.equal(f.calls.reveals.length, 1);
  assert.equal(f.calls.workspaceState.filter(call => call.key === 'repolens.expansion').length, 0);
  assert.deepEqual(f.calls.errors, []);
});

test('replacing the visible model cancels stale expansion and ignores its late events', async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { repositories: [deepRepository()], onReveal: () => waiting }).start();
  const expanding = f.controller.expandAll();
  const staleRoot = f.calls.reveals[0].element;
  f.controller.applyFilter('end.txt');
  release();
  assert.deepEqual(await expanding, { expanded: 0, cancelled: true });
  assert.equal(f.calls.reveals.length, 1);
  assert.deepEqual(f.controller.searchExpansion, {}, 'Late expansion events must not overwrite the new filtered model');
  assert.equal(f.controller.model.nodeById.get(staleRoot.id) === staleRoot, false);
  assert.equal(f.calls.workspaceState.filter(call => call.key === 'repolens.expansion').length, 0);
});

test('expand all has no work for an empty model and reports localized reveal failures', async t => {
  const empty = await fixture(t, { repositories: [] }).start();
  assert.deepEqual(await empty.controller.expandAll(), { expanded: 0 });
  assert.deepEqual(empty.calls.reveals, []);
  const f = await fixture(t, { onReveal: async () => { throw new Error('test reveal failure'); } }).start();
  assert.deepEqual(await f.controller.expandAll(), { expanded: 0, failed: true });
  assert.match(f.calls.errors[0], /无法展开全部变更：test reveal failure/);
  assert.match(f.calls.output.at(-1), /错误：test reveal failure/);
});

test('focus addresses the Source Control child view without toggling its container or altering native repositories', async t => {
  const f = await fixture(t).start();
  f.calls.commands.length = 0;
  await f.commands.get('repolens.focus')();
  assert.deepEqual(f.calls.commands, [{ id: 'repolens.changes.focus', args: [{ preserveFocus: false }] }]);
  assert.equal(Object.hasOwn(f.view, 'badge'), false, 'The shared Source Control container already owns its activity badge');
});

test('manual layout restore resets only the two SCM view locations', async t => {
  const f = await fixture(t).start();
  await f.controller.changelists.flush();
  const workspaceWrites = f.calls.workspaceState.length;
  f.calls.commands.length = 0;
  assert.deepEqual(await f.commands.get('repolens.restoreSourceControlLayout')(), ['workbench.scm', 'repolens.changes']);
  assert.deepEqual(f.calls.commands, [
    { id: 'workbench.scm.resetViewLocation', args: [] },
    { id: 'repolens.changes.resetViewLocation', args: [] },
  ]);
  assert.deepEqual(f.calls.writes, []);
  assert.equal(f.calls.workspaceState.length, workspaceWrites);
  const unavailable = await fixture(t, { availableCommands: [] }).start();
  assert.equal(await unavailable.commands.get('repolens.restoreSourceControlLayout')(), undefined);
  assert.match(unavailable.calls.errors[0], /无法恢复源代码管理布局/);
});

test('controller UI follows English locale and repo actions do not depend on translated category labels', async t => {
  setLanguage('en');
  const f = await fixture(t, {
    repositories: [repository('/workspace/repo', { indexChanges: [change('/workspace/repo/staged.txt', 0)] })],
    quickPickChoice: { action: 'search' }, inputValue: 'staged',
  }).start();
  const [category] = await f.controller.getChildren();
  const [repo] = category.children;
  assert.equal(category.label, 'Changes');
  assert.equal(f.controller.getTreeItem(repo).contextValue, 'repolens.repoStaged');
  assert.equal(f.controller.getTreeItem((await files(f.controller))[0]).command.title, 'Open diff');
  assert.equal(f.view.description, '1 repository');
  await f.controller.chooseFilter();
  assert.equal(f.calls.quickPicks[0].options.title, 'JetBrains-style Changes · Filter changes');
  assert.equal(f.calls.quickPicks[0].items[0].label, 'Search files, folders, repositories, or branches…');
  assert.equal(f.calls.inputs[0].prompt, 'Match file paths, repository names, or branches');
  assert.equal(message(f.view), 'staged: 1 / 1 files');
  const [selected] = await files(f.controller);
  f.controller.changeChecks({ items: [[selected, f.vscode.TreeItemCheckboxState.Checked]] });
  assert.match(message(f.view), /1 selected/);
  assert.match(f.controller.getTreeItem(f.controller.getParent(selected)).description, /1 selected/);
  assert.equal(/[\u4e00-\u9fff]/.test(f.calls.output.join('\n')), false);
});

test('diagnostics report the installed package version with a source package fallback', async t => {
  const f = await fixture(t).start();
  assert.equal(f.controller.diagnostics().version, require('../package.json').version);
  const installed = await fixture(t, { extensionVersion: '9.8.7' }).start();
  assert.equal(installed.controller.diagnostics().version, '9.8.7');
});

test('grouping defaults to status and the chosen grouping survives reload', async t => {
  const f = await fixture(t).start();
  assert.equal(f.controller.grouping, 'status');
  assert.deepEqual((await f.controller.getChildren()).map(node => node.type), ['category', 'category', 'category']);
  const selected = (await files(f.controller)).find(node => node.kind === 'working');
  f.controller.changeChecks({ items: [[selected, f.vscode.TreeItemCheckboxState.Checked]] });
  await f.controller.setGrouping('changelist');
  await f.controller.changelists.flush();
  assert.equal(f.workspaceStore.get('repolens.grouping'), 'changelist');
  assert.deepEqual(f.controller.selectedNodes(), []);
  assert.deepEqual((await f.controller.getChildren()).map(node => node.type), ['category', 'changelist']);
  const reloaded = await fixture(t, { workspaceState: Object.fromEntries(f.workspaceStore) }).start();
  assert.equal(reloaded.controller.grouping, 'changelist');
  assert.deepEqual((await reloaded.controller.getChildren()).map(node => node.label), ['合并冲突', '默认变更']);
  await reloaded.commands.get('repolens.groupBy')();
  assert.equal(reloaded.controller.grouping, 'changelist', 'Dismissing the grouping picker preserves its current value');
});

test('create changelist activates it and changes grouping without reassigning existing files', async t => {
  const f = await fixture(t, { inputValue: 'Checkout fix' }).start();
  const before = await files(f.controller);
  await f.commands.get('repolens.createChangelist')();
  const task = f.controller.changelists.lists.find(list => list.name === 'Checkout fix');
  assert.ok(task);
  assert.equal(f.controller.changelists.activeId, task.id);
  assert.equal(f.controller.grouping, 'changelist');
  const taskNode = (await f.controller.getChildren()).find(node => node.listId === task.id);
  assert.equal(taskNode.count, 0);
  assert.match(taskNode.description, /当前/);
  assert.equal(f.controller.getTreeItem(taskNode).contextValue, 'repolens.changelistActive');
  for (const file of before) assert.equal(f.controller.changelists.listFor(file.repoKey, file.uri.toString()), 'default');
  f.changes[0].state.untrackedChanges.push(change('/workspace/repo/next.txt', 7));
  f.changes[0].stateEvents.fire();
  await waitFor(() => f.controller.model.files.some(file => file.label === 'next.txt'));
  const next = f.controller.model.files.find(file => file.label === 'next.txt');
  assert.equal(f.controller.changelists.listFor(next.repoKey, next.uri.toString()), task.id);
  assert.deepEqual(f.calls.errors, []);
});

test('moving one row changes both stage and work membership without staging or mutating Git state', async t => {
  const repo = repository('/workspace/repo', {
    workingTreeChanges: [change('/workspace/repo/shared.go', 5)],
    indexChanges: [change('/workspace/repo/shared.go', 0)]
  });
  const f = await fixture(t, { repositories: [repo], inputValue: 'Task' }).start();
  const originalWorking = repo.state.workingTreeChanges[0];
  const originalIndex = repo.state.indexChanges[0];
  await f.commands.get('repolens.createChangelist')();
  const task = f.controller.changelists.lists.find(list => list.name === 'Task');
  const working = (await files(f.controller)).find(file => file.kind === 'working');
  f.controller.changeChecks({ items: [[working, f.vscode.TreeItemCheckboxState.Checked]] });
  f.vscode.window.showQuickPick = async () => ({ listId: task.id });
  await f.commands.get('repolens.moveToChangelist')(working);
  const taskNode = (await f.controller.getChildren()).find(node => node.listId === task.id);
  assert.equal(taskNode.count, 1);
  assert.equal(taskNode.fileIds.length, 2);
  assert.deepEqual(taskNode.children[0].children.map(node => node.kind), ['working', 'index']);
  assert.deepEqual(new Set(taskNode.fileIds), new Set((await files(f.controller)).map(file => file.id)));
  assert.deepEqual(f.controller.selectedNodes(), []);
  assert.equal(repo.state.workingTreeChanges[0], originalWorking);
  assert.equal(repo.state.indexChanges[0], originalIndex);
  assert.equal(f.calls.commands.some(call => /^git\.(?:stage|unstage|commit|clean|stash)/.test(call.id)), false);
  assert.deepEqual(f.calls.errors, []);
});

test('renaming and deleting a changelist changes only its logical grouping and restores default membership', async t => {
  const f = await fixture(t, { inputValue: 'Task' }).start();
  await f.commands.get('repolens.createChangelist')();
  const task = f.controller.changelists.lists.find(list => list.name === 'Task');
  const selected = (await files(f.controller)).find(file => file.kind === 'working');
  f.vscode.window.showQuickPick = async () => ({ listId: task.id });
  await f.commands.get('repolens.moveToChangelist')(selected);
  const before = f.changes.map(repo => ({
    working: [...repo.state.workingTreeChanges], index: [...repo.state.indexChanges],
    untracked: [...repo.state.untrackedChanges], conflicts: [...repo.state.mergeChanges]
  }));
  f.vscode.window.showInputBox = async () => 'Renamed task';
  await f.commands.get('repolens.renameChangelist')((await f.controller.getChildren()).find(node => node.listId === task.id));
  assert.equal(f.controller.changelists.lists.find(list => list.id === task.id).name, 'Renamed task');
  assert.equal(f.controller.changelists.listFor(selected.repoKey, selected.uri.toString()), task.id);
  f.vscode.window.showWarningMessage = async (_message, _options, confirm) => confirm;
  await f.commands.get('repolens.deleteChangelist')((await f.controller.getChildren()).find(node => node.listId === task.id));
  assert.equal(f.controller.changelists.lists.some(list => list.id === task.id), false);
  assert.equal(f.controller.changelists.activeId, 'default');
  assert.equal(f.controller.changelists.listFor(selected.repoKey, selected.uri.toString()), 'default');
  assert.deepEqual(f.changes.map(repo => ({
    working: [...repo.state.workingTreeChanges], index: [...repo.state.indexChanges],
    untracked: [...repo.state.untrackedChanges], conflicts: [...repo.state.mergeChanges]
  })), before);
  assert.equal(f.calls.commands.some(call => /^git\.(?:stage|unstage|commit|clean|stash)/.test(call.id)), false);
  assert.deepEqual(f.calls.errors, []);
});

test('changelist filtering clears hidden selections and preserves file membership across reload', async t => {
  const f = await fixture(t, { inputValue: 'Task' }).start();
  await f.commands.get('repolens.createChangelist')();
  const task = f.controller.changelists.lists.find(list => list.name === 'Task');
  const selected = (await files(f.controller)).find(file => file.kind === 'working' && file.label === 'server.go');
  f.vscode.window.showQuickPick = async () => ({ listId: task.id });
  await f.commands.get('repolens.moveToChangelist')(selected);
  f.controller.changeChecks({ items: [[selected, f.vscode.TreeItemCheckboxState.Checked]] });
  f.controller.applyFilter('', 'untracked');
  assert.deepEqual(f.controller.selectedNodes(), []);
  assert.deepEqual((await files(f.controller)).map(file => file.label), ['new.py']);
  const [untracked] = await files(f.controller);
  f.controller.changeChecks({ items: [[untracked, f.vscode.TreeItemCheckboxState.Checked]] });
  await f.commands.get('repolens.clearFilter')();
  assert.deepEqual(f.controller.selectedNodes(), []);
  assert.equal((await files(f.controller)).length, 4);
  await f.controller.changelists.flush();
  const reloaded = await fixture(t, { workspaceState: Object.fromEntries(f.workspaceStore) }).start();
  assert.equal(reloaded.controller.grouping, 'changelist');
  assert.equal(reloaded.controller.changelists.listFor(selected.repoKey, selected.uri.toString()), task.id);
  assert.equal((await reloaded.controller.getChildren()).find(node => node.listId === task.id).count, 1);
});

test('late repositories retain saved membership until their initial Git state arrives', async t => {
  const repoA = repository('/workspace/repo-a', { workingTreeChanges: [change('/workspace/repo-a/a.go', 5)] });
  const repoB = repository('/workspace/repo-b', { HEAD: undefined });
  const keyA = repoA.rootUri.toString();
  const keyB = repoB.rootUri.toString();
  const taskId = 'task';
  const f = await fixture(t, {
    repositories: [repoA],
    workspaceState: { 'repolens.grouping': 'changelist', [STORAGE_KEY]: {
      version: 1, lists: [{ id: 'default', name: 'Default' }, { id: taskId, name: 'Task' }], activeId: 'default',
      files: { [JSON.stringify([keyA, 'file:///workspace/repo-a/a.go'])]: taskId,
        [JSON.stringify([keyB, 'file:///workspace/repo-b/b.go'])]: taskId }
    } }
  }).start();
  await f.controller.changelists.flush();
  assert.equal(f.controller.changelists.listFor(keyB, 'file:///workspace/repo-b/b.go'), taskId);
  f.changes.push(repoB);
  f.opened.fire(repoB);
  await delay(110);
  assert.equal(f.controller.changelists.listFor(keyB, 'file:///workspace/repo-b/b.go'), taskId);
  repoB.state.HEAD = { name: 'feature/loaded', commit: 'loaded' };
  repoB.state.workingTreeChanges = [change('/workspace/repo-b/b.go', 5)];
  repoB.stateEvents.fire();
  await waitFor(() => f.controller.model.files.some(file => file.repoKey === keyB));
  assert.equal(f.controller.changelists.listFor(keyB, 'file:///workspace/repo-b/b.go'), taskId);
});

test('an initially empty repository prunes its saved clean membership when its ready event arrives', async t => {
  const repo = repository('/workspace/empty', { HEAD: undefined });
  const key = repo.rootUri.toString();
  const savedUri = 'file:///workspace/empty/former.go';
  const f = await fixture(t, { repositories: [repo], workspaceState: { [STORAGE_KEY]: {
    version: 1, lists: [{ id: 'default', name: 'Default' }, { id: 'task', name: 'Task' }], activeId: 'default',
    files: { [JSON.stringify([key, savedUri])]: 'task' }
  } } }).start();
  assert.equal(f.controller.changelists.listFor(key, savedUri), 'task');
  repo.state.HEAD = { name: 'main', commit: 'ready' };
  repo.stateEvents.fire();
  await waitFor(() => f.controller.changelists.listFor(key, savedUri) === 'default', 'Ready-but-clean Git state did not prune the saved membership');
  await f.controller.changelists.flush();
  assert.deepEqual(f.controller.changelists.serialize().files, {});
});

test('dragging parent and child rows deduplicates eligible files and moves them across repositories into an empty list', async t => {
  const repoA = repository('/workspace/repo-a', {
    workingTreeChanges: [change('/workspace/repo-a/shared.go', 5)],
    indexChanges: [change('/workspace/repo-a/shared.go', 0)],
    mergeChanges: [change('/workspace/repo-a/conflict.go', 18)]
  });
  const repoB = repository('/workspace/repo-b', { untrackedChanges: [change('/workspace/repo-b/new.go', 7)] });
  const f = await fixture(t, { repositories: [repoA, repoB], inputValue: 'Cross-repo task' }).start();
  await f.commands.get('repolens.createChangelist')();
  const roots = await f.controller.getChildren();
  const target = roots.find(node => node.type === 'changelist' && node.listId !== 'default');
  assert.equal(target.count, 0);
  const source = roots.find(node => node.listId === 'default');
  const conflict = roots.find(node => node.kind === 'conflict');
  const working = f.controller.model.files.find(node => node.kind === 'working');
  const transfer = new Map();
  const drag = f.view.options.dragAndDropController;
  assert.deepEqual(drag.dragMimeTypes, drag.dropMimeTypes);
  drag.handleDrag([source, working, conflict], transfer, { isCancellationRequested: false });
  const ids = JSON.parse(await transfer.get(drag.dragMimeTypes[0]).asString());
  const eligible = f.controller.model.files.filter(node => node.kind !== 'conflict');
  assert.equal(ids.length, eligible.length);
  assert.equal(new Set(ids).size, ids.length);
  f.controller.changeChecks({ items: [[working, f.vscode.TreeItemCheckboxState.Checked]] });
  await drag.handleDrop(target, transfer, { isCancellationRequested: false });
  for (const file of eligible) {
    assert.equal(f.controller.changelists.listFor(file.repoKey, file.uri.toString()), target.listId);
  }
  const moved = (await f.controller.getChildren()).find(node => node.listId === target.listId);
  assert.equal(moved.count, 2);
  assert.equal(moved.children.length, 2);
  assert.equal((await f.controller.getChildren())[0].kind, 'conflict');
  assert.deepEqual(f.controller.selectedNodes(), []);
  assert.equal(f.calls.commands.some(call => /^git\.(?:stage|unstage|commit|clean|stash)/.test(call.id)), false);
  assert.deepEqual(f.calls.errors, []);
});

test('cancelled drops and forged or ineligible IDs never change membership', async t => {
  const f = await fixture(t, { inputValue: 'Task' }).start();
  await f.commands.get('repolens.createChangelist')();
  const roots = await f.controller.getChildren();
  const target = roots.find(node => node.type === 'changelist' && node.listId !== 'default');
  const drag = f.view.options.dragAndDropController;
  const mime = drag.dragMimeTypes[0];
  const source = f.controller.model.files.find(node => node.kind === 'working');
  const conflict = f.controller.model.files.find(node => node.kind === 'conflict');
  const baseline = f.controller.changelists.serialize();
  const cancelledDrag = new Map();
  drag.handleDrag([source], cancelledDrag, { isCancellationRequested: true });
  assert.equal(cancelledDrag.size, 0);
  const forged = new Map([[mime, new f.vscode.DataTransferItem(JSON.stringify([
    JSON.stringify(['file', 'file:///foreign', 'working', 'file:///foreign/secret']),
    conflict.id, target.id, null, { id: source.id }
  ]))]]);
  await drag.handleDrop(target, forged, { isCancellationRequested: false });
  assert.deepEqual(f.controller.changelists.serialize(), baseline);
  let release;
  const payload = new Promise(resolve => { release = resolve; });
  const token = { isCancellationRequested: false };
  const waiting = drag.handleDrop(target, new Map([[mime, { asString: () => payload }]]), token);
  token.isCancellationRequested = true;
  release(JSON.stringify([source.id]));
  await waiting;
  assert.deepEqual(f.controller.changelists.serialize(), baseline);
  assert.deepEqual(f.calls.errors, []);
});
