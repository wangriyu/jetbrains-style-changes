'use strict';

require('../src/i18n').setLanguage('zh-cn');

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkflows } = require('../src/workflows');

const uri = fsPath => ({ scheme: 'file', fsPath, toString() { return `file://${fsPath}`; } });
const change = (file, status) => ({ uri: uri(file), status });

function fixture(options = {}) {
    const root = '/workspace/repo';
    const repositories = options.repositories || [{
        rootUri: uri(root),
        state: { HEAD: { name: 'feature/work', commit: 'abcdef1234', type: 0 },
            workingTreeChanges: [change(`${root}/a.go`, 5)], indexChanges: [change(`${root}/staged.go`, 0)],
            untrackedChanges: [], mergeChanges: [], submodules: [] }
    }];
    const calls = { add: [], revert: [], commit: [], commands: [], refresh: 0, status: 0, info: [], errors: [], warnings: [], picks: [], inputs: [] };
    const api = { get repositories() { return repositories.map(entry => ({
        rootUri: entry.rootUri, get state() { return entry.state; },
        async add(paths) { if (options.fail === 'add') throw new Error('add failure'); calls.add.push({ repoKey: entry.rootUri.toString(), paths }); },
        async revert(paths) { calls.revert.push({ repoKey: entry.rootUri.toString(), paths }); },
        async commit(message, ...args) { if (options.fail === 'commit') throw new Error('commit failure'); calls.commit.push({ repoKey: entry.rootUri.toString(), message, args }); },
        async status() { calls.status++; if (options.onStatus) options.onStatus(repositories, calls); }
    })); } };
    let selection = [];
    const vscode = {
        commands: { async executeCommand(command, ...args) {
            if (options.fail === 'command') throw new Error('command failure');
            calls.commands.push({ command, args });
        } },
        window: {
            async showQuickPick(items, details) {
                calls.picks.push({ items, details });
                if (options.pick) return options.pick(items, calls.picks.length, repositories);
                return options.cancel === 'pick' ? undefined : items[0];
            },
            async showInputBox(details) {
                calls.inputs.push(details);
                if (options.input) return options.input(repositories);
                return options.cancel === 'input' ? undefined : options.message ?? 'commit staged files';
            },
            async showWarningMessage(message, details, action) {
                calls.warnings.push({ message, details, action });
                if (options.confirm) return options.confirm(repositories, action, calls);
                return options.cancel === 'confirm' ? undefined : action;
            },
            async showInformationMessage(message) { calls.info.push(message); },
            async showErrorMessage(message) { calls.errors.push(message); }
        }
    };
    const workflows = createWorkflows({ vscode, getGit: () => options.noGit ? undefined : api,
        refresh: async () => { calls.refresh++; }, getSelectedNodes: () => selection });
    const node = (name = 'a.go', kind = 'working', entry = repositories[0]) => ({
        type: 'file', repoKey: entry.rootUri.toString(), kind, uri: uri(`${entry.rootUri.fsPath}/${name}`), change: { status: 18 }
    });
    const repoNode = { type: 'repo', repoKey: repositories[0].rootUri.toString() };
    return { workflows, calls, repositories, node, repoNode, select(nodes) { selection = nodes; } };
}

test('empty stage arguments never invoke add([]) or stage a whole repository', async () => {
    const f = fixture();
    await f.workflows.stage();
    await f.workflows.stageSelected();
    await f.workflows.stage(f.repoNode);
    await f.workflows.unstageSelected();
    assert.equal(f.calls.add.length + f.calls.revert.length, 0);
    assert.equal(f.calls.info.length, 4);
});

test('stage ignores cached node.change and deduplicates explicit selected paths', async () => {
    const f = fixture();
    f.select([f.node(), f.node()]);
    await f.workflows.stageSelected();
    assert.deepEqual(f.calls.add, [{ repoKey: f.repoNode.repoKey, paths: ['/workspace/repo/a.go'] }]);
    assert.equal(f.calls.refresh, 1);
    assert.equal(f.calls.commit.length, 0);
});

test('all selected files validate before any multi-repository stage', async () => {
    const other = { rootUri: uri('/workspace/other'), state: { workingTreeChanges: [change('/workspace/other/b.go', 5)] } };
    const f = fixture();
    f.repositories.push(other);
    f.select([f.node(), f.node('missing.go', 'working', other)]);
    await f.workflows.stageSelected();
    assert.equal(f.calls.add.length, 0);
    f.select([f.node(), f.node('b.go', 'working', other)]);
    await f.workflows.stageSelected();
    assert.deepEqual(f.calls.add.map(call => call.paths), [['/workspace/repo/a.go'], ['/workspace/other/b.go']]);
});

test('nested repo keys, conflicts, stale kinds and true submodules cannot stage', async () => {
    const f = fixture();
    const child = { rootUri: uri('/workspace/repo/child'), state: { workingTreeChanges: [change('/workspace/repo/child/a.go', 5)] } };
    f.repositories.push(child);
    await f.workflows.stage({ ...f.node(), uri: uri('/workspace/repo/child/a.go') });
    f.repositories[0].state.mergeChanges = [change('/workspace/repo/a.go', 16)];
    await f.workflows.stage(f.node());
    f.repositories[0].state.mergeChanges = [];
    f.repositories[0].state.submodules = [{ path: 'a.go' }];
    await f.workflows.stage(f.node());
    await f.workflows.stage(f.node('staged.go', 'index'));
    assert.equal(f.calls.add.length, 0);
});

test('selected unstage sends only index paths to revert and preserves working files', async () => {
    const f = fixture();
    f.select([f.node('staged.go', 'index')]);
    await f.workflows.unstageSelected();
    assert.deepEqual(f.calls.revert, [{ repoKey: f.repoNode.repoKey, paths: ['/workspace/repo/staged.go'] }]);
    assert.equal(f.repositories[0].state.workingTreeChanges.length, 1);
    f.select([f.node('staged.go', 'index'), f.node('missing.go', 'index')]);
    await f.workflows.unstageSelected();
    assert.equal(f.calls.revert.length, 1);
});

test('mixed parent checkbox selection stages only working entries and unstages only index entries', async () => {
    const f = fixture();
    f.select([f.node(), f.node('staged.go', 'index'), f.node('conflict.go', 'conflict')]);
    await f.workflows.stageSelected();
    await f.workflows.unstageSelected();
    assert.deepEqual(f.calls.add, [{ repoKey: f.repoNode.repoKey, paths: ['/workspace/repo/a.go'] }]);
    assert.deepEqual(f.calls.revert, [{ repoKey: f.repoNode.repoKey, paths: ['/workspace/repo/staged.go'] }]);
    assert.equal(f.calls.info.length, 0);
    await f.workflows.stage();
    assert.deepEqual(f.calls.add[1].paths, ['/workspace/repo/a.go']);
    await f.workflows.stage(f.node('staged.go', 'index'));
    assert.equal(f.calls.add.length, 2, 'single-file stage remains strict');
});

test('selection with no applicable kind explains the action and performs no Git operation', async () => {
    const f = fixture();
    f.select([f.node('staged.go', 'index'), f.node('conflict.go', 'conflict')]);
    await f.workflows.stageSelected();
    f.select([f.node(), f.node('conflict.go', 'conflict')]);
    await f.workflows.unstageSelected();
    assert.equal(f.calls.add.length + f.calls.revert.length, 0);
    assert.equal(f.calls.info.length, 2);
});

test('commit uses one chosen repo, exact staged content and no all/amend/push options', async () => {
    const f = fixture();
    await f.workflows.commit(f.repoNode);
    assert.deepEqual(f.calls.commit, [{ repoKey: f.repoNode.repoKey, message: 'commit staged files', args: [] }]);
    assert.equal(f.calls.add.length + f.calls.commands.length, 0);
    assert.equal(f.calls.status, 1);
    assert.match(f.calls.warnings[0].details.detail, /feature\/work/);
    assert.match(f.calls.warnings[0].message, /1 个文件/);
    assert.match(f.calls.warnings[0].details.detail, /未暂存的内容不会被包含/);
});

test('commit with no node picks only repositories with staged files', async () => {
    const f = fixture();
    f.repositories.unshift({ rootUri: uri('/workspace/clean'), state: { indexChanges: [], workingTreeChanges: [] } });
    await f.workflows.commit();
    assert.equal(f.calls.picks[0].items.length, 1);
    assert.equal(f.calls.commit[0].repoKey, 'file:///workspace/repo');
});

test('commit cancels at repository choice, message or confirmation without mutations', async () => {
    for (const cancel of ['pick', 'input', 'confirm']) {
        const f = fixture({ cancel });
        await f.workflows.commit(cancel === 'pick' ? undefined : f.repoNode);
        assert.equal(f.calls.commit.length + f.calls.add.length, 0, cancel);
    }
    const f = fixture({ message: '   ' });
    await f.workflows.commit(f.repoNode);
    assert.equal(f.calls.commit.length, 0);
});

test('commit rejects staged path/status and HEAD changes, conflicts and rebase after prompting', async () => {
    for (const race of ['path', 'status', 'head', 'conflict', 'rebase']) {
        const f = fixture({ confirm(repositories, action) {
            const state = repositories[0].state;
            if (race === 'path') state.indexChanges.push(change('/workspace/repo/new.go', 1));
            if (race === 'status') state.indexChanges[0].status = 2;
            if (race === 'head') state.HEAD.commit = 'changed';
            if (race === 'conflict') state.mergeChanges.push(change('/workspace/repo/conflict.go', 18));
            if (race === 'rebase') state.rebaseCommit = { hash: 'abcdef' };
            return action;
        } });
        await f.workflows.commit(f.repoNode);
        assert.equal(f.calls.commit.length, 0, race);
        assert.equal(f.calls.info.length, 1, race);
    }
});

test('commit rechecks state after explicit Git status refresh', async () => {
    const f = fixture({ onStatus(repositories) { repositories[0].state.indexChanges = []; } });
    await f.workflows.commit(f.repoNode);
    assert.equal(f.calls.commit.length, 0);
});

test('commit rejects existing conflicts/rebase and stale repo or file arguments', async () => {
    for (const mode of ['conflict', 'rebase', 'missing', 'stale-file']) {
        const f = fixture();
        if (mode === 'conflict') f.repositories[0].state.mergeChanges.push(change('/workspace/repo/a.go', 16));
        if (mode === 'rebase') f.repositories[0].state.rebaseCommit = {};
        await f.workflows.commit(mode === 'missing' ? { type: 'repo', repoKey: 'file:///missing' }
            : mode === 'stale-file' ? f.node('missing.go') : f.repoNode);
        assert.equal(f.calls.commit.length + f.calls.inputs.length, 0, mode);
    }
});

test('createStash locks explicit repository URI and delegates description to native Git', async () => {
    for (const includeUntracked of [false, true]) {
        const f = fixture({ pick(items) { return items.find(item => item.includeUntracked === includeUntracked); } });
        await f.workflows.createStash(f.repoNode);
        assert.equal(f.calls.inputs.length, 0);
        assert.deepEqual(f.calls.commands.map(call => ({ command: call.command, roots: call.args.map(value => value.toString()) })), [{
            command: includeUntracked ? 'git.stashIncludeUntracked' : 'git.stash', roots: [f.repoNode.repoKey]
        }]);
        assert.match(f.calls.warnings[0].details.detail, /此仓库的原生 Git/);
        assert.match(f.calls.warnings[0].details.detail, /暂存和未暂存/);
    }
});

test('createStash cancels scope or confirmation and blocks changed/conflicted targets', async () => {
    for (const cancel of ['pick', 'confirm']) {
        const f = fixture({ cancel });
        await f.workflows.createStash(f.repoNode);
        assert.equal(f.calls.commands.length, 0);
    }
    for (const race of ['removed', 'changed', 'conflict']) {
        const f = fixture({ confirm(repositories, action) {
            if (race === 'removed') repositories.splice(0);
            if (race === 'changed') repositories[0].state.workingTreeChanges.push(change('/workspace/repo/new.go', 7));
            if (race === 'conflict') repositories[0].state.mergeChanges.push(change('/workspace/repo/a.go', 16));
            return action;
        } });
        await f.workflows.createStash(f.repoNode);
        assert.equal(f.calls.commands.length, 0, race);
    }
});

test('tracked-only stash does not act on an untracked-only repository', async () => {
    const f = fixture();
    f.repositories[0].state.indexChanges = [];
    f.repositories[0].state.workingTreeChanges = [change('/workspace/repo/new.go', 7)];
    await f.workflows.createStash(f.repoNode);
    assert.equal(f.calls.commands.length + f.calls.warnings.length, 0);
});

test('applyStash refreshes clean state, opens only native apply picker and retains stash', async () => {
    const f = fixture();
    f.repositories[0].state.workingTreeChanges = [];
    f.repositories[0].state.indexChanges = [];
    await f.workflows.applyStash(f.repoNode);
    assert.equal(f.calls.status, 2);
    assert.deepEqual(f.calls.commands.map(call => [call.command, ...call.args.map(value => value.toString())]), [['git.stashApply', f.repoNode.repoKey]]);
    assert.match(f.calls.warnings[0].details.detail, /应用并保留 Stash/);
    assert.equal(f.calls.refresh, 1);
});

test('applyStash refuses dirty repos before and after confirmation', async () => {
    const f = fixture();
    await f.workflows.applyStash(f.repoNode);
    assert.equal(f.calls.commands.length + f.calls.warnings.length, 0);
    const g = fixture({ confirm(repositories, action) {
        repositories[0].state.untrackedChanges.push(change('/workspace/repo/new.go', 7));
        return action;
    } });
    g.repositories[0].state.workingTreeChanges = [];
    g.repositories[0].state.indexChanges = [];
    await g.workflows.applyStash(g.repoNode);
    assert.equal(g.calls.commands.length, 0);
});

test('applyStash cancel and changed HEAD never open a native picker', async () => {
    for (const race of ['cancel', 'head']) {
        const f = fixture({ confirm(repositories, action) {
            if (race === 'head') repositories[0].state.HEAD.name = 'other';
            return race === 'cancel' ? undefined : action;
        } });
        f.repositories[0].state.workingTreeChanges = [];
        f.repositories[0].state.indexChanges = [];
        await f.workflows.applyStash(f.repoNode);
        assert.equal(f.calls.commands.length, 0, race);
    }
});

test('errors surface without falling back to another repository or operation', async () => {
    for (const fail of ['add', 'commit', 'command']) {
        const f = fixture({ fail });
        if (fail === 'add') await f.workflows.stage(f.node());
        else if (fail === 'commit') await f.workflows.commit(f.repoNode);
        else await f.workflows.createStash(f.repoNode);
        assert.equal(f.calls.errors.length, 1, fail);
        assert.equal(f.calls.refresh, 0, fail);
    }
});
