'use strict';

const path = require('node:path');
const { t } = require('./i18n');

const list = value => Array.isArray(value) ? value : [];
const conflict = change => change.status >= 12 && change.status <= 18;
const keyOf = repo => repo.rootUri.toString();
const branchOf = repo => repo.state.HEAD?.name || repo.state.HEAD?.commit?.slice(0, 8) || t("No commits yet");
const allChanges = repo => ['mergeChanges', 'indexChanges', 'workingTreeChanges', 'untrackedChanges']
    .flatMap(name => list(repo.state[name]));
const hasConflict = repo => allChanges(repo).some(conflict);
const clean = repo => allChanges(repo).length === 0;

function changeSignature(changes) {
    return list(changes).map(change => JSON.stringify([
        change.uri.toString(), change.status, change.originalUri?.toString(), change.renameUri?.toString()
    ])).sort();
}

function snapshot(repo, all = false) {
    const state = repo.state;
    const head = state.HEAD;
    return JSON.stringify({
        repoKey: keyOf(repo),
        head: head ? [head.name, head.commit, head.type, head.remote] : null,
        rebase: Boolean(state.rebaseCommit),
        index: changeSignature(state.indexChanges),
        ...(all ? {
            working: changeSignature(state.workingTreeChanges),
            untracked: changeSignature(state.untrackedChanges),
            merge: changeSignature(state.mergeChanges)
        } : {})
    });
}

function createWorkflows({ vscode, getGit, refresh, getSelectedNodes, getNodeFiles,
    selectedGit = require('./selected-git') }) {
    const info = message => vscode.window.showInformationMessage(message);
    const stale = () => info(t("The repository or file changed. Refresh and try again."));
    const repositories = () => list(getGit()?.repositories);
    const findRepo = repoKey => repositories().find(repo => keyOf(repo) === repoKey);

    async function run(label, action) {
        try {
            return await action();
        }
        catch (error) {
            const selectedErrors = {
                SELECTED_GIT_STALE: 'The selected files or repository changed. Refresh and try again.',
                SELECTED_GIT_BUSY: 'Another Git operation is running. Wait for it to finish.',
                SELECTED_GIT_NO_CHANGES: 'The selected files have no changes to stash.',
                SELECTED_GIT_UNAVAILABLE: 'Git is unavailable. Check the editor Git executable setting.'
            };
            const explanation = selectedErrors[error?.code];
            const completed = error?.code === 'SELECTED_GIT_COMMITTED'
                ? t('Commit {0} succeeded, but Git staging could not be synchronized. Refresh the repository before continuing.\n{1}', error.commit || '', error.message)
                : error?.code === 'SELECTED_GIT_RECOVERY'
                    ? t('Stash {0} was saved, but file cleanup could not finish. Recovery backups: {1}\n{2}', error.stash || '', error.recoveryPath || t('See the Git error below'), error.message)
                    : undefined;
            await vscode.window.showErrorMessage(t('{0} failed: {1}', t(label),
                completed || (explanation ? t(explanation) : error?.message || String(error))));
            return undefined;
        }
    }

    async function progress(title, operation) {
        if (vscode.window.withProgress && vscode.ProgressLocation) {
            return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t(title), cancellable: false }, operation);
        }
        return operation();
    }

    function findFile(node, expectedKind, repos = repositories()) {
        if (node?.type !== 'file' || typeof node.repoKey !== 'string' ||
            !['working', 'index', 'conflict'].includes(node.kind) ||
            (expectedKind && node.kind !== expectedKind) || node.uri?.scheme !== 'file' ||
            typeof node.uri.fsPath !== 'string' || !path.isAbsolute(node.uri.fsPath)) {
            return undefined;
        }
        const candidates = repos.filter(repo => {
            if (repo.rootUri.scheme !== node.uri.scheme) return false;
            const relative = path.relative(repo.rootUri.fsPath, node.uri.fsPath);
            return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        }).sort((left, right) => right.rootUri.fsPath.length - left.rootUri.fsPath.length);
        const repo = candidates[0];
        if (!repo || keyOf(repo) !== node.repoKey) return undefined;
        const state = repo.state;
        const sameFile = change => change.uri.toString() === node.uri.toString();
        const conflicts = allChanges(repo).filter(change => sameFile(change) && conflict(change));
        if (node.kind !== 'conflict' && conflicts.length > 0) return undefined;
        const changes = node.kind === 'conflict' ? conflicts : node.kind === 'index'
            ? list(state.indexChanges) : [...list(state.workingTreeChanges), ...list(state.untrackedChanges)];
        const change = changes.find(change => sameFile(change) && (node.kind === 'conflict'
            ? conflict(change) : node.kind === 'index'
                ? [0, 1, 2, 3, 4].includes(change.status) : [5, 6, 7, 8, 9, 10, 11].includes(change.status)));
        if (!change) return undefined;
        const submodule = list(state.submodules).some(item =>
            typeof item.path === 'string' && path.resolve(repo.rootUri.fsPath, item.path) === change.uri.fsPath);
        return { repo, change, submodule };
    }

    async function selectedFiles(nodes, kind, method) {
        if (!Array.isArray(nodes) || nodes.length === 0) {
            return info(kind === 'index' ? t("Select files to unstage first.") : t("Select files to stage first."));
        }
        const repos = repositories();
        const groups = new Map();
        for (const node of nodes) {
            const target = findFile(node, kind, repos);
            if (!target || (kind === 'working' && target.submodule)) return stale();
            const repoKey = keyOf(target.repo);
            if (!groups.has(repoKey)) groups.set(repoKey, { repo: target.repo, paths: new Set() });
            groups.get(repoKey).paths.add(target.change.uri.fsPath);
        }
        // Validate the entire selection before performing any repository operation.
        for (const { repo, paths } of groups.values()) {
            if (paths.size > 0) await repo[method]([...paths]);
        }
        await refresh();
        return undefined;
    }

    async function stage(node) {
        return run("Stage file", () => selectedFiles(node === undefined
            ? list(getSelectedNodes()).filter(selected => selected?.kind === 'working') : [node], 'working', 'add'));
    }

    async function stageSelected() {
        return run("Stage selected files", () => selectedFiles(list(getSelectedNodes()).filter(node => node?.kind === 'working'), 'working', 'add'));
    }

    async function unstageSelected() {
        return run("Unstage selected files", () => selectedFiles(list(getSelectedNodes()).filter(node => node?.kind === 'index'), 'index', 'revert'));
    }

    async function chooseRepo(node, predicate, prompt) {
        if (node !== undefined) {
            if (node?.type === 'file') return findFile(node)?.repo;
            if (!['repo', 'group'].includes(node?.type) || typeof node.repoKey !== 'string') return undefined;
            return findRepo(node.repoKey);
        }
        const choices = repositories().filter(predicate).map(repo => ({
            label: path.basename(repo.rootUri.fsPath),
            description: branchOf(repo),
            detail: repo.rootUri.fsPath,
            repoKey: keyOf(repo)
        }));
        if (choices.length === 0) {
            await info(t("No repositories meet the requirements for this action."));
            return undefined;
        }
        const selected = await vscode.window.showQuickPick(choices, { placeHolder: prompt, ignoreFocusOut: true });
        return selected ? findRepo(selected.repoKey) : undefined;
    }

    async function syncRepo(repoKey) {
        const repo = findRepo(repoKey);
        if (!repo) return undefined;
        if (typeof repo.status === 'function') await repo.status();
        return findRepo(repoKey);
    }

    function canCommit(repo) {
        return repo && list(repo.state.indexChanges).length > 0 && !hasConflict(repo) && !repo.state.rebaseCommit;
    }

    async function commit(node) {
        return run("Commit staged files", async () => {
            const repo = await chooseRepo(node, repo => list(repo.state.indexChanges).length > 0, t("Select a repository to commit staged files"));
            if (!repo) return node === undefined ? undefined : stale();
            if (hasConflict(repo)) return info(t("This repository has merge conflicts. Resolve them first."));
            if (repo.state.rebaseCommit) return info(t("This repository is rebasing. Use the native Git commands to continue or complete the rebase."));
            if (!canCommit(repo)) return info(t("This repository has no staged files."));
            const before = snapshot(repo);
            const repoKey = keyOf(repo);
            const count = list(repo.state.indexChanges).length;
            const message = await vscode.window.showInputBox({
                title: t('Commit {0}', path.basename(repo.rootUri.fsPath)),
                prompt: t("Enter a commit message; only staged content in this repository will be committed"),
                ignoreFocusOut: true,
                validateInput: value => value.trim() ? undefined : t("The commit message cannot be empty.")
            });
            if (message === undefined) return undefined;
            if (!message.trim()) return info(t("The commit message cannot be empty."));
            const action = t("Commit staged content");
            const answer = await vscode.window.showWarningMessage(t('Commit the {0} staged file(s) in this repository?', count), {
                modal: true,
                detail: t('Repository: {0}\nBranch: {1}\n\nCommit message: {2}\n\nUnstaged content will not be included.', repo.rootUri.fsPath, branchOf(repo), message.trim())
            }, action);
            if (answer !== action) return undefined;
            const current = await syncRepo(repoKey);
            if (!canCommit(current) || snapshot(current) !== before) return stale();
            await current.commit(message.trim());
            await refresh();
            return undefined;
        });
    }

    async function createStash(node) {
        return run("Create Stash", async () => {
            const repo = await chooseRepo(node, repo => !clean(repo), t("Select a repository to create a Stash"));
            if (!repo) return node === undefined ? undefined : stale();
            if (hasConflict(repo)) return info(t("This repository has merge conflicts and cannot be stashed."));
            if (clean(repo)) return info(t("This repository has no local changes to stash."));
            const repoKey = keyOf(repo);
            const before = snapshot(repo, true);
            const include = await vscode.window.showQuickPick([
                { label: t("Tracked files only"), description: t("Include staged and unstaged content"), includeUntracked: false },
                { label: t("Include untracked files"), description: t("Also stash untracked files in this repository"), includeUntracked: true }
            ], { placeHolder: t("Choose what to include in the Stash"), ignoreFocusOut: true });
            if (!include) return undefined;
            const tracked = [...list(repo.state.indexChanges), ...list(repo.state.workingTreeChanges)]
                .some(change => ![7, 8].includes(change.status));
            if (!include.includeUntracked && !tracked) return info(t("This repository has no tracked local changes. Choose to include untracked files."));
            const action = t("Continue to create Stash");
            if (await vscode.window.showWarningMessage(t("Stash local changes in this repository?"), {
                modal: true,
                detail: t('Repository: {0}\nBranch: {1}\nScope: {2}, including staged and unstaged content.\n\nNext, enter an optional Stash description in the native Git prompt for this repository.', repo.rootUri.fsPath, branchOf(repo), t(include.includeUntracked ? 'Tracked and untracked files' : 'Tracked files only'))
            }, action) !== action) return undefined;
            const current = await syncRepo(repoKey);
            if (!current || hasConflict(current) || clean(current) || snapshot(current, true) !== before) return stale();
            await vscode.commands.executeCommand(include.includeUntracked ? 'git.stashIncludeUntracked' : 'git.stash', current.rootUri);
            await refresh();
            return undefined;
        });
    }

    async function applyStash(node) {
        return run("Apply Stash", async () => {
            const selected = await chooseRepo(node, repo => clean(repo), t("Select a repository to apply a Stash"));
            if (!selected) return node === undefined ? undefined : stale();
            const repoKey = keyOf(selected);
            const repo = await syncRepo(repoKey);
            if (!repo) return stale();
            if (!clean(repo)) return info(t("Commit or stash local changes in this repository before applying a Stash."));
            const before = snapshot(repo, true);
            const action = t("Choose Stash to apply");
            if (await vscode.window.showWarningMessage(t("Open the native Stash picker for this repository?"), {
                modal: true,
                detail: t('Repository: {0}\nBranch: {1}\n\nApply the selected Stash and keep its record.', repo.rootUri.fsPath, branchOf(repo))
            }, action) !== action) return undefined;
            const current = await syncRepo(repoKey);
            if (!current || !clean(current) || snapshot(current, true) !== before) return stale();
            await vscode.commands.executeCommand('git.stashApply', current.rootUri);
            await refresh();
            return undefined;
        });
    }

    async function selectedOperation(action, node) {
        return run(action === 'commit' ? 'Commit selected files' : 'Stash selected files', async () => {
            const nodes = node === undefined ? list(getSelectedNodes()) : list(getNodeFiles?.(node));
            if (!nodes.length) return info(t('Select files first.'));
            const repos = repositories();
            const groups = new Map();
            for (const file of nodes) {
                const target = findFile(file, undefined, repos);
                if (!target || file.kind === 'conflict' || target.submodule) return stale();
                const repoKey = keyOf(target.repo);
                if (!groups.has(repoKey)) groups.set(repoKey, { repo: target.repo, files: new Set(), nodes: [] });
                const group = groups.get(repoKey);
                group.nodes.push(file);
                group.files.add(target.change.uri.fsPath);
                const renames = allChanges(target.repo).filter(change => [3, 10].includes(change.status) &&
                    [change.uri, change.originalUri, change.renameUri].some(uri => uri?.toString() === file.uri.toString()));
                for (const change of renames) {
                    for (const uri of [change.uri, change.originalUri, change.renameUri].filter(Boolean)) {
                        const relative = path.relative(target.repo.rootUri.fsPath, uri.fsPath);
                        if (uri.scheme !== 'file' || !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return stale();
                        group.files.add(uri.fsPath);
                    }
                }
            }
            let group = [...groups.values()][0];
            if (groups.size > 1) {
                const choice = await vscode.window.showQuickPick([...groups].map(([repoKey, value]) => ({
                    label: path.basename(value.repo.rootUri.fsPath), description: branchOf(value.repo),
                    detail: t('{0} selected file(s) · {1}', new Set(value.nodes.map(file => file.uri.toString())).size, value.repo.rootUri.fsPath), repoKey
                })), { title: t('Choose one repository'), placeHolder: t('Only selected files in this repository will be processed. Other repositories stay unchanged.') });
                if (!choice) return;
                group = groups.get(choice.repoKey);
            }
            if (!group) return;
            const repoKey = keyOf(group.repo);
            const repo = await syncRepo(repoKey);
            if (!repo || group.nodes.some(file => !findFile(file))) return stale();
            // A status refresh can change rename metadata without changing the
            // visible URI. Never carry an obsolete rename source into a write.
            const freshPaths = new Set();
            for (const file of group.nodes) {
                const target = findFile(file);
                if (!target || target.submodule) return stale();
                freshPaths.add(target.change.uri.fsPath);
                for (const change of allChanges(target.repo).filter(change => [3, 10].includes(change.status) &&
                    [change.uri, change.originalUri, change.renameUri].some(uri => uri?.toString() === file.uri.toString()))) {
                    for (const uri of [change.uri, change.originalUri, change.renameUri].filter(Boolean)) freshPaths.add(uri.fsPath);
                }
            }
            if (freshPaths.size !== group.files.size || [...freshPaths].some(file => !group.files.has(file))) return stale();
            if (hasConflict(repo)) return info(t('This repository has merge conflicts. Resolve them first.'));
            if (repo.state.rebaseCommit || repo.state.mergeInProgress) return info(t('Finish the current Git operation with native Git commands first.'));
            const files = [...group.files].sort();
            const dirty = list(vscode.workspace?.textDocuments).filter(document => document.isDirty &&
                document.uri?.scheme === 'file' && files.includes(document.uri.fsPath));
            if (dirty.length) return info(t('Save the selected files before committing or stashing them.'));
            const options = { gitPath: getGit()?.git?.path || 'git', root: repo.rootUri.fsPath, files };
            const expected = await progress('Checking selected files…', () => selectedGit.prepareSelection(options));
            const before = snapshot(repo, true);
            const message = await vscode.window.showInputBox({
                title: t(action === 'commit' ? 'Commit Selected Files' : 'Stash Selected Files'),
                prompt: t(action === 'commit' ? 'Enter a commit message for the selected files' : 'Enter an optional Stash description'),
                ignoreFocusOut: true,
                ...(action === 'commit' ? { validateInput: value => value.trim() ? undefined : t('The commit message cannot be empty.') } : {})
            });
            if (message === undefined) return;
            if (action === 'commit' && !message.trim()) return info(t('The commit message cannot be empty.'));
            const label = t(action === 'commit' ? 'Commit selected file contents' : 'Stash selected file contents');
            const detail = t('Repository: {0}\nBranch: {1}\n\nFiles:\n{2}\n\n{3}', repo.rootUri.fsPath, branchOf(repo),
                files.map(file => path.relative(repo.rootUri.fsPath, file)).join('\n'),
                t(action === 'commit'
                    ? 'Commit the current complete working-tree contents of these files, including their unstaged edits. Other files and their staged content are kept.'
                    : 'Stash only these files, including their staged, unstaged and untracked content. Other files and their staged content are kept.'));
            const answer = await vscode.window.showWarningMessage(t(action === 'commit' ? 'Commit these selected files?' : 'Stash these selected files?'), { modal: true, detail }, label);
            if (answer !== label) return;
            const current = await syncRepo(repoKey);
            if (!current || snapshot(current, true) !== before || group.nodes.some(file => !findFile(file))) return stale();
            if (list(vscode.workspace?.textDocuments).some(document => document.isDirty && files.includes(document.uri?.fsPath))) {
                return info(t('Save the selected files before committing or stashing them.'));
            }
            const operation = action === 'commit' ? selectedGit.commitSelected : selectedGit.stashSelected;
            await progress(action === 'commit' ? 'Committing selected files…' : 'Stashing selected files…', () =>
                operation({ ...options, message: message.trim() || (action === 'stash' ? t('Selected files') : ''), expected }));
            await current.status?.();
            await refresh();
            await info(t(action === 'commit' ? 'Selected files committed.' : 'Selected files stashed.'));
        });
    }

    return { stage, stageSelected, unstageSelected, commit, createStash, applyStash,
        commitSelected: node => selectedOperation('commit', node),
        stashSelected: node => selectedOperation('stash', node) };
}

module.exports = { createWorkflows };
