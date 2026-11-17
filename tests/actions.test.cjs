'use strict';

require('../src/i18n').setLanguage('zh-cn');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../src/actions.js'), 'utf8');

function uri(fsPath) {
    return { scheme: 'file', fsPath, toString() { return `file://${fsPath}`; } };
}

function fixture(options = {}) {
    const calls = { clean: [], revert: [], commands: [], warning: [], info: [], errors: [], diff: [], refresh: 0, wrappers: [] };
    const file = uri('/workspace/repo/file.go');
    const repositories = options.repositories || [{
        rootUri: uri('/workspace/repo'),
        state: { workingTreeChanges: [{ uri: file, status: 5 }], indexChanges: [], mergeChanges: [], untrackedChanges: [], submodules: [] }
    }];
    const api = {
        get repositories() {
            return repositories.map(entry => {
                const wrapper = {
                    rootUri: entry.rootUri,
                    get state() { return entry.state; },
                    async clean(paths) {
                        if (options.cleanError) throw new Error(options.cleanError);
                        calls.clean.push({ root: entry.rootUri.toString(), paths });
                    },
                    async revert(paths) {
                        if (options.revertError) throw new Error(options.revertError);
                        calls.revert.push({ root: entry.rootUri.toString(), paths });
                    }
                };
                calls.wrappers.push(wrapper);
                return wrapper;
            });
        }
    };
    const vscode = {
        commands: { async executeCommand(command, ...args) {
            if (options.commandError) throw new Error(options.commandError);
            calls.commands.push({ command, args });
        } },
        workspace: { getConfiguration() { return { get(key, fallback) { return options.trash ?? fallback; } }; } },
        window: {
            async showWarningMessage(message, details, action) {
                calls.warning.push({ message, details, action });
                if (options.onConfirm) return options.onConfirm({ repositories, action, calls });
                return options.cancel ? undefined : action;
            },
            async showInformationMessage(message) { calls.info.push(message); },
            async showErrorMessage(message) { calls.errors.push(message); }
        }
    };
    const changes = { diffCommand(vscodeArg, apiArg, repo, change, kind) {
        calls.diff.push({ vscode: vscodeArg, api: apiArg, repo, change, kind });
        return { command: 'vscode.diff', arguments: ['baseline', change.uri, kind] };
    } };
    const module = { exports: {} };
    new Function('require', 'module', 'exports', source)(name => name === './changes' ? changes : name === './i18n' ? require('../src/i18n') : require(name), module, module.exports);
    const actions = module.exports.createActions({
        vscode, getGit: () => options.noGit ? undefined : api,
        refresh: async () => { calls.refresh++; }
    });
    const node = { type: 'file', repoKey: repositories[0].rootUri.toString(), kind: 'working', uri: file, change: { status: 18 } };
    return { actions, calls, node, api, vscode, repositories, file };
}

test('discard uses live state, one absolute path, and stable roots across new Git API wrappers', async () => {
    const f = fixture();
    await f.actions.discard(f.node);
    assert.equal(f.calls.wrappers.length, 2);
    assert.notEqual(f.calls.wrappers[0], f.calls.wrappers[1]);
    assert.deepEqual(f.calls.clean, [{ root: f.node.repoKey, paths: [f.file.fsPath] }]);
    assert.equal(f.calls.refresh, 1);
    assert.match(f.calls.warning[0].details.detail, /暂存区版本.*已有的暂存更改会保留/);
    assert.equal(f.calls.warning[0].details.modal, true);
    assert.deepEqual(f.calls.errors, []);
});

test('cancel never cleans or refreshes', async () => {
    const f = fixture({ cancel: true });
    await f.actions.discard(f.node);
    assert.equal(f.calls.clean.length, 0);
    assert.equal(f.calls.refresh, 0);
});

test('invalid arguments, stale kinds, absent files and missing Git never broaden actions', async () => {
    for (const action of ['discard', 'unstage', 'openChange', 'openFile']) {
        for (const changeNode of [undefined, { type: undefined }, { type: 'repository' }, { repoKey: undefined }, { repoKey: 'file:///other' }, { uri: undefined }, { uri: uri('/elsewhere/file.go') }, { uri: uri('/workspace/repo/../other/file.go') }, { kind: 'index' }]) {
            const f = fixture();
            await f.actions[action](changeNode === undefined ? undefined : { ...f.node, ...changeNode });
            assert.equal(f.calls.clean.length + f.calls.revert.length + f.calls.commands.length, 0, `${action}: ${JSON.stringify(changeNode)}`);
            assert.equal(f.calls.info.length, 1);
        }
        const f = fixture({ noGit: true });
        await f.actions[action](f.node);
        assert.equal(f.calls.clean.length + f.calls.revert.length + f.calls.commands.length, 0);
    }
});

test('nested repository cannot be addressed through a stale parent repoKey', async () => {
    const file = uri('/workspace/repo/child/file.go');
    const repositories = [
        { rootUri: uri('/workspace/repo'), state: { workingTreeChanges: [{ uri: file, status: 5 }] } },
        { rootUri: uri('/workspace/repo/child'), state: { workingTreeChanges: [{ uri: file, status: 5 }] } }
    ];
    const f = fixture({ repositories });
    const node = { ...f.node, uri: file };
    await f.actions.discard(node);
    assert.equal(f.calls.clean.length, 0);
    await f.actions.discard({ ...node, repoKey: repositories[1].rootUri.toString() });
    assert.deepEqual(f.calls.clean, [{ root: repositories[1].rootUri.toString(), paths: [file.fsPath] }]);
});

test('file becoming conflict while confirmation is open stops discard', async () => {
    const f = fixture({ onConfirm({ repositories, action }) {
        repositories[0].state.mergeChanges = [{ uri: repositories[0].state.workingTreeChanges[0].uri, status: 16 }];
        return action;
    } });
    await f.actions.discard(f.node);
    assert.equal(f.calls.clean.length, 0);
    assert.equal(f.calls.info.length, 1);
});

test('removed file, changed status, and working file moved to index are rejected after confirmation', async () => {
    for (const after of ['missing', 'status', 'mutated-status', 'index']) {
        const f = fixture({ onConfirm({ repositories, action }) {
            const state = repositories[0].state;
            if (after === 'status') state.workingTreeChanges = [{ ...state.workingTreeChanges[0], status: 7 }];
            else if (after === 'mutated-status') state.workingTreeChanges[0].status = 11;
            else {
                if (after === 'index') state.indexChanges = [{ ...state.workingTreeChanges[0], status: 0 }];
                state.workingTreeChanges = [];
            }
            return action;
        } });
        await f.actions.discard(f.node);
        assert.equal(f.calls.clean.length, 0, after);
        assert.equal(f.calls.info.length, 1, after);
    }
});

test('discard does not follow a different repository or node mutated during confirmation', async () => {
    const f = fixture({ onConfirm({ repositories, action }) {
        repositories[0].rootUri = uri('/workspace/replacement');
        return action;
    } });
    await f.actions.discard(f.node);
    assert.equal(f.calls.clean.length, 0);
    const g = fixture({ onConfirm({ action }) {
        g.node.uri = uri('/workspace/repo/other.go');
        return action;
    } });
    await g.actions.discard(g.node);
    assert.deepEqual(g.calls.clean[0].paths, ['/workspace/repo/file.go']);
});

test('existing conflicts cannot be discarded or unstaged even if group or node.change claims otherwise', async () => {
    for (const status of [12, 13, 14, 15, 16, 17, 18]) {
        const f = fixture();
        f.repositories[0].state.mergeChanges = [{ uri: f.file, status }];
        f.repositories[0].state.indexChanges = [{ uri: f.file, status: 0 }];
        await f.actions.discard(f.node);
        await f.actions.unstage({ ...f.node, kind: 'index' });
        await f.actions.discard({ ...f.node, kind: 'conflict' });
        assert.equal(f.calls.clean.length + f.calls.revert.length + f.calls.warning.length, 0);
    }
});

test('only a real submodule at the exact file path blocks discard', async () => {
    const f = fixture();
    f.repositories[0].state.submodules = [{ path: 'file.go' }];
    await f.actions.discard(f.node);
    assert.equal(f.calls.clean.length, 0);
    assert.equal(f.calls.warning.length, 0);
    f.repositories[0].state.submodules = [{ path: 'other-submodule' }];
    await f.actions.discard(f.node);
    assert.equal(f.calls.clean.length, 1);
});

test('new submodule after confirmation blocks discard', async () => {
    const f = fixture({ onConfirm({ repositories, action }) {
        repositories[0].state.submodules = [{ path: 'file.go' }];
        return action;
    } });
    await f.actions.discard(f.node);
    assert.equal(f.calls.clean.length, 0);
});

test('untracked deletion explicitly describes Trash or permanent deletion', async () => {
    for (const trash of [true, false]) {
        const f = fixture({ trash });
        f.repositories[0].state.workingTreeChanges = [];
        f.repositories[0].state.untrackedChanges = [{ uri: f.file, status: 7 }];
        await f.actions.discard(f.node);
        assert.match(f.calls.warning[0].message, /删除未跟踪文件/);
        assert.match(f.calls.warning[0].details.detail, trash ? /移入系统废纸篓/ : /永久删除/);
        assert.equal(f.calls.clean.length, 1);
    }
});

test('tracked deletion confirmation describes restoring the file', async () => {
    const f = fixture();
    f.repositories[0].state.workingTreeChanges[0].status = 6;
    await f.actions.discard(f.node);
    assert.match(f.calls.warning[0].message, /恢复已删除的文件/);
    assert.equal(f.calls.warning[0].action, '恢复文件');
    assert.equal(f.calls.clean.length, 1);
});

test('index-only file offers unstage with one path; discard never cleans it', async () => {
    const f = fixture();
    f.repositories[0].state.indexChanges = [{ uri: f.file, status: 1 }];
    f.repositories[0].state.workingTreeChanges = [];
    await f.actions.discard({ ...f.node, kind: 'index' });
    await f.actions.discard(f.node);
    await f.actions.unstage({ ...f.node, kind: 'index' });
    assert.equal(f.calls.clean.length + f.calls.warning.length, 0);
    assert.deepEqual(f.calls.revert, [{ root: f.node.repoKey, paths: [f.file.fsPath] }]);
    assert.equal(f.calls.refresh, 1);
});

test('working and staged entries for one file remain independently actionable', async () => {
    const f = fixture();
    f.repositories[0].state.indexChanges = [{ uri: f.file, status: 0 }];
    await f.actions.discard(f.node);
    await f.actions.unstage({ ...f.node, kind: 'index' });
    assert.equal(f.calls.clean.length, 1);
    assert.equal(f.calls.revert.length, 1);
    assert.equal(f.repositories[0].state.indexChanges.length, 1, 'mock clean does not remove staged state');
});

test('openChange passes the live change and public Git API to diffCommand', async () => {
    const f = fixture();
    await f.actions.openChange(f.node);
    assert.equal(f.calls.diff[0].change, f.repositories[0].state.workingTreeChanges[0]);
    assert.equal(f.calls.diff[0].kind, 'working');
    assert.equal(f.calls.diff[0].api, f.api);
    assert.equal(f.calls.diff[0].vscode, f.vscode);
    assert.deepEqual(f.calls.commands, [{ command: 'vscode.diff', args: ['baseline', f.file, 'working'] }]);
});

test('conflict diff and openFile work without exposing discard or unstage', async () => {
    const f = fixture();
    f.repositories[0].state.workingTreeChanges = [];
    f.repositories[0].state.mergeChanges = [{ uri: f.file, status: 16 }];
    const node = { ...f.node, kind: 'conflict' };
    await f.actions.openChange(node);
    await f.actions.openFile(node);
    assert.equal(f.calls.diff[0].kind, 'conflict');
    assert.deepEqual(f.calls.commands[1], { command: 'vscode.open', args: [f.file] });
    assert.equal(f.calls.clean.length + f.calls.revert.length, 0);
});

test('Git and editor errors are reported and do not refresh after failed mutations', async () => {
    for (const [action, options, kind] of [
        ['discard', { cleanError: 'clean failed' }, 'working'],
        ['unstage', { revertError: 'revert failed' }, 'index'],
        ['openChange', { commandError: 'open failed' }, 'working'],
        ['openFile', { commandError: 'file failed' }, 'working']
    ]) {
        const f = fixture(options);
        f.repositories[0].state.indexChanges = [{ uri: f.file, status: 0 }];
        await f.actions[action]({ ...f.node, kind });
        assert.equal(f.calls.errors.length, 1, action);
        assert.equal(f.calls.refresh, 0, action);
        assert.match(f.calls.errors[0], /失败/);
    }
});
