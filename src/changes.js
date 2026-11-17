'use strict';

const path = require('node:path');
const { t } = require('./i18n');

const STATUS_LABELS = [
  "Staged modification",
  "Staged addition",
  "Staged deletion",
  "Staged rename",
  "Staged copy",
  "Modified",
  "Deleted",
  "Untracked",
  "Ignored",
  "Intent to add",
  "Intent to rename",
  "Type changed",
  "Added by us (AU)",
  "Added by them (UA)",
  "Deleted by us (DU)",
  "Deleted by them (UD)",
  "Both added (AA)",
  "Both deleted (DD)",
  "Both modified (UU)"
];

function isConflict(change) {
  return change.status >= 12 && change.status <= 18;
}

function uniqueChanges(changes) {
  const result = new Map();
  for (const change of changes) {
    const key = change.uri.toString();
    if (!result.has(key)) result.set(key, change);
  }
  return [...result.values()];
}

function collectRepositories(repositories) {
  const result = [];
  for (const repo of repositories || []) {
    const state = repo.state || {};
    const working = uniqueChanges([
      ...(state.workingTreeChanges || []),
      ...(state.untrackedChanges || [])
    ]);
    const index = uniqueChanges(state.indexChanges || []);
    const conflicts = uniqueChanges([
      ...(state.mergeChanges || []),
      ...working,
      ...index
    ].filter(isConflict));
    const conflictKeys = new Set(conflicts.map(change => change.uri.toString()));
    const count = new Set([...working, ...index, ...conflicts].map(change => change.uri.toString())).size;
    if (count === 0) continue;

    result.push({
      key: repo.rootUri.toString(),
      rootUri: repo.rootUri,
      name: path.basename(repo.rootUri.fsPath),
      branch: state.HEAD?.name || state.HEAD?.commit?.slice(0, 8) || t('No branch checked out'),
      mergeInProgress: Boolean(state.mergeInProgress),
      count,
      working: working.filter(change => !conflictKeys.has(change.uri.toString())),
      index: index.filter(change => !conflictKeys.has(change.uri.toString())),
      conflicts
    });
  }
  return result.sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }) ||
    left.key.localeCompare(right.key));
}

function compactBranch(branch) {
  const compact = String(branch || t('No branch checked out')).replace(/^(?:feature|feat|bugfix|hotfix)\//i, '');
  return compact.length > 24 ? `${compact.slice(0, 21)}…` : compact;
}

function statusLabel(status) {
  return t(STATUS_LABELS[status] || 'Unknown status');
}

function diffCommand(vscode, gitAPI, repo, change, kind = 'working') {
  const native = { command: 'git.openChange', title: t('Open Changes'), arguments: [change.uri] };
  if (kind === 'conflict' || isConflict(change)) return native;

  const submodule = repo.state?.submodules?.some(item =>
    path.join(repo.rootUri.fsPath, item.path) === change.uri.fsPath);
  if (submodule) return native;

  const stagedRename = kind === 'working'
    ? repo.state?.indexChanges?.find(item => item.uri.toString() === change.uri.toString())?.renameUri
    : undefined;
  const workingUri = stagedRename || change.uri;

  const empty = () => vscode.Uri.from({
    scheme: 'repolens-empty',
    path: change.uri.path,
    query: kind
  });
  let original;
  let modified;
  if (kind === 'index') {
    switch (change.status) {
      case 0:
      case 3:
        original = gitAPI.toGitUri(change.originalUri || change.uri, 'HEAD');
        modified = gitAPI.toGitUri(change.uri, '');
        break;
      case 1:
      case 4:
        original = empty();
        modified = gitAPI.toGitUri(change.uri, '');
        break;
      case 2:
        original = gitAPI.toGitUri(change.uri, 'HEAD');
        modified = empty();
        break;
      default:
        return native;
    }
  } else if (kind === 'working') {
    switch (change.status) {
      case 5:
        original = gitAPI.toGitUri(change.uri, '~');
        modified = workingUri;
        break;
      case 6:
        original = gitAPI.toGitUri(change.uri, '~');
        modified = empty();
        break;
      case 7:
      case 8:
      case 9:
        original = empty();
        modified = workingUri;
        break;
      case 10:
      case 11:
        original = gitAPI.toGitUri(change.originalUri || change.uri, 'HEAD');
        modified = workingUri;
        break;
      default:
        return native;
    }
  } else {
    return native;
  }
  const filename = path.basename(change.uri.fsPath);
  return {
    command: 'vscode.diff',
    title: t('Open Changes'),
    arguments: [original, modified, t('{0} ({1})', filename, t(kind === 'index' ? 'Index' : 'Working Tree'))]
  };
}

module.exports = { collectRepositories, diffCommand, compactBranch, statusLabel };
