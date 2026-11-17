'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_MAX_DEPTH = 2;
const CONCURRENCY = 8;
const DEFAULT_IGNORED_FOLDERS = Object.freeze([
  'node_modules', '.git', 'vendor', 'dist', 'build', 'out', 'target',
  '.venv', '__pycache__',
]);

async function inBatches(items, operation) {
  const results = [];
  for (let offset = 0; offset < items.length; offset += CONCURRENCY) {
    results.push(...await Promise.all(items.slice(offset, offset + CONCURRENCY).map(operation)));
  }
  return results;
}

async function canonicalWorkspacePath(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const absolute = path.resolve(value);
    const stat = await fs.lstat(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    return path.normalize(await fs.realpath(absolute));
  } catch {
    return undefined;
  }
}

async function isRepository(directory) {
  try {
    const marker = await fs.lstat(path.join(directory, '.git'));
    return marker.isDirectory() || marker.isFile();
  } catch {
    return false;
  }
}

async function explicitRepositoryPath(workspace, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 ||
      path.isAbsolute(relativePath) || /[*?\[\]{}]/.test(relativePath)) return undefined;
  const candidate = path.resolve(workspace, relativePath);
  const relative = path.relative(workspace, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined;
  }
  let current = workspace;
  try {
    // Explicit paths may include hidden folders, but must not traverse a symlink.
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    }
    return await isRepository(current) ? path.normalize(current) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Find Git roots with filesystem marker checks only. The workspace root is depth
 * zero; additionalRepositories contains exact paths relative to each workspace.
 */
async function discoverRepositoryRoots(workspacePaths = [], options = {}) {
  if (!Array.isArray(workspacePaths) || workspacePaths.length === 0) return [];
  const maxDepth = Number.isInteger(options.maxDepth) && options.maxDepth >= 0
    ? options.maxDepth : DEFAULT_MAX_DEPTH;
  const ignoredFolders = new Set(Array.isArray(options.ignoredFolders)
    ? options.ignoredFolders.filter(value => typeof value === 'string')
    : DEFAULT_IGNORED_FOLDERS);
  ignoredFolders.add('.git');
  ignoredFolders.add('node_modules');
  const workspaces = [...new Set((await inBatches(workspacePaths, canonicalWorkspacePath)).filter(Boolean))];
  const repositories = new Set();
  const budgets = new Map();
  const queue = [];
  const enqueue = (directory, budget) => {
    if ((budgets.get(directory) ?? -1) >= budget) return;
    budgets.set(directory, budget);
    queue.push({ directory, budget });
  };
  for (const workspace of workspaces) enqueue(workspace, maxDepth);

  let cursor = 0;
  while (cursor < queue.length) {
    const batch = queue.slice(cursor, cursor + CONCURRENCY);
    cursor += batch.length;
    await Promise.all(batch.map(async ({ directory, budget }) => {
      if (budgets.get(directory) > budget) return;
      try {
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return;
        if (await isRepository(directory)) repositories.add(directory);
        if (budget === 0) return;
        const entries = await fs.readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.') ||
              ignoredFolders.has(entry.name)) continue;
          enqueue(path.join(directory, entry.name), budget - 1);
        }
      } catch {
        // One inaccessible directory must not prevent discovery in its siblings.
      }
    }));
  }

  const additional = Array.isArray(options.additionalRepositories) ? options.additionalRepositories : [];
  const candidates = workspaces.flatMap(workspace => additional.map(relativePath => ({ workspace, relativePath })));
  for (const repository of await inBatches(candidates,
    ({ workspace, relativePath }) => explicitRepositoryPath(workspace, relativePath))) {
    if (repository) repositories.add(repository);
  }
  return [...repositories].sort();
}

module.exports = { discoverRepositoryRoots, DEFAULT_MAX_DEPTH, DEFAULT_IGNORED_FOLDERS };
