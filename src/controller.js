'use strict';

const path = require('node:path');
const { collectRepositories } = require('./changes');
const { buildTree } = require('./tree');
const { createActions } = require('./actions');
const { createWorkflows } = require('./workflows');
const { discoverRepositoryRoots, DEFAULT_IGNORED_FOLDERS } = require('./discovery');
const { t } = require('./i18n');
const { restoreSourceControlLayout } = require('./layout');
const { ChangelistStore } = require('./changelists');
const PACKAGE_VERSION = require('../package.json').version;

const VIEW_ID = 'repolens.changes';
const COLOR_IDS = ['charts.blue', 'charts.green', 'charts.orange', 'charts.purple', 'charts.yellow'];

function repositoryColor(key) {
  let hash = 0;
  for (const character of key) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  return COLOR_IDS[(hash >>> 0) % COLOR_IDS.length];
}

function signature(snapshots) {
  return JSON.stringify(snapshots.map(repo => [repo.key, repo.branch, repo.mergeInProgress,
    ...['working', 'index', 'conflicts'].map(kind => repo[kind].map(change => [
      change.uri.toString(), change.status, change.originalUri?.toString(), change.renameUri?.toString()
    ]))]));
}

class RepoLensController {
  constructor(vscode, context, api, options = {}) {
    this.vscode = vscode;
    this.context = context;
    this.api = api;
    this.discover = options.discover || discoverRepositoryRoots;
    this.refreshDelay = options.refreshDelay ?? 80;
    this.disposables = [];
    this.repoListeners = new Map();
    this.initializedRepositories = new Set();
    this.selection = new Set();
    this.expansion = { ...context.workspaceState.get('repolens.expansion', {}) };
    this.searchExpansion = {};
    this.mode = context.workspaceState.get('repolens.layout', 'tree') === 'list' ? 'list' : 'tree';
    this.grouping = context.workspaceState.get('repolens.grouping', 'status') === 'changelist' ? 'changelist' : 'status';
    this.changelists = new ChangelistStore(context.workspaceState);
    this.filterText = '';
    this.filterStatus = 'all';
    this.snapshots = [];
    this.model = buildTree([]);
    this.parents = new Map();
    this.changeEmitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changeEmitter.event;
    this.disposables.push(this.changeEmitter);
    this.lastSignature = undefined;
    this.lastGitState = undefined;
    this.lastError = undefined;
    this.metrics = { directoryDiscoveryMs: 0, discoveredRepositories: 0 };
    this.disposed = false;
    this.scanAgain = false;
    this.scanPromise = undefined;
    this.output = vscode.window.createOutputChannel('JetBrains-style Changes');
    this.disposables.push(this.output);
    const dependencies = {
      vscode, getGit: () => this.disposed ? undefined : this.api,
      refresh: async () => { this.selection.clear(); this.refreshFromGit(true); },
      getSelectedNodes: () => this.selectedNodes(),
      getNodeFiles: node => this.nodeFiles(node)
    };
    this.actions = createActions(dependencies);
    this.workflows = createWorkflows(dependencies);
  }

  async start() {
    if (this.disposed || this.started) return;
    this.started = true;
    const vscode = this.vscode;
    this.tree = vscode.window.createTreeView(VIEW_ID, {
      treeDataProvider: this, showCollapseAll: true, canSelectMany: true,
      manageCheckboxStateManually: true,
      dragAndDropController: this.changelistDragAndDrop()
    });
    this.disposables.push(this.tree);
    this.disposables.push(vscode.workspace.registerTextDocumentContentProvider('repolens-empty', {
      provideTextDocumentContent: () => ''
    }));
    this.registerCommands();
    this.disposables.push(this.tree.onDidChangeCheckboxState(event => this.changeChecks(event)));
    this.disposables.push(this.tree.onDidExpandElement(event => this.rememberExpansion(event.element, true)));
    this.disposables.push(this.tree.onDidCollapseElement(event => this.rememberExpansion(event.element, false)));

    // Subscribe before opening discovered repositories: their initial Git state may arrive immediately.
    for (const repo of this.api.repositories || []) this.attach(repo);
    this.disposables.push(this.api.onDidOpenRepository(repo => {
      if (this.disposed) return;
      this.attach(repo);
      this.scheduleRefresh();
    }));
    this.disposables.push(this.api.onDidCloseRepository(repo => {
      const key = repo.rootUri.toString();
      this.repoListeners.get(key)?.dispose();
      this.repoListeners.delete(key);
      this.scheduleRefresh();
    }));
    if (typeof this.api.onDidChangeState === 'function') {
      this.disposables.push(this.api.onDidChangeState(() => this.scheduleRefresh()));
    }
    if (typeof vscode.workspace.onDidChangeWorkspaceFolders === 'function') {
      this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleScan()));
    }
    if (typeof vscode.workspace.onDidChangeConfiguration === 'function') {
      this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('git.repositoryScanMaxDepth') ||
            event.affectsConfiguration('git.scanRepositories') ||
            event.affectsConfiguration('repolens.additionalRepositories') ||
            event.affectsConfiguration('repolens.ignoredFolders')) this.scheduleScan();
        if (event.affectsConfiguration('repolens.collapseThreshold')) this.publishTree();
      }));
    }
    const watcher = vscode.workspace.createFileSystemWatcher('**/.git');
    this.disposables.push(watcher,
      watcher.onDidCreate(() => this.scheduleScan()),
      watcher.onDidDelete(() => this.scheduleScan()),
      watcher.onDidChange(() => this.scheduleScan()));
    this.refreshFromGit(true);
    await this.rescan();
  }

  registerCommands() {
    const handlers = {
      'repolens.refresh': () => this.refresh(),
      'repolens.focus': () => this.vscode.commands.executeCommand(`${VIEW_ID}.focus`, { preserveFocus: false }),
      'repolens.expandAll': () => this.expandAll(),
      'repolens.restoreSourceControlLayout': () => this.restoreLayout(),
      'repolens.openChange': node => this.openChange(node),
      'repolens.openFile': node => this.actions.openFile(node),
      'repolens.discard': node => this.actions.discard(node),
      'repolens.unstage': node => this.actions.unstage(node),
      'repolens.stage': node => this.workflows.stage(node),
      'repolens.stageSelected': () => this.workflows.stageSelected(),
      'repolens.unstageSelected': () => this.workflows.unstageSelected(),
      'repolens.commit': node => this.workflows.commit(node),
      'repolens.commitSelected': node => this.workflows.commitSelected(node),
      'repolens.stashSelected': node => this.workflows.stashSelected(node),
      'repolens.groupBy': () => this.chooseGrouping(),
      'repolens.createChangelist': () => this.editChangelist('create'),
      'repolens.renameChangelist': node => this.editChangelist('rename', node),
      'repolens.deleteChangelist': node => this.editChangelist('delete', node),
      'repolens.activateChangelist': node => this.editChangelist('activate', node),
      'repolens.moveToChangelist': node => this.moveToChangelist(node),
      'repolens.createStash': node => this.workflows.createStash(node),
      'repolens.applyStash': node => this.workflows.applyStash(node),
      'repolens.filter': () => this.chooseFilter(),
      'repolens.clearFilter': () => this.applyFilter('', 'all'),
      'repolens.showTree': () => this.setLayout('tree'),
      'repolens.showList': () => this.setLayout('list'),
      'repolens.clearSelection': () => { this.selection.clear(); this.updatePresentation(); this.changeEmitter.fire(); },
      'repolens.nextChange': () => this.navigate(1),
      'repolens.previousChange': () => this.navigate(-1),
      'repolens.showDiagnostics': () => this.showDiagnostics()
    };
    for (const [id, handler] of Object.entries(handlers)) {
      this.disposables.push(this.vscode.commands.registerCommand(id, (...args) => {
        if (!this.disposed) return handler(...args);
        return undefined;
      }));
    }
  }

  attach(repo) {
    const key = repo.rootUri.toString();
    if (this.repoListeners.has(key)) return;
    if (repo.state.HEAD || ['workingTreeChanges', 'indexChanges', 'untrackedChanges', 'mergeChanges']
      .some(kind => repo.state[kind]?.length)) this.initializedRepositories.add(key);
    this.repoListeners.set(key, repo.state.onDidChange(() => {
      this.initializedRepositories.add(key);
      this.scheduleRefresh();
    }));
  }

  scheduleRefresh() {
    if (this.disposed || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refreshFromGit();
    }, this.refreshDelay);
  }

  scheduleScan() {
    if (this.disposed) return;
    clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      this.scanTimer = undefined;
      this.rescan().catch(error => this.logError(error));
    }, 300);
  }

  refreshFromGit(force = false) {
    if (this.disposed) return;
    const repositories = this.api.repositories || [];
    for (const repo of repositories) this.attach(repo);
    const snapshots = collectRepositories(repositories);
    const current = JSON.stringify([signature(snapshots), [...this.initializedRepositories].sort()]);
    const stateChanged = this.lastGitState !== this.api.state;
    this.lastGitState = this.api.state;
    if (!force && this.lastSignature === current && !stateChanged) return;
    this.snapshots = snapshots;
    if (this.api.state === 'initialized') {
      this.changelists.sync(snapshots, new Set(repositories.map(repo => repo.rootUri.toString())
        .filter(key => this.initializedRepositories.has(key))));
      this.changelists.flush().catch(error => this.logError(error));
    }
    this.lastSignature = current;
    this.submodules = new Map(repositories.map(repo => [repo.rootUri.toString(), new Set(
      (repo.state.submodules || []).map(module => path.resolve(repo.rootUri.fsPath, module.path))
    )]));
    this.publishTree();
  }

  publishTree() {
    if (this.disposed) return;
    this.model = buildTree(this.snapshots, {
      mode: this.mode, filterText: this.filterText, filterStatus: this.filterStatus,
      grouping: this.grouping, changelists: this.changelists.lists,
      activeListId: this.changelists.activeId,
      listFor: (repoKey, uri) => this.changelists.listFor(repoKey, uri),
      collapseThreshold: this.vscode.workspace.getConfiguration('repolens').get('collapseThreshold', 20)
    });
    this.parents = new Map();
    const visit = (children, parent) => {
      for (const child of children) {
        if (parent) this.parents.set(child.id, parent);
        visit(child.children || [], child);
      }
    };
    visit(this.model.roots);
    for (const id of this.selection) if (!this.model.nodeById.has(id)) this.selection.delete(id);
    this.updatePresentation();
    this.changeEmitter.fire();
  }

  updatePresentation() {
    if (this.disposed || !this.tree) return;
    const selected = this.selectedNodes();
    this.tree.description = this.model.repositoryCount
      ? t(this.model.repositoryCount === 1 ? '{0} repository' : '{0} repositories', this.model.repositoryCount) : undefined;
    if (!(this.vscode.workspace.workspaceFolders || []).length) {
      this.tree.message = t('Open a local folder to view changes across repositories here.');
    } else if (this.scanning) {
      this.tree.message = t('Finding repositories…');
    } else if (this.api.state === 'uninitialized') {
      this.tree.message = t('Git is initializing. Diffs will be available when repository scanning finishes.');
    } else if (this.lastError) {
      this.tree.message = t('Repository discovery is incomplete. Refresh to retry; existing changes remain available.');
    } else if (this.filterText || this.filterStatus !== 'all') {
      const status = { all: '', conflict: t('Conflicts only'), tracked: t('Changes only'), untracked: t('Untracked only') }[this.filterStatus];
      this.tree.message = t('{0}: {1} / {2} files{3}', [status, this.filterText].filter(Boolean).join(' · '),
        this.model.matchedFiles, this.model.totalFiles, selected.length ? t(' · {0} selected', selected.length) : '');
    } else if (selected.length) {
      this.tree.message = t('{0} selected. Stage or unstage these files.', selected.length);
    } else {
      this.tree.message = this.model.totalFiles === 0 ? t('No local changes.') : undefined;
    }
    const contexts = {
      'repolens.hasSelection': selected.length > 0,
      'repolens.hasWorkingSelection': selected.some(node => node.kind === 'working'),
      'repolens.hasIndexSelection': selected.some(node => node.kind === 'index'),
      'repolens.hasFilter': Boolean(this.filterText || this.filterStatus !== 'all'),
      'repolens.grouping': this.grouping,
      'repolens.layout': this.mode
    };
    this.presentationContexts ||= new Map();
    for (const [key, value] of Object.entries(contexts)) {
      if (this.presentationContexts.get(key) !== value) {
        this.presentationContexts.set(key, value);
        Promise.resolve(this.vscode.commands.executeCommand('setContext', key, value)).catch(error => this.logError(error));
      }
    }
  }

  getChildren(node) {
    return node ? (this.model.nodeById.get(node.id)?.children || []) : this.model.roots;
  }

  getParent(node) {
    return this.parents.get(node.id);
  }

  getTreeItem(element) {
    const node = this.model.nodeById.get(element.id) || element;
    const vscode = this.vscode;
    const filtering = Boolean(this.filterText || this.filterStatus !== 'all');
    const expansion = filtering ? this.searchExpansion : this.expansion;
    const expanded = expansion[node.id] ?? node.expandByDefault;
    const state = node.children.length === 0 ? vscode.TreeItemCollapsibleState.None
      : expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
    const item = new vscode.TreeItem(node.label, state);
    item.id = node.id;
    item.description = node.description;
    item.tooltip = node.tooltip;
    if (node.type === 'file') {
      item.resourceUri = node.uri;
      item.command = { command: 'repolens.openChange', title: t('Open diff'), arguments: [node] };
      const submodule = this.submodules?.get(node.repoKey)?.has(node.uri.fsPath);
      item.contextValue = submodule ? 'repolens.submodule' : `repolens.${node.kind}`;
      item.iconPath = node.kind === 'conflict'
        ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('gitDecoration.conflictingResourceForeground'))
        : vscode.ThemeIcon.File;
    } else {
      const color = node.iconColor || (node.type === 'repo' ? repositoryColor(node.repoKey) : undefined);
      item.iconPath = new vscode.ThemeIcon(node.icon || 'folder', color ? new vscode.ThemeColor(color) : undefined);
      const snapshot = this.snapshots.find(repo => repo.key === node.repoKey);
      item.contextValue = node.type === 'repo'
        ? (node.fileIds.some(id => this.model.nodeById.get(id)?.kind === 'index') && snapshot?.conflicts.length === 0 ? 'repolens.repoStaged' : 'repolens.repo')
        : node.type === 'changelist'
          ? `repolens.changelist${node.listId === 'default' ? 'Default' : ''}${node.active ? 'Active' : ''}`
          : `repolens.${node.type}`;
    }
    const selectable = node.fileIds.filter(id => {
      const file = this.model.nodeById.get(id);
      return file && !this.submodules?.get(file.repoKey)?.has(file.uri.fsPath);
    });
    if (selectable.length > 0) {
      const selectedCount = selectable.filter(id => this.selection.has(id)).length;
      item.checkboxState = selectedCount === selectable.length
        ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
      if (node.type !== 'file' && selectedCount > 0) {
        item.description = `${item.description ? `${item.description} · ` : ''}${t('{0} selected', selectedCount)}`;
      }
    }
    return item;
  }

  changeChecks(event) {
    if (this.disposed) return;
    for (const [element, state] of event.items || []) {
      const node = this.model.nodeById.get(element.id);
      if (!node) continue;
      for (const id of node.fileIds) {
        const file = this.model.nodeById.get(id);
        if (!file || file.kind === 'conflict' || this.submodules?.get(file.repoKey)?.has(file.uri.fsPath)) continue;
        if (state === this.vscode.TreeItemCheckboxState.Checked) this.selection.add(id);
        else this.selection.delete(id);
      }
    }
    this.updatePresentation();
    this.changeEmitter.fire();
  }

  selectedNodes() {
    return [...this.selection].map(id => this.model.nodeById.get(id)).filter(node => node?.type === 'file');
  }

  nodeFiles(node) {
    if (!node) return this.selectedNodes();
    const current = this.model.nodeById.get(node.id);
    if (!current) return [];
    return current.fileIds.map(id => this.model.nodeById.get(id)).filter(file => file?.type === 'file');
  }

  changelistDragAndDrop() {
    const mime = 'application/vnd.repolens.files';
    return {
      dragMimeTypes: [mime], dropMimeTypes: [mime],
      handleDrag: (sources, transfer, token) => {
        if (this.disposed || token?.isCancellationRequested) return;
        const ids = [...new Set(sources.flatMap(source => this.nodeFiles(source)).filter(file => file.kind !== 'conflict' &&
          !this.submodules?.get(file.repoKey)?.has(file.uri.fsPath)).map(file => file.id))];
        if (ids.length) transfer.set(mime, new this.vscode.DataTransferItem(JSON.stringify(ids)));
      },
      handleDrop: async (target, transfer, token) => {
        try {
          if (this.disposed || token?.isCancellationRequested) return;
          let list = target && this.model.nodeById.get(target.id);
          while (list && list.type !== 'changelist') list = this.parents.get(list.id);
          if (!list) return;
          const value = transfer.get(mime);
          if (!value) return;
          const ids = JSON.parse(await value.asString());
          if (this.disposed || token?.isCancellationRequested || !Array.isArray(ids)) return;
          const files = ids.map(id => this.model.nodeById.get(id)).filter(file => file?.type === 'file' &&
            file.kind !== 'conflict' && !this.submodules?.get(file.repoKey)?.has(file.uri.fsPath));
          if (!files.length) return;
          await this.changelists.move(files, list.listId);
          this.selection.clear();
          this.publishTree();
        } catch (error) {
          await this.vscode.window.showErrorMessage(t('Could not update changelists: {0}', t(error.message)));
        }
      }
    };
  }

  async chooseGrouping() {
    const choice = await this.vscode.window.showQuickPick([
      { label: t('Group by Status'), value: 'status' },
      { label: t('Group by Changelist'), value: 'changelist' }
    ], { title: t('Group changes'), placeHolder: t('Choose how to organize changes') });
    if (!choice || this.disposed) return;
    await this.setGrouping(choice.value);
  }

  async setGrouping(value) {
    if (this.disposed) return;
    this.grouping = value === 'changelist' ? 'changelist' : 'status';
    this.selection.clear();
    await this.context.workspaceState.update('repolens.grouping', this.grouping);
    this.publishTree();
  }

  async editChangelist(action, node) {
    try {
      const list = this.changelists.lists.find(list => list.id === node?.listId);
      if (action !== 'create' && !list) return;
      if (action === 'activate') await this.changelists.setActive(list.id);
      else if (action === 'delete') {
        const answer = await this.vscode.window.showWarningMessage(t('Delete changelist “{0}”?', list.name), {
          modal: true, detail: t('Its files will move to Default Changes. File contents and Git staging will stay unchanged.')
        }, t('Delete changelist'));
        if (answer !== t('Delete changelist') || this.disposed) return;
        await this.changelists.remove(list.id);
      } else {
        const name = await this.vscode.window.showInputBox({
          title: t(action === 'create' ? 'New Changelist' : 'Rename Changelist'),
          prompt: t('Name this task or group of changes'), value: list?.name,
          validateInput: value => value.trim() && [...value.trim()].length <= 80 ? undefined : t('Enter a name between 1 and 80 characters.')
        });
        if (name === undefined || this.disposed) return;
        if (action === 'create') {
          const created = await this.changelists.create(name);
          await this.changelists.setActive(created.id);
          await this.setGrouping('changelist');
        } else await this.changelists.rename(list.id, name);
      }
      if (!this.disposed) this.publishTree();
    } catch (error) {
      await this.vscode.window.showErrorMessage(t('Could not update changelists: {0}', t(error.message)));
    }
  }

  async moveToChangelist(node) {
    try {
      const files = this.nodeFiles(node).filter(file => file.kind !== 'conflict' &&
        !this.submodules?.get(file.repoKey)?.has(file.uri.fsPath));
      if (!files.length) return;
      const choice = await this.vscode.window.showQuickPick([
        ...this.changelists.lists.map(list => ({ label: list.id === 'default' && list.name === 'Default' ? t('Default Changes') : list.name, listId: list.id,
          description: list.id === this.changelists.activeId ? t('Active') : undefined })),
        { label: t('New Changelist…'), create: true }
      ], { title: t('Move to Changelist'), placeHolder: t('Only the logical group changes; Git staging stays unchanged.') });
      if (!choice || this.disposed) return;
      let targetId = choice.listId;
      if (choice.create) {
        const name = await this.vscode.window.showInputBox({ title: t('New Changelist'), prompt: t('Name this task or group of changes') });
        if (name === undefined || this.disposed) return;
        targetId = (await this.changelists.create(name)).id;
      }
      // Ignore nodes removed while the picker was open. A move never writes Git.
      const current = files.filter(file => this.model.nodeById.has(file.id));
      await this.changelists.move(current, targetId);
      this.selection.clear();
      await this.setGrouping('changelist');
    } catch (error) {
      await this.vscode.window.showErrorMessage(t('Could not update changelists: {0}', t(error.message)));
    }
  }

  rememberExpansion(node, expanded) {
    if (this.disposed || !node || this.model.nodeById.get(node.id) !== node) return;
    if (this.filterText || this.filterStatus !== 'all') this.searchExpansion[node.id] = expanded;
    else {
      this.expansion[node.id] = expanded;
      if (this.expandAllOperation) return;
      Promise.resolve(this.context.workspaceState.update('repolens.expansion', this.expansion)).catch(error => this.logError(error));
    }
  }

  async expandAll() {
    if (this.disposed) return { expanded: 0, cancelled: true };
    const existing = this.expandAllOperation;
    if (existing?.model === this.model) return existing.promise;
    const operation = {
      model: this.model, filterText: this.filterText, filterStatus: this.filterStatus,
      expansion: this.filterText || this.filterStatus !== 'all' ? this.searchExpansion : this.expansion,
      filtered: Boolean(this.filterText || this.filterStatus !== 'all'), expanded: new Set()
    };
    this.expandAllOperation = operation;
    operation.promise = this.revealAllBranches(operation);
    return operation.promise;
  }

  async revealAllBranches(operation) {
    const current = () => !this.disposed && this.expandAllOperation === operation &&
      this.model === operation.model && this.filterText === operation.filterText && this.filterStatus === operation.filterStatus;
    const result = cancelled => ({ expanded: operation.expanded.size, ...(cancelled ? { cancelled: true } : {}) });
    const queue = operation.model.roots.filter(node => node.children.length);
    try {
      for (let cursor = 0; cursor < queue.length; cursor++) {
        if (!current()) return result(true);
        const anchor = queue[cursor];
        // The public API caps expansion at three levels. Cover branches in
        // chunks, then reveal the deeper frontier without selecting any files.
        await this.tree.reveal(anchor, { expand: 3, select: false, focus: false });
        if (!current()) return result(true);
        const cover = (node, depth) => {
          if (!node.children.length) return;
          if (depth === 3) { queue.push(node); return; }
          operation.expansion[node.id] = true;
          operation.expanded.add(node.id);
          for (const child of node.children) cover(child, depth + 1);
        };
        cover(anchor, 0);
      }
      if (current() && !operation.filtered && operation.expanded.size) {
        await this.context.workspaceState.update('repolens.expansion', { ...operation.expansion });
      }
      return result(!current());
    } catch (error) {
      if (!current()) return result(true);
      this.logError(error);
      await this.vscode.window.showErrorMessage(t('Could not expand all changes: {0}', error?.message || String(error)));
      return { ...result(false), failed: true };
    } finally {
      if (this.expandAllOperation === operation) this.expandAllOperation = undefined;
    }
  }

  async restoreLayout() {
    try {
      return await restoreSourceControlLayout(this.vscode);
    } catch (error) {
      if (!this.disposed) {
        this.logError(error);
        await this.vscode.window.showErrorMessage(t('Could not restore the Source Control layout: {0}', error?.message || String(error)));
      }
      return undefined;
    }
  }

  applyFilter(text, status = 'all') {
    if (this.disposed) return;
    this.filterText = String(text || '').trim();
    this.filterStatus = ['conflict', 'tracked', 'untracked'].includes(status) ? status : 'all';
    // Do not leave hidden checked files behind when changing the operation scope.
    this.selection.clear();
    this.searchExpansion = {};
    this.publishTree();
  }

  async chooseFilter() {
    const choice = await this.vscode.window.showQuickPick([
      { label: t('Search files, folders, repositories, or branches…'), action: 'search', description: this.filterText || undefined },
      { label: t('All'), status: 'all' },
      { label: t('Changes only'), status: 'tracked' },
      { label: t('Untracked only'), status: 'untracked' },
      { label: t('Conflicts only'), status: 'conflict' },
      { label: t('Clear all filters'), action: 'clear' }
    ], { title: t('JetBrains-style Changes · Filter changes'), placeHolder: t('Choose which changes to show') });
    if (!choice || this.disposed) return;
    if (choice.action === 'search') {
      const value = await this.vscode.window.showInputBox({
        title: t('Search changes'), prompt: t('Match file paths, repository names, or branches'), value: this.filterText
      });
      if (value !== undefined) this.applyFilter(value, this.filterStatus);
    } else if (choice.action === 'clear') this.applyFilter('', 'all');
    else this.applyFilter(this.filterText, choice.status);
  }

  async setLayout(mode) {
    if (this.disposed) return;
    this.mode = mode === 'list' ? 'list' : 'tree';
    await this.context.workspaceState.update('repolens.layout', this.mode);
    this.publishTree();
  }

  async openChange(node) {
    if (this.disposed) return;
    if (node?.type === 'file') this.activeFileId = node.id;
    return this.actions.openChange(node);
  }

  async navigate(direction) {
    const files = this.model.files;
    if (!files.length) return;
    const selected = this.tree.selection.find(node => node.type === 'file');
    const current = files.findIndex(file => file.id === (selected?.id || this.activeFileId));
    const index = current < 0 ? (direction > 0 ? 0 : files.length - 1)
      : (current + direction + files.length) % files.length;
    const node = files[index];
    await this.tree.reveal(node, { select: true, focus: false });
    return this.openChange(node);
  }

  async refresh() {
    if (this.disposed) return;
    await this.rescan();
    if (this.disposed) return;
    const results = await Promise.allSettled((this.api.repositories || []).map(repo => repo.status()));
    for (const result of results) if (result.status === 'rejected') this.logError(result.reason);
    this.refreshFromGit(true);
  }

  async rescan() {
    if (this.disposed) return;
    this.scanAgain = true;
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = (async () => {
      while (this.scanAgain && !this.disposed) {
        this.scanAgain = false;
        this.scanning = true;
        this.lastError = undefined;
        this.updatePresentation();
        try {
          const folders = this.vscode.workspace.workspaceFolders || [];
          if (folders.length === 0) continue;
          const start = Date.now();
          const batches = await Promise.all(folders.map(folder => {
            const config = this.vscode.workspace.getConfiguration('repolens', folder.uri);
            const gitConfig = this.vscode.workspace.getConfiguration('git', folder.uri);
            return this.discover([folder.uri.fsPath], {
              maxDepth: gitConfig.get('repositoryScanMaxDepth', 2),
              ignoredFolders: config.get('ignoredFolders', DEFAULT_IGNORED_FOLDERS),
              additionalRepositories: [...config.get('additionalRepositories', []), ...gitConfig.get('scanRepositories', [])]
            });
          }));
          if (this.disposed) return;
          const roots = [...new Set(batches.flat())];
          this.metrics = { directoryDiscoveryMs: Date.now() - start, discoveredRepositories: roots.length };
          this.output.appendLine(t('Repository discovery: {0} roots in {1}ms.', roots.length, this.metrics.directoryDiscoveryMs));
          let cursor = 0;
          const worker = async () => {
            while (cursor < roots.length && !this.disposed) {
              const root = roots[cursor++];
              if ((this.api.repositories || []).some(repo => path.normalize(repo.rootUri.fsPath) === path.normalize(root))) continue;
              try { await this.vscode.commands.executeCommand('git.openRepository', root); }
              catch (error) { this.logError(error); }
            }
          };
          await Promise.all(Array.from({ length: Math.min(4, roots.length) }, worker));
        } catch (error) {
          this.lastError = String(error?.message || error);
          this.logError(error);
        } finally {
          this.scanning = false;
          this.refreshFromGit(true);
        }
      }
    })().finally(() => { this.scanPromise = undefined; });
    return this.scanPromise;
  }

  diagnostics() {
    return {
      version: this.context.extension?.packageJSON?.version || PACKAGE_VERSION, gitState: this.api.state,
      workspaceFolders: (this.vscode.workspace.workspaceFolders || []).length,
      openedRepositories: (this.api.repositories || []).length,
      changedRepositories: this.snapshots.length,
      changedFiles: this.model.totalFiles, visibleFiles: this.model.matchedFiles,
      selectedRows: this.selection.size, layout: this.mode, grouping: this.grouping,
      changelists: this.changelists.lists.length, activeChangelist: this.changelists.activeId,
      filterText: this.filterText, filterStatus: this.filterStatus,
      ...this.metrics, scanning: Boolean(this.scanning), error: this.lastError
    };
  }

  async showDiagnostics() {
    const document = await this.vscode.workspace.openTextDocument({
      language: 'json', content: JSON.stringify(this.diagnostics(), null, 2)
    });
    return this.vscode.window.showTextDocument(document, { preview: true });
  }

  logError(error) {
    if (!this.disposed) this.output.appendLine(t('Error: {0}', error?.message || String(error)));
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.refreshTimer);
    clearTimeout(this.scanTimer);
    for (const disposable of this.repoListeners.values()) disposable.dispose();
    this.repoListeners.clear();
    for (const disposable of this.disposables.splice(0).reverse()) disposable?.dispose();
  }
}

module.exports = { RepoLensController };
