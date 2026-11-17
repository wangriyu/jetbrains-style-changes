'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { discoverRepositoryRoots, DEFAULT_MAX_DEPTH } = require('../src/discovery');

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'repolens-discovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

async function repository(directory, markerFile = false) {
  await fs.mkdir(directory, { recursive: true });
  if (markerFile) await fs.writeFile(path.join(directory, '.git'), 'gitdir: ../git-storage\n');
  else await fs.mkdir(path.join(directory, '.git'));
  return directory;
}

test('defaults to two levels and discovers nested repositories below a Git workspace', async t => {
  const root = await temporaryDirectory(t);
  await repository(root);
  const service = await repository(path.join(root, 'service'));
  const nested = await repository(path.join(root, 'frontend', 'console'));
  const insideService = await repository(path.join(service, 'nested'));
  await repository(path.join(root, 'frontend', 'deep', 'too-far'));
  assert.equal(DEFAULT_MAX_DEPTH, 2);
  assert.deepEqual(await discoverRepositoryRoots([root]), [root, service, nested, insideService].sort());
});

test('honors zero and one depth limits and accepts .git files', async t => {
  const root = await temporaryDirectory(t);
  await repository(root);
  const linkedWorktree = await repository(path.join(root, 'worktree'), true);
  await repository(path.join(root, 'group', 'deep'));
  assert.deepEqual(await discoverRepositoryRoots([root], { maxDepth: 0 }), [root]);
  assert.deepEqual(await discoverRepositoryRoots([root], { maxDepth: 1 }), [root, linkedWorktree].sort());
});

test('skips hidden, dependency and default output directories', async t => {
  const root = await temporaryDirectory(t);
  for (const name of ['.hidden', 'node_modules', 'dist', 'build', 'vendor']) {
    await repository(path.join(root, name));
  }
  const visible = await repository(path.join(root, 'visible'));
  assert.deepEqual(await discoverRepositoryRoots([root]), [visible]);
});

test('allows custom ignored folder names while retaining mandatory exclusions', async t => {
  const root = await temporaryDirectory(t);
  await repository(path.join(root, 'cache'));
  await repository(path.join(root, 'node_modules'));
  const customOutput = await repository(path.join(root, 'dist'));
  assert.deepEqual(await discoverRepositoryRoots([root], { ignoredFolders: ['cache'] }), [customOutput]);
});

test('exact additional paths include hidden and deep repositories, not glob patterns', async t => {
  const root = await temporaryDirectory(t);
  const hidden = await repository(path.join(root, '.worktrees', 'feature', 'repo'), true);
  const deep = await repository(path.join(root, 'group', 'one', 'two', 'repo'));
  await repository(path.join(root, 'frontend', 'console'));
  assert.deepEqual(await discoverRepositoryRoots([root], {
    maxDepth: 0,
    additionalRepositories: ['.worktrees/feature/repo', 'group/one/two/repo', 'frontend/*'],
  }), [hidden, deep].sort());
});

test('rejects absolute and escaping additional paths', async t => {
  const base = await temporaryDirectory(t);
  const root = path.join(base, 'workspace');
  await fs.mkdir(root);
  const outside = await repository(path.join(base, 'outside'));
  const inside = await repository(path.join(root, 'inside'));
  assert.deepEqual(await discoverRepositoryRoots([root], {
    maxDepth: 0,
    additionalRepositories: [outside, '../outside', 'inside/../../outside', 'inside'],
  }), [inside]);
});

test('normalizes overlapping workspace paths and preserves each root depth budget', async t => {
  const root = await temporaryDirectory(t);
  const ancestor = path.join(root, 'group');
  const deep = await repository(path.join(ancestor, 'one', 'repo'));
  assert.deepEqual(await discoverRepositoryRoots([root, path.join(root, '.'), ancestor]), [deep]);
});

test('does not follow symlink directories, including explicit paths and workspace roots', async t => {
  const base = await temporaryDirectory(t);
  const root = path.join(base, 'workspace');
  await fs.mkdir(root);
  const outside = await repository(path.join(base, 'outside'));
  const link = path.join(root, 'linked');
  try {
    await fs.symlink(outside, link, 'dir');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('Directory symlinks unavailable');
    throw error;
  }
  assert.deepEqual(await discoverRepositoryRoots([root, link], {
    additionalRepositories: ['linked'],
  }), []);
});

test('returns empty for no roots and tolerates missing or unreadable directories', async t => {
  const root = await temporaryDirectory(t);
  const inaccessible = path.join(root, 'blocked');
  await fs.mkdir(inaccessible);
  const visible = await repository(path.join(root, 'visible'));
  const original = fs.readdir;
  t.mock.method(fs, 'readdir', async (directory, options) => {
    if (directory === inaccessible) throw Object.assign(new Error('Denied'), { code: 'EACCES' });
    return original(directory, options);
  });
  assert.deepEqual(await discoverRepositoryRoots([]), []);
  assert.deepEqual(await discoverRepositoryRoots(undefined), []);
  assert.deepEqual(await discoverRepositoryRoots([path.join(root, 'missing'), root]), [visible]);
});

test('limits concurrent directory work while scanning wide workspaces', async t => {
  const root = await temporaryDirectory(t);
  for (let index = 0; index < 24; index += 1) {
    await fs.mkdir(path.join(root, `folder-${index}`));
  }
  const original = fs.readdir;
  let active = 0;
  let maximum = 0;
  t.mock.method(fs, 'readdir', async (...args) => {
    active += 1;
    maximum = Math.max(maximum, active);
    try {
      await new Promise(resolve => setImmediate(resolve));
      return await original(...args);
    } finally {
      active -= 1;
    }
  });
  assert.deepEqual(await discoverRepositoryRoots([root]), []);
  assert.ok(maximum > 1, 'Wide scanning should use more than one worker');
  assert.ok(maximum <= 8, `Unexpected filesystem concurrency: ${maximum}`);
});
