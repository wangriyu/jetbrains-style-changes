'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');

const running = new Set();
const hash = value => createHash('sha256').update(value).digest('hex');
const nulPaths = files => Buffer.from(`${files.join('\0')}\0`);
const inside = (root, target) => {
    const relative = path.relative(root, target);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function failure(message, code = 'SELECTED_GIT_INVALID') {
    const error = new Error(message);
    error.code = code;
    return error;
}

function environment(index) {
    const env = { ...process.env };
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[name];
    Object.assign(env, { GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
    if (index) env.GIT_INDEX_FILE = index;
    return env;
}

function git(context, args, { input, index, allowFailure = false } = {}) {
    return new Promise((resolve, reject) => {
        let child;
        const stdout = [];
        const stderr = [];
        try {
            child = spawn(context.gitPath, args, { cwd: context.root, env: environment(index), windowsHide: true });
        }
        catch (error) { reject(failure(`Git is unavailable: ${error.message}`, 'SELECTED_GIT_UNAVAILABLE')); return; }
        child.stdout.on('data', data => stdout.push(data));
        child.stderr.on('data', data => stderr.push(data));
        child.on('error', error => reject(failure(`Git is unavailable: ${error.message}`, 'SELECTED_GIT_UNAVAILABLE')));
        child.on('close', code => {
            const result = { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
            if (code === 0 || allowFailure) resolve(result);
            else reject(failure(result.stderr.toString().trim() || `Git exited with code ${code}.`, 'SELECTED_GIT_FAILED'));
        });
        // Git may reject before reading a pathspec (for example, an unsupported option).
        child.stdin.on('error', () => {});
        child.stdin.end(input);
    });
}

async function readOptional(file) {
    try { return await fs.readFile(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function exists(file) {
    try { await fs.lstat(file); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function head(context) {
    const revision = await git(context, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
    const branch = await git(context, ['symbolic-ref', '-q', 'HEAD'], { allowFailure: true });
    return { oid: revision.code === 0 ? revision.stdout.toString().trim() : null, branch: branch.stdout.toString().trim() };
}

async function fileState(file) {
    let stat;
    try { stat = await fs.lstat(file); }
    catch (error) { if (error.code === 'ENOENT') return { kind: 'missing' }; throw error; }
    if (!stat.isFile() && !stat.isSymbolicLink()) throw failure(`Select individual files, not directories: ${file}`);
    const data = stat.isSymbolicLink() ? Buffer.from(await fs.readlink(file)) : await fs.readFile(file);
    const after = await fs.lstat(file);
    if (stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) {
        throw failure('A selected file changed while it was being read. Refresh and try again.', 'SELECTED_GIT_STALE');
    }
    return { kind: stat.isSymbolicLink() ? 'symlink' : 'file', mode: stat.mode, size: stat.size,
        ino: stat.ino, mtime: stat.mtimeMs, ctime: stat.ctimeMs, digest: hash(data), data };
}

function stateToken(state) {
    const { data, ...metadata } = state;
    return metadata;
}

async function inspect({ gitPath, root, files }) {
    if (typeof gitPath !== 'string' || !gitPath || typeof root !== 'string' || !path.isAbsolute(root)) {
        throw failure('A Git executable and an absolute repository root are required.');
    }
    root = await fs.realpath(root);
    const context = { gitPath, root };
    const top = await git(context, ['rev-parse', '--show-toplevel']);
    if (await fs.realpath(top.stdout.toString().trim()) !== root) throw failure('The selected root is not the repository root.');
    const gitDir = (await git(context, ['rev-parse', '--absolute-git-dir'])).stdout.toString().trim();
    const indexValue = (await git(context, ['rev-parse', '--git-path', 'index'])).stdout.toString().trim();
    const indexPath = path.resolve(root, indexValue);
    for (const state of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
        if (await exists(path.join(gitDir, state))) throw failure('Finish the merge, rebase or cherry-pick before operating on selected files.');
    }
    const sparse = await git(context, ['config', '--bool', 'core.sparseCheckout'], { allowFailure: true });
    if (sparse.stdout.toString().trim() === 'true') throw failure('Selected-file operations are not supported in sparse checkouts.');
    const entries = (await git(context, ['ls-files', '--stage', '-z'])).stdout.toString().split('\0').filter(Boolean).map(record => {
        const match = /^(\d+) ([a-f0-9]+) ([0-3])\t([\s\S]*)$/.exec(record);
        if (!match) throw failure('The Git index contains an unsupported entry.');
        return { mode: match[1], oid: match[2], stage: match[3], file: match[4] };
    });
    if (entries.some(entry => entry.stage !== '0')) throw failure('Resolve all merge conflicts before operating on selected files.');
    if (!Array.isArray(files) || files.length === 0) throw failure('Select at least one file.');
    const selected = [];
    for (const file of files) {
        if (typeof file !== 'string' || !file || file.includes('\0')) throw failure('The selection contains an invalid file path.');
        const absolute = path.resolve(root, file);
        const relative = path.relative(root, absolute).split(path.sep).join('/');
        if (!relative || !inside(root, absolute) || relative.split('/').some(part => part.toLowerCase() === '.git')) {
            throw failure(`The selected path is outside the repository or targets Git metadata: ${file}`);
        }
        if (entries.some(entry => entry.mode === '160000' && (relative === entry.file || relative.startsWith(`${entry.file}/`)))) {
            throw failure(`Submodule files must be handled in their own repository: ${relative}`);
        }
        let parent = path.dirname(absolute);
        while (!(await exists(parent))) parent = path.dirname(parent);
        const realParent = await fs.realpath(parent);
        if (!inside(root, realParent) || realParent !== parent) throw failure(`Paths through symbolic-link directories are not supported: ${relative}`);
        const owner = (await git({ ...context, root: parent }, ['rev-parse', '--show-toplevel'])).stdout.toString().trim();
        if (await fs.realpath(owner) !== root) throw failure(`The selected file belongs to another repository: ${relative}`);
        const state = await fileState(absolute);
        if (state.kind === 'missing' && !entries.some(entry => entry.file === relative)) {
            // A staged deletion is no longer in the index, but remains tracked by HEAD.
            const tracked = await git(context, ['cat-file', '-e', `HEAD:${relative}`], { allowFailure: true });
            if (tracked.code !== 0) throw failure(`The selected file does not exist or is not tracked: ${relative}`);
        }
        if (!selected.includes(relative)) selected.push(relative);
    }
    selected.sort();
    const indexStat = await fs.lstat(indexPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (indexStat?.isSymbolicLink()) throw failure('Symbolic-link Git indexes are not supported.');
    const beforeHead = await head(context);
    const indexBytes = await readOptional(indexPath);
    const states = new Map();
    for (const file of selected) states.set(file, await fileState(path.join(root, file)));
    const afterHead = await head(context);
    if (JSON.stringify(beforeHead) !== JSON.stringify(afterHead) || hash(indexBytes || '') !== hash((await readOptional(indexPath)) || '')) {
        throw failure('The repository changed. Refresh and try again.', 'SELECTED_GIT_STALE');
    }
    const token = hash(JSON.stringify({ root, head: beforeHead, index: hash(indexBytes || ''),
        files: [...states].map(([file, state]) => [file, stateToken(state)]) }));
    return { ...context, gitDir, indexPath, indexBytes, indexMode: indexStat?.mode, files: selected, entries, states, head: beforeHead, token };
}

async function prepareSelection(options) {
    return (await inspect(options)).token;
}

async function mutate(options, operation) {
    const initial = await inspect(options);
    if (running.has(initial.root)) throw failure('Another selected-file operation is running in this repository.', 'SELECTED_GIT_BUSY');
    running.add(initial.root);
    const lockPath = `${initial.indexPath}.lock`;
    let lock;
    let ownedLock = false;
    let installed = false;
    const temporary = [];
    try {
        try { lock = await fs.open(lockPath, 'wx', initial.indexMode ? initial.indexMode & 0o777 : 0o600); ownedLock = true; }
        catch (error) {
            if (error.code === 'EEXIST') throw failure('The Git index is locked by another operation. Wait for it to finish.', 'SELECTED_GIT_BUSY');
            throw error;
        }
        const context = await inspect(options);
        if ((options.expected !== undefined && context.token !== options.expected) || initial.token !== context.token) {
            throw failure('The selected files or repository changed after confirmation. Refresh and try again.', 'SELECTED_GIT_STALE');
        }
        if (typeof options.message !== 'string' || !options.message.trim() || options.message.includes('\0')) throw failure('A non-empty message is required.');
        const makeIndex = async (fromOriginal = true, empty = false) => {
            const file = path.join(context.gitDir, `repolens-index-${randomUUID()}`);
            temporary.push(file);
            if (fromOriginal && context.indexBytes) await fs.writeFile(file, context.indexBytes, { flag: 'wx', mode: 0o600 });
            else await git(context, ['read-tree', empty ? '--empty' : context.head.oid || '--empty'], { index: file });
            return file;
        };
        const install = async index => {
            const bytes = await fs.readFile(index);
            await lock.writeFile(bytes);
            await lock.sync();
            await lock.close();
            lock = null;
            await fs.rename(lockPath, context.indexPath);
            installed = true;
        };
        return await operation(context, { makeIndex, install, message: options.message.trim() });
    }
    finally {
        if (lock) await lock.close();
        if (!installed && ownedLock) await fs.unlink(lockPath).catch(() => {});
        for (const index of temporary) {
            await fs.unlink(index).catch(() => {});
            await fs.unlink(`${index}.lock`).catch(() => {});
        }
        running.delete(initial.root);
    }
}

async function syncSelected(context, index) {
    await git(context, ['reset', '-q', 'HEAD', '--pathspec-from-file=-', '--pathspec-file-nul'], { index, input: nulPaths(context.files) });
}

async function commitSelected(options) {
    return mutate(options, async (context, { makeIndex, install, message }) => {
        const index = await makeIndex(Boolean(context.head.oid));
        // New files are added only to this disposable index. A failing hook leaves the real index intact.
        const existing = context.files.filter(file => context.states.get(file).kind !== 'missing');
        if (existing.length) await git(context, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { index, input: nulPaths(existing) });
        const args = ['commit', '-m', message];
        if (context.head.oid) args.push('--only', '--pathspec-from-file=-', '--pathspec-file-nul');
        await git(context, args, { index, input: context.head.oid ? nulPaths(context.files) : undefined });
        let commit;
        try {
            commit = (await head(context)).oid;
            if (!commit) throw failure('The new HEAD could not be read.');
            const resultIndex = await makeIndex();
            await syncSelected(context, resultIndex);
            await install(resultIndex);
        }
        catch (error) {
            const result = failure(`Commit${commit ? ` ${commit}` : ''} succeeded, but the selected-file index could not be synchronized: ${error.message}`, 'SELECTED_GIT_COMMITTED');
            if (commit) result.commit = commit;
            throw result;
        }
        return { commit, files: context.files };
    });
}

async function preserveRecovery(context, cause) {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'repolens-selected-recovery-'));
    const manifest = [];
    for (const [file, state] of context.states) {
        const backup = String(manifest.length);
        if (state.data) await fs.writeFile(path.join(folder, backup), state.data, { mode: 0o600 });
        manifest.push({ file, ...stateToken(state), ...(state.data ? { backup } : {}) });
    }
    await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify({ root: context.root, cause: cause.message, files: manifest }, null, 2));
    return folder;
}

async function stashSelected(options) {
    options = { ...options, message: typeof options.message === 'string' && options.message.trim()
        ? options.message : 'JetBrains-style Changes selected files' };
    return mutate(options, async (context, { makeIndex, install, message }) => {
        if (!context.head.oid) throw failure('Create an initial commit before stashing selected files.');
        const index = await makeIndex();
        const staged = (await git(context, ['diff', '--cached', '--name-only', '--no-renames', '--ita-visible-in-index', '-z', 'HEAD'], { index })).stdout
            .toString().split('\0').filter(Boolean);
        const unselected = staged.filter(file => !context.files.includes(file));
        if (unselected.length) await git(context, ['reset', '-q', 'HEAD', '--pathspec-from-file=-', '--pathspec-file-nul'], { index, input: nulPaths(unselected) });
        const headFiles = new Set((await git(context, ['ls-tree', '-r', '--name-only', '-z', 'HEAD'])).stdout.toString().split('\0').filter(Boolean));
        const tracked = context.files.filter(file => headFiles.has(file) || context.entries.some(entry => entry.file === file));
        const untracked = context.files.filter(file => !tracked.includes(file));
        const workingIndex = await makeIndex(false);
        // Seed staged additions so `add -A` also handles a selected newly-added file deleted again in the working tree.
        const additions = context.entries.filter(entry => context.files.includes(entry.file) && !headFiles.has(entry.file));
        if (additions.length) await git(context, ['update-index', '-z', '--index-info'], { index: workingIndex,
            input: Buffer.from(additions.map(entry => `${entry.mode} ${entry.oid} 0\t${entry.file}\0`).join('')) });
        if (tracked.length) await git(context, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], {
            index: workingIndex, input: nulPaths(tracked)
        });
        const indexTree = (await git(context, ['write-tree'], { index })).stdout.toString().trim();
        const workingTree = (await git(context, ['write-tree'], { index: workingIndex })).stdout.toString().trim();
        const headTree = (await git(context, ['rev-parse', 'HEAD^{tree}'])).stdout.toString().trim();
        if (!untracked.length && indexTree === headTree && workingTree === headTree) {
            throw failure('The selected files have no changes to stash.', 'SELECTED_GIT_NO_CHANGES');
        }
        const indexCommit = (await git(context, ['commit-tree', indexTree, '-p', context.head.oid, '-m', `index: ${message}`])).stdout.toString().trim();
        const parents = ['-p', context.head.oid, '-p', indexCommit];
        if (untracked.length) {
            const untrackedIndex = await makeIndex(false, true);
            await git(context, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { index: untrackedIndex, input: nulPaths(untracked) });
            const untrackedTree = (await git(context, ['write-tree'], { index: untrackedIndex })).stdout.toString().trim();
            const untrackedCommit = (await git(context, ['commit-tree', untrackedTree, '-m', `untracked: ${message}`])).stdout.toString().trim();
            parents.push('-p', untrackedCommit);
        }
        const label = `On ${context.head.branch.replace(/^refs\/heads\//, '') || context.head.oid.slice(0, 8)}: ${message}`;
        const stash = (await git(context, ['commit-tree', workingTree, ...parents, '-m', label])).stdout.toString().trim();
        // Recheck actual contents after Git's clean filters ran and before publishing or removing any working file.
        if ((await inspect(options)).token !== context.token) {
            throw failure('The selected files or repository changed. Refresh and try again.', 'SELECTED_GIT_STALE');
        }
        await git(context, ['stash', 'store', '-m', label, stash]);
        try {
            const checkout = context.files.filter(file => headFiles.has(file));
            const headIndex = await makeIndex(false);
            if (checkout.length) await git(context, ['checkout-index', '--force', '-z', '--stdin'], { index: headIndex, input: nulPaths(checkout) });
            for (const file of context.files.filter(file => !headFiles.has(file))) {
                await fs.unlink(path.join(context.root, file)).catch(error => { if (error.code !== 'ENOENT') throw error; });
            }
            const resultIndex = await makeIndex();
            await syncSelected(context, resultIndex);
            await install(resultIndex);
            return { stash, files: context.files };
        }
        catch (error) {
            let recovery;
            let recoveryFailure;
            try { recovery = await preserveRecovery(context, error); }
            catch (backupError) { recoveryFailure = backupError; }
            const recoveryDetail = recovery ? `Backups are preserved at ${recovery}.`
                : `Recovery backups could not be written: ${recoveryFailure.message}. Restore the saved stash to recover the selected files.`;
            const result = failure(`Stash ${stash} was saved, but selected-file cleanup could not finish. ${recoveryDetail} ${error.message}`, 'SELECTED_GIT_RECOVERY');
            result.stash = stash;
            if (recovery) result.recoveryPath = recovery;
            throw result;
        }
    });
}

module.exports = { prepareSelection, commitSelected, stashSelected };
