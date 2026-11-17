'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { prepareSelection, commitSelected, stashSelected } = require('../src/selected-git');

const gitPath = 'git';
function git(root, args, options = {}) {
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    for (const key of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete env[key];
    return execFileSync(gitPath, args, { cwd: root, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options });
}

async function fixture(t, initial = true) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repolens-selected-git-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.name', 'RepoLens Test']);
    git(root, ['config', 'user.email', 'repolens-test@example.invalid']);
    git(root, ['config', 'commit.gpgsign', 'false']);
    git(root, ['config', 'core.autocrlf', 'false']);
    git(root, ['config', 'core.hooksPath', path.join(root, 'owned-hooks')]);
    if (initial) {
        await fs.writeFile(path.join(root, 'a.txt'), 'base a\n');
        await fs.writeFile(path.join(root, 'b.txt'), 'base b\n');
        git(root, ['add', '.']);
        git(root, ['commit', '-m', 'initial']);
    }
    return root;
}

async function partial(root, file) {
    await fs.writeFile(path.join(root, file), `staged ${file}\n`);
    git(root, ['add', '--', file]);
    await fs.writeFile(path.join(root, file), `working ${file}\n`);
}

async function selectedOptions(root, files) {
    const options = { gitPath, root, files, message: 'selected changes' };
    options.expected = await prepareSelection(options);
    return options;
}

test('selected commit consumes full selected working file and preserves unrelated partial staging', async t => {
    const root = await fixture(t);
    await partial(root, 'a.txt');
    await partial(root, 'b.txt');
    const result = await commitSelected(await selectedOptions(root, ['a.txt']));
    assert.equal(git(root, ['show', 'HEAD:a.txt']), 'working a.txt\n');
    assert.equal(git(root, ['show', 'HEAD:b.txt']), 'base b\n');
    assert.equal(git(root, ['show', ':a.txt']), 'working a.txt\n');
    assert.equal(git(root, ['show', ':b.txt']), 'staged b.txt\n');
    assert.equal(await fs.readFile(path.join(root, 'b.txt'), 'utf8'), 'working b.txt\n');
    assert.equal(git(root, ['diff', '--cached', '--name-only']).trim(), 'b.txt');
    assert.match(result.commit, /^[0-9a-f]{40,64}$/);
});

test('selected commit includes new, deleted, renamed and literal special filenames', async t => {
    const root = await fixture(t);
    git(root, ['mv', 'a.txt', 'renamed file.txt']);
    git(root, ['rm', 'b.txt']);
    const names = ['new file.txt', ':(glob)*.txt', '-option.txt', 'line\nbreak.txt'];
    for (const file of names) await fs.writeFile(path.join(root, file), `content of ${file}`);
    await commitSelected(await selectedOptions(root, ['a.txt', 'b.txt', 'renamed file.txt', ...names]));
    assert.equal(git(root, ['ls-tree', '-r', '--name-only', '-z', 'HEAD']).split('\0').filter(Boolean).sort().join('\0'),
        ['renamed file.txt', ...names].sort().join('\0'));
    assert.equal(git(root, ['status', '--porcelain']), '');
});

test('initial selected commit excludes unrelated staged new files', async t => {
    const root = await fixture(t, false);
    await fs.writeFile(path.join(root, 'a.txt'), 'selected');
    await fs.writeFile(path.join(root, 'b.txt'), 'other');
    git(root, ['add', 'b.txt']);
    await commitSelected(await selectedOptions(root, ['a.txt']));
    assert.equal(git(root, ['ls-tree', '--name-only', 'HEAD']).trim(), 'a.txt');
    assert.equal(git(root, ['show', ':b.txt']), 'other');
});

test('failing commit hook leaves real index bytes, HEAD and working files unchanged', async t => {
    const root = await fixture(t);
    await partial(root, 'a.txt');
    await partial(root, 'b.txt');
    await fs.writeFile(path.join(root, 'new.txt'), 'new');
    const index = await fs.readFile(path.join(root, '.git/index'));
    const head = git(root, ['rev-parse', 'HEAD']);
    await fs.mkdir(path.join(root, 'owned-hooks'));
    await fs.writeFile(path.join(root, 'owned-hooks/pre-commit'), '#!/bin/sh\nprintf "fixture hook failure" >&2\nexit 1\n', { mode: 0o755 });
    await assert.rejects(commitSelected(await selectedOptions(root, ['a.txt', 'new.txt'])), /fixture hook failure/);
    assert.deepEqual(await fs.readFile(path.join(root, '.git/index')), index);
    assert.equal(git(root, ['rev-parse', 'HEAD']), head);
    assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'working a.txt\n');
    assert.equal(await fs.readFile(path.join(root, 'new.txt'), 'utf8'), 'new');
    await assert.rejects(fs.stat(path.join(root, '.git/index.lock')), { code: 'ENOENT' });
});

test('selected stash preserves unrelated staged and working content and restores selected partial staging on apply', async t => {
    const root = await fixture(t);
    await partial(root, 'a.txt');
    await partial(root, 'b.txt');
    await fs.writeFile(path.join(root, 'new file.txt'), 'new selected\n');
    await fs.writeFile(path.join(root, 'other.txt'), 'other untracked\n');
    const result = await stashSelected(await selectedOptions(root, ['a.txt', 'new file.txt']));
    assert.match(result.stash, /^[0-9a-f]{40,64}$/);
    assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'base a\n');
    await assert.rejects(fs.stat(path.join(root, 'new file.txt')), { code: 'ENOENT' });
    assert.equal(git(root, ['show', ':b.txt']), 'staged b.txt\n');
    assert.equal(await fs.readFile(path.join(root, 'b.txt'), 'utf8'), 'working b.txt\n');
    assert.equal(await fs.readFile(path.join(root, 'other.txt'), 'utf8'), 'other untracked\n');
    assert.equal(git(root, ['diff', '--name-only', 'stash@{0}^1', 'stash@{0}^2']).trim(), 'a.txt');
    assert.equal(git(root, ['diff', '--name-only', 'stash@{0}^1', 'stash@{0}']).trim(), 'a.txt');
    // Applying a conventional stash with --index needs a clean index; remove only the unrelated fixture changes.
    git(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', 'b.txt']);
    git(root, ['stash', 'apply', '--index']);
    assert.equal(git(root, ['show', ':a.txt']), 'staged a.txt\n');
    assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'working a.txt\n');
    assert.equal(await fs.readFile(path.join(root, 'new file.txt'), 'utf8'), 'new selected\n');
});

test('selected stash handles staged deletion and both sides of a rename', async t => {
    const root = await fixture(t);
    git(root, ['mv', 'a.txt', 'renamed file.txt']);
    git(root, ['rm', 'b.txt']);
    await stashSelected(await selectedOptions(root, ['a.txt', 'b.txt', 'renamed file.txt']));
    assert.equal(git(root, ['status', '--porcelain']), '');
    git(root, ['stash', 'apply', '--index']);
    assert.equal(await fs.readFile(path.join(root, 'renamed file.txt'), 'utf8'), 'base a\n');
    await assert.rejects(fs.stat(path.join(root, 'a.txt')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(root, 'b.txt')), { code: 'ENOENT' });
});

test('confirmation token detects same-status content and unrelated index changes', async t => {
    const root = await fixture(t);
    await partial(root, 'a.txt');
    const options = await selectedOptions(root, ['a.txt']);
    await fs.writeFile(path.join(root, 'a.txt'), 'working a different version\n');
    await assert.rejects(commitSelected(options), { code: 'SELECTED_GIT_STALE' });
    const next = await selectedOptions(root, ['a.txt']);
    await partial(root, 'b.txt');
    await assert.rejects(stashSelected(next), { code: 'SELECTED_GIT_STALE' });
});

test('selection rejects directories, metadata, outside paths and nested repositories', async t => {
    const root = await fixture(t);
    await fs.mkdir(path.join(root, 'nested'));
    git(path.join(root, 'nested'), ['init']);
    await fs.writeFile(path.join(root, 'nested/n.txt'), 'nested');
    for (const file of ['.', '.git/config', '../outside.txt', 'nested/n.txt', 'does-not-exist']) {
        await assert.rejects(prepareSelection({ gitPath, root, files: [file] }));
    }
});

test('existing Git index lock is preserved', async t => {
    const root = await fixture(t);
    await partial(root, 'a.txt');
    await fs.writeFile(path.join(root, '.git/index.lock'), 'owned by another operation');
    await assert.rejects(commitSelected(await selectedOptions(root, ['a.txt'])), { code: 'SELECTED_GIT_BUSY' });
    assert.equal(await fs.readFile(path.join(root, '.git/index.lock'), 'utf8'), 'owned by another operation');
});

test('merge state, conflicts and unavailable Git are rejected', async t => {
    const root = await fixture(t);
    await fs.writeFile(path.join(root, '.git/MERGE_HEAD'), git(root, ['rev-parse', 'HEAD']));
    await assert.rejects(prepareSelection({ gitPath, root, files: ['a.txt'] }), /merge, rebase or cherry-pick/);
    await fs.unlink(path.join(root, '.git/MERGE_HEAD'));
    const oid = git(root, ['rev-parse', 'HEAD:a.txt']).trim();
    git(root, ['update-index', '--index-info'], { input: `0 ${'0'.repeat(40)}\ta.txt\n100644 ${oid} 1\ta.txt\n100644 ${oid} 2\ta.txt\n` });
    await assert.rejects(prepareSelection({ gitPath, root, files: ['a.txt'] }), /merge conflicts/);
    await assert.rejects(prepareSelection({ gitPath: '/nonexistent/repolens-git', root, files: ['a.txt'] }), { code: 'SELECTED_GIT_UNAVAILABLE' });
});

test('untracked-only stash supports blank message, symlinks and literal special names', async t => {
    const root = await fixture(t);
    await fs.writeFile(path.join(root, ':(glob)*.txt'), 'literal content');
    await fs.symlink('a.txt', path.join(root, 'selected link'));
    const options = await selectedOptions(root, ['selected link', ':(glob)*.txt']);
    options.message = '';
    await stashSelected(options);
    assert.match(git(root, ['stash', 'list']), /JetBrains-style Changes selected files/);
    assert.equal(git(root, ['diff', '--name-only', 'stash@{0}^1', 'stash@{0}']).trim(), '');
    git(root, ['stash', 'apply', '--index']);
    assert.equal(await fs.readlink(path.join(root, 'selected link')), 'a.txt');
    assert.equal(await fs.readFile(path.join(root, ':(glob)*.txt'), 'utf8'), 'literal content');
});

test('clean selection creates no stash and leaves index bytes unchanged', async t => {
    const root = await fixture(t);
    const before = await fs.readFile(path.join(root, '.git/index'));
    await assert.rejects(stashSelected(await selectedOptions(root, ['a.txt'])), { code: 'SELECTED_GIT_NO_CHANGES' });
    assert.deepEqual(await fs.readFile(path.join(root, '.git/index')), before);
    assert.equal(git(root, ['stash', 'list']), '');
});

test('split index preserves unrelated partially staged blobs', async t => {
    const root = await fixture(t);
    git(root, ['update-index', '--split-index']);
    await partial(root, 'a.txt');
    await partial(root, 'b.txt');
    await commitSelected(await selectedOptions(root, ['a.txt']));
    assert.equal(git(root, ['show', ':b.txt']), 'staged b.txt\n');
    await partial(root, 'a.txt');
    await stashSelected(await selectedOptions(root, ['a.txt']));
    assert.equal(git(root, ['show', ':b.txt']), 'staged b.txt\n');
    assert.equal(await fs.readFile(path.join(root, 'b.txt'), 'utf8'), 'working b.txt\n');
});

test('selection rejects submodules and symbolic-link ancestor directories', async t => {
    const root = await fixture(t);
    const target = await fs.mkdtemp(path.join(os.tmpdir(), 'repolens-selected-outside-'));
    t.after(() => fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
    await fs.writeFile(path.join(target, 'outside.txt'), 'outside');
    await fs.symlink(target, path.join(root, 'linked-directory'));
    await assert.rejects(prepareSelection({ gitPath, root, files: ['linked-directory/outside.txt'] }), /symbolic-link directories/);
    const head = git(root, ['rev-parse', 'HEAD']).trim();
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${head},module`]);
    await assert.rejects(prepareSelection({ gitPath, root, files: ['module/file.txt'] }), /Submodule/);
});

test('same-repository operations reject concurrency while an owned hook is running', async t => {
    const root = await fixture(t);
    await partial(root, 'a.txt');
    const options = await selectedOptions(root, ['a.txt']);
    await fs.mkdir(path.join(root, 'owned-hooks'));
    const marker = path.join(root, 'owned-hook-started');
    const release = path.join(root, 'owned-hook-release');
    await fs.writeFile(path.join(root, 'owned-hooks/pre-commit'),
        '#!/bin/sh\ntouch owned-hook-started\nwhile ! test -f owned-hook-release; do sleep 0.05; done\n', { mode: 0o755 });
    const pending = commitSelected(options);
    try {
        const deadline = Date.now() + 10000;
        while (true) {
            try { await fs.stat(marker); break; }
            catch (error) { if (error.code !== 'ENOENT' || Date.now() > deadline) throw error; }
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        await assert.rejects(stashSelected(options), { code: 'SELECTED_GIT_BUSY' });
    }
    finally { await fs.writeFile(release, 'continue'); }
    await pending;
});

test('stash round trip preserves staged deletion with a recreated working file', async t => {
    const root = await fixture(t);
    git(root, ['rm', 'a.txt']);
    await fs.writeFile(path.join(root, 'a.txt'), 'recreated work\n');
    await stashSelected(await selectedOptions(root, ['a.txt']));
    assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'base a\n');
    assert.equal(git(root, ['show', 'stash@{0}:a.txt']), 'recreated work\n');
    git(root, ['stash', 'apply', '--index']);
    assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'recreated work\n');
    assert.equal(git(root, ['diff', '--cached', '--name-status']).trim(), 'D\ta.txt');
});

test('stash round trip preserves staged addition with a deleted working file', async t => {
    const root = await fixture(t);
    await fs.writeFile(path.join(root, 'new.txt'), 'staged new\n');
    git(root, ['add', 'new.txt']);
    await fs.unlink(path.join(root, 'new.txt'));
    await stashSelected(await selectedOptions(root, ['new.txt']));
    assert.equal(git(root, ['status', '--porcelain']), '');
    assert.equal(git(root, ['show', 'stash@{0}^2:new.txt']), 'staged new\n');
    git(root, ['stash', 'apply', '--index']);
    assert.equal(git(root, ['show', ':new.txt']), 'staged new\n');
    await assert.rejects(fs.stat(path.join(root, 'new.txt')), { code: 'ENOENT' });
});

test('post-commit temporary index failure reports that the commit already succeeded', async t => {
    const root = await fixture(t);
    const canonicalRoot = await fs.realpath(root);
    await partial(root, 'a.txt');
    const options = await selectedOptions(root, ['a.txt']);
    const before = await fs.readFile(path.join(root, '.git/index'));
    const originalWrite = fs.writeFile;
    let indexWrites = 0;
    let caught;
    fs.writeFile = async (file, ...args) => {
        if (typeof file === 'string' && file.startsWith(path.join(canonicalRoot, '.git/repolens-index-')) && ++indexWrites === 2) {
            throw Object.assign(new Error('owned fixture: no space for result index'), { code: 'ENOSPC' });
        }
        return originalWrite(file, ...args);
    };
    try { await commitSelected(options); }
    catch (error) { caught = error; }
    finally { fs.writeFile = originalWrite; }
    assert.equal(caught?.code, 'SELECTED_GIT_COMMITTED');
    assert.equal(caught.commit, git(root, ['rev-parse', 'HEAD']).trim());
    assert.match(caught.message, /succeeded/);
    assert.equal(git(root, ['show', 'HEAD:a.txt']), 'working a.txt\n');
    assert.deepEqual(await fs.readFile(path.join(root, '.git/index')), before);
    await assert.rejects(fs.stat(path.join(root, '.git/index.lock')), { code: 'ENOENT' });
});

test('post-commit HEAD read failure still reports a successful commit without inventing an oid', async t => {
    const root = await fixture(t);
    await partial(root, 'a.txt');
    await fs.mkdir(path.join(root, 'owned-hooks'));
    await fs.writeFile(path.join(root, 'owned-hooks/post-commit'), '#!/bin/sh\ntouch .git/owned-commit-done\n', { mode: 0o755 });
    const wrapper = path.join(root, 'owned-git');
    await fs.writeFile(wrapper, '#!/bin/sh\nif test -f .git/owned-commit-done && test "$1" = rev-parse && test "$2" = --verify && test "$3" = HEAD; then echo "owned fixture HEAD read failure" >&2; exit 1; fi\nexec /usr/bin/git "$@"\n', { mode: 0o755 });
    const options = { gitPath: wrapper, root, files: ['a.txt'], message: 'selected changes' };
    options.expected = await prepareSelection(options);
    await assert.rejects(commitSelected(options), error => {
        assert.equal(error.code, 'SELECTED_GIT_COMMITTED');
        assert.equal(error.commit, undefined);
        assert.match(error.message, /Commit succeeded/);
        return true;
    });
    assert.equal(git(root, ['show', 'HEAD:a.txt']), 'working a.txt\n');
});

test('stash cleanup and recovery-backup failures still expose the saved stash oid', async t => {
    const root = await fixture(t);
    const canonicalRoot = await fs.realpath(root);
    await partial(root, 'a.txt');
    await fs.writeFile(path.join(root, 'new.txt'), 'owned selected untracked\n');
    const options = await selectedOptions(root, ['a.txt', 'new.txt']);
    const originalUnlink = fs.unlink;
    const originalMkdtemp = fs.mkdtemp;
    let caught;
    fs.unlink = async (file, ...args) => {
        if (file === path.join(canonicalRoot, 'new.txt')) throw Object.assign(new Error('owned fixture cleanup denied'), { code: 'EACCES' });
        return originalUnlink(file, ...args);
    };
    fs.mkdtemp = async (prefix, ...args) => {
        if (typeof prefix === 'string' && path.basename(prefix) === 'repolens-selected-recovery-') {
            throw Object.assign(new Error('owned fixture backup disk full'), { code: 'ENOSPC' });
        }
        return originalMkdtemp(prefix, ...args);
    };
    try { await stashSelected(options); }
    catch (error) { caught = error; }
    finally { fs.unlink = originalUnlink; fs.mkdtemp = originalMkdtemp; }
    assert.equal(caught?.code, 'SELECTED_GIT_RECOVERY');
    assert.equal(caught.stash, git(root, ['rev-parse', 'refs/stash']).trim());
    assert.equal(caught.recoveryPath, undefined);
    assert.match(caught.message, /was saved/);
    assert.match(caught.message, /backups could not be written/);
    assert.equal(git(root, ['show', 'stash@{0}:a.txt']), 'working a.txt\n');
    assert.equal(git(root, ['show', 'stash@{0}^3:new.txt']), 'owned selected untracked\n');
    await assert.rejects(fs.stat(path.join(root, '.git/index.lock')), { code: 'ENOENT' });
});
