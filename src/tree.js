'use strict';

const path = require('node:path');
const { compactBranch, statusLabel } = require('./changes');
const { t } = require('./i18n');

const CATEGORIES = [
  { key: 'conflict', label: 'Merge Conflicts', kind: 'conflict', icon: 'warning' },
  { key: 'tracked', label: 'Changes', kind: 'working', icon: 'git-compare' },
  { key: 'untracked', label: 'Untracked', kind: 'working', icon: 'add' }
];

const countLabel = count => t(count === 1 ? '{0} file' : '{0} files', count);

function id(type, ...parts) {
  return JSON.stringify([type, ...parts]);
}

function node(data) {
  return {
    description: '', tooltip: '', expandByDefault: false,
    count: 0, children: [], fileIds: [], ...data
  };
}

function relativePath(snapshot, uri) {
  const relative = path.relative(snapshot.rootUri.fsPath, uri.fsPath);
  return (path.isAbsolute(relative) ? path.basename(uri.fsPath) : relative || path.basename(uri.fsPath))
    .split(path.sep).join('/');
}

function fileCount(files) {
  return new Set(files.map(file => id('path', file.repoKey, file.uri.toString()))).size;
}

function compareText(left, right) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function compareNodes(left, right) {
  if (left.type === 'folder' && right.type !== 'folder') return -1;
  if (right.type === 'folder' && left.type !== 'folder') return 1;
  return compareText(left.label, right.label) || compareText(left.description, right.description) || left.id.localeCompare(right.id);
}

function fileIcon(status, kind) {
  if (kind === 'conflict') return { icon: 'warning', iconColor: 'gitDecoration.conflictingResourceForeground' };
  if ([1, 7, 8, 9].includes(status)) return { icon: 'add', iconColor: 'gitDecoration.addedResourceForeground' };
  if ([2, 6].includes(status)) return { icon: 'remove', iconColor: 'gitDecoration.deletedResourceForeground' };
  if ([3, 10].includes(status)) return { icon: 'arrow-right', iconColor: 'gitDecoration.renamedResourceForeground' };
  if (status === 4) return { icon: 'copy', iconColor: 'gitDecoration.addedResourceForeground' };
  return { icon: 'circle-small-filled', iconColor: 'gitDecoration.modifiedResourceForeground' };
}

function makeFile(snapshot, change, kind, relative, mode) {
  const slash = relative.lastIndexOf('/');
  const phase = t(kind === 'index' ? 'Staged' : kind === 'conflict' ? 'Merge Conflicts' : 'Working Tree');
  return node({
    id: id('file', snapshot.key, kind, change.uri.toString()),
    type: 'file',
    label: path.basename(change.uri.fsPath),
    description: mode === 'list' && slash >= 0 ? relative.slice(0, slash) : '',
    tooltip: `${relative}\n${statusLabel(change.status)}\n${snapshot.name} · ${snapshot.branch} · ${phase}`,
    repoKey: snapshot.key, kind, uri: change.uri, change,
    ...fileIcon(change.status, kind)
  });
}

function fileChildren(records, mode, snapshot, category, kind) {
  if (mode === 'list') return records.map(record => record.file).sort(compareNodes);
  const children = [];
  const folders = new Map();
  for (const record of records) {
    const parts = record.relative.split('/');
    parts.pop();
    let siblings = children;
    let relative = '';
    for (const part of parts) {
      relative = relative ? `${relative}/${part}` : part;
      let folder = folders.get(relative);
      if (!folder) {
        folder = node({
          id: id('folder', category, snapshot.key, kind, relative),
          type: 'folder', label: part, tooltip: relative,
          icon: 'folder', repoKey: snapshot.key, kind
        });
        folders.set(relative, folder);
        siblings.push(folder);
      }
      siblings = folder.children;
    }
    siblings.push(record.file);
  }
  const compact = item => {
    item.children = item.children.map(compact).sort(compareNodes);
    while (item.type === 'folder' && item.children.length === 1 && item.children[0].type === 'folder') {
      const child = item.children[0];
      item.label = `${item.label}/${child.label}`;
      item.tooltip = child.tooltip;
      item.children = child.children;
    }
    return item;
  };
  return children.map(compact).sort(compareNodes);
}

function buildTree(snapshots, options = {}) {
  const mode = options.mode === 'list' ? 'list' : 'tree';
  const query = String(options.filterText || '').trim().replace(/\\/g, '/').toLowerCase();
  const status = ['conflict', 'tracked', 'untracked'].includes(options.filterStatus) ? options.filterStatus : 'all';
  const threshold = Number.isFinite(options.collapseThreshold) ? Math.max(0, options.collapseThreshold) : 20;
  const byList = options.grouping === 'changelist';
  const listDefinitions = (options.changelists || []).map(list => ({
    key: `list:${list.id}`, listId: list.id, label: list.id === 'default' && list.name === 'Default' ? t('Default Changes') : list.name,
    kind: 'working', icon: 'list-unordered', active: list.id === options.activeListId
  }));
  const definitions = byList ? [CATEGORIES[0], ...listDefinitions] : CATEGORIES;
  const categories = new Map(definitions.map(category => [category.key, new Map()]));
  const allPaths = new Set();
  const seenRows = new Set();
  const metadata = new WeakMap();

  const add = (snapshot, change, kind, category) => {
    allPaths.add(id('path', snapshot.key, change.uri.toString()));
    const rowId = id('file', snapshot.key, kind, change.uri.toString());
    if (seenRows.has(rowId)) return;
    seenRows.add(rowId);
    if (status !== 'all' && status !== category) return;
    const relative = relativePath(snapshot, change.uri);
    if (query && ![snapshot.name, snapshot.branch, relative].some(value => String(value || '').toLowerCase().includes(query))) return;
    const categoryKey = byList && category !== 'conflict'
      ? `list:${options.listFor?.(snapshot.key, change.uri.toString()) || 'default'}` : category;
    const repositories = categories.get(categoryKey);
    if (!repositories) return;
    let group = repositories.get(snapshot.key);
    if (!group) {
      group = { snapshot, records: [] };
      repositories.set(snapshot.key, group);
    }
    group.records.push({ file: makeFile(snapshot, change, kind, relative, mode), relative });
  };

  for (const snapshot of snapshots || []) {
    const conflictPaths = new Set((snapshot.conflicts || []).map(change => change.uri.toString()));
    for (const change of snapshot.conflicts || []) add(snapshot, change, 'conflict', 'conflict');
    for (const change of snapshot.working || []) {
      if (conflictPaths.has(change.uri.toString())) continue;
      add(snapshot, change, 'working', [7, 8].includes(change.status) ? 'untracked' : 'tracked');
    }
    for (const change of snapshot.index || []) {
      if (!conflictPaths.has(change.uri.toString())) add(snapshot, change, 'index', 'tracked');
    }
  }

  const roots = [];
  for (const category of definitions) {
    const groups = [...categories.get(category.key).values()];
    if (groups.length === 0 && (!category.listId || query || status !== 'all')) continue;
    groups.sort((left, right) => compareText(left.snapshot.name, right.snapshot.name) || left.snapshot.key.localeCompare(right.snapshot.key));
    const categoryNode = node({
      id: id(category.listId ? 'changelist' : 'category', category.listId || category.key),
      type: category.listId ? 'changelist' : 'category', label: category.listId ? category.label : t(category.label),
      kind: category.kind, icon: category.icon,
      ...(category.listId ? { listId: category.listId, active: category.active } : {}),
      ...(category.key === 'conflict' ? { iconColor: 'gitDecoration.conflictingResourceForeground' } : {})
    });
    metadata.set(categoryNode, { category: category.key });
    for (const { snapshot, records } of groups) {
      const kinds = new Set(records.map(record => record.file.kind));
      const kind = kinds.size === 1 ? records[0].file.kind : 'working';
      const repoNode = node({
        id: id('repo', category.key, snapshot.key), type: 'repo',
        label: snapshot.name, icon: 'repo', repoKey: snapshot.key, kind
      });
      metadata.set(repoNode, { snapshot, category: category.key, indexOnly: kind === 'index' });
      if (category.key !== 'conflict' && kinds.has('working') && kinds.has('index')) {
        for (const phase of ['working', 'index']) {
          const stage = node({
            id: id('stage', category.key, snapshot.key, phase), type: 'stage',
            label: t(phase === 'index' ? 'Staged' : 'Working Tree'), icon: phase === 'index' ? 'check' : 'edit',
            repoKey: snapshot.key, kind: phase,
            children: fileChildren(records.filter(record => record.file.kind === phase), mode, snapshot, category.key, phase)
          });
          repoNode.children.push(stage);
        }
      } else {
        repoNode.children = fileChildren(records, mode, snapshot, category.key, kind);
      }
      categoryNode.children.push(repoNode);
    }
    roots.push(categoryNode);
  }

  const nodeById = new Map();
  const files = [];
  const visit = item => {
    nodeById.set(item.id, item);
    if (item.type === 'file') {
      item.count = 1;
      item.fileIds = item.kind === 'conflict' ? [] : [item.id];
      files.push(item);
      return [item];
    }
    const descendants = item.children.flatMap(visit);
    item.count = fileCount(descendants);
    item.fileIds = item.kind === 'conflict' ? [] : [...new Set(descendants.map(file => file.id))];
    const meta = metadata.get(item);
    item.expandByDefault = Boolean(query) || ['category', 'changelist'].includes(item.type) || item.count < threshold;
    if (item.type === 'category' || item.type === 'changelist') {
      item.description = `${countLabel(item.count)}${item.active ? t(' · Active') : ''}`;
      item.tooltip = t('{0}: {1}', item.label, countLabel(item.count));
    } else if (item.type === 'repo') {
      const { snapshot } = meta;
      item.description = `${compactBranch(snapshot.branch)} · ${countLabel(item.count)}${meta.indexOnly ? t(' · Staged') : ''}${snapshot.mergeInProgress ? t(' · Merging') : ''}`;
      item.tooltip = `${snapshot.name}\n${snapshot.branch}\n${snapshot.rootUri.fsPath}`;
    } else if (item.type === 'stage') {
      item.description = countLabel(item.count);
      item.tooltip = t('{0}: {1}', item.label, countLabel(item.count));
    }
    return descendants;
  };
  for (const root of roots) visit(root);
  return {
    roots, nodeById, files,
    totalFiles: allPaths.size,
    matchedFiles: fileCount(files),
    repositoryCount: new Set(files.map(file => file.repoKey)).size
  };
}

module.exports = { buildTree };
