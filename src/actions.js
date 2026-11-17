'use strict';

const path = require('node:path');
const { t } = require('./i18n');

const INDEX_STATUSES = new Set([0, 1, 2, 3, 4]);
const WORKING_STATUSES = new Set([5, 6, 7, 8, 9, 10, 11]);
const isConflict = change => change.status >= 12 && change.status <= 18;
const asArray = value => Array.isArray(value) ? value : [];

function createActions({ vscode, getGit, refresh }) {
    const unavailable = () => vscode.window.showInformationMessage(t("The file changed or this action is unavailable. Refresh and try again."));

    function findLive(node) {
        if (node?.type !== 'file' || typeof node.repoKey !== 'string' ||
            !['working', 'index', 'conflict'].includes(node.kind) ||
            node.uri?.scheme !== 'file' || typeof node.uri.fsPath !== 'string' ||
            !path.isAbsolute(node.uri.fsPath) || typeof node.uri.toString !== 'function') {
            return undefined;
        }
        const api = getGit();
        if (!api) {
            return undefined;
        }
        const candidates = asArray(api.repositories).filter(repo => {
            if (!repo.rootUri || repo.rootUri.scheme !== node.uri.scheme) {
                return false;
            }
            const relative = path.relative(repo.rootUri.fsPath, node.uri.fsPath);
            return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        }).sort((left, right) => right.rootUri.fsPath.length - left.rootUri.fsPath.length);
        const repo = candidates[0];
        if (!repo || repo.rootUri.toString() !== node.repoKey) {
            return undefined;
        }
        const state = repo.state;
        const working = [...asArray(state.workingTreeChanges), ...asArray(state.untrackedChanges)];
        const index = asArray(state.indexChanges);
        const merge = asArray(state.mergeChanges);
        const sameFile = change => change.uri.toString() === node.uri.toString();
        const conflicts = [...merge, ...working, ...index].filter(change => sameFile(change) && isConflict(change));
        const changes = node.kind === 'conflict' ? conflicts : node.kind === 'index' ? index : working;
        if (node.kind !== 'conflict' && conflicts.length > 0) {
            return undefined;
        }
        const change = changes.find(change => sameFile(change) && (node.kind === 'conflict'
            ? isConflict(change)
            : (node.kind === 'index' ? INDEX_STATUSES : WORKING_STATUSES).has(change.status)));
        if (!change) {
            return undefined;
        }
        const submodule = asArray(state.submodules).some(item =>
            typeof item.path === 'string' && path.resolve(repo.rootUri.fsPath, item.path) === node.uri.fsPath);
        return { api, repo, repoKey: repo.rootUri.toString(), uri: change.uri, change, kind: node.kind, submodule };
    }

    async function run(label, action) {
        try {
            return await action();
        }
        catch (error) {
            await vscode.window.showErrorMessage(t('{0} failed: {1}', t(label), error?.message || String(error)));
            return undefined;
        }
    }

    const category = change => [7, 8].includes(change.status) ? 'untracked' : change.status === 6 ? 'deleted' : 'tracked';

    async function openChange(node) {
        return run("Open diff", async () => {
            const target = findLive(node);
            if (!target) {
                return unavailable();
            }
            const command = require('./changes').diffCommand(vscode, target.api, target.repo, target.change, target.kind);
            if (!command?.command) {
                return unavailable();
            }
            return vscode.commands.executeCommand(command.command, ...(command.arguments || []));
        });
    }

    async function openFile(node) {
        return run("Open file", async () => {
            const target = findLive(node);
            if (!target) {
                return unavailable();
            }
            return vscode.commands.executeCommand('vscode.open', target.uri);
        });
    }

    async function discard(node) {
        return run("Discard changes", async () => {
            const target = findLive(node);
            if (!target || target.kind !== 'working' || target.submodule) {
                return unavailable();
            }
            const before = category(target.change);
            const beforeStatus = target.change.status;
            const name = path.basename(target.uri.fsPath);
            const relative = path.relative(target.repo.rootUri.fsPath, target.uri.fsPath);
            const trash = vscode.workspace.getConfiguration('git', target.uri).get('discardUntrackedChangesToTrash', true);
            const action = before === 'untracked' ? t("Delete file") : before === 'deleted' ? t("Restore file") : t("Discard changes");
            const message = before === 'untracked' ? t('Delete the untracked file “{0}”?', name)
                : before === 'deleted' ? t('Restore the deleted file “{0}”?', name) : t('Discard unstaged changes in “{0}”?', name);
            const detail = `${path.basename(target.repo.rootUri.fsPath)} / ${relative}\n\n${before === 'untracked'
                ? trash ? t("The file will be moved to the system Trash.") : t("The file will be permanently deleted.")
                : t("The file will be restored to the index version; existing staged changes will be kept.")}`;
            if (await vscode.window.showWarningMessage(message, { modal: true, detail }, action) !== action) {
                return undefined;
            }
            const current = findLive({ type: 'file', repoKey: target.repoKey, kind: 'working', uri: target.uri });
            if (!current || current.submodule || current.repoKey !== target.repoKey ||
                current.change.status !== beforeStatus || category(current.change) !== before) {
                return unavailable();
            }
            await current.repo.clean([current.uri.fsPath]);
            await refresh();
            return undefined;
        });
    }

    async function unstage(node) {
        return run("Unstage", async () => {
            const target = findLive(node);
            if (!target || target.kind !== 'index') {
                return unavailable();
            }
            await target.repo.revert([target.uri.fsPath]);
            await refresh();
            return undefined;
        });
    }

    return { openChange, openFile, discard, unstage };
}

module.exports = { createActions };
